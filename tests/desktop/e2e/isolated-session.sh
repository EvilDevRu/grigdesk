#!/usr/bin/env bash
# Одноразовая D-Bus/Keyring/Xvfb сессия: cleanup затрагивает только собственные PID и каталоги.
set -uo pipefail

if [[ ${1:-} == --inside ]]; then
  shift
  desktop_keyring_pid=''
  desktop_command_pid=''

  # Внутренняя оболочка дожидается команды и демона до завершения своей сессии.
  # Сигнал сохраняет исходный код и не затрагивает процессы вне собственного запуска.
  cleanup_inside() {
    local original=$?
    trap - EXIT INT TERM

    if [[ -n $desktop_command_pid ]]; then
      kill -TERM "$desktop_command_pid" 2>/dev/null || true
      wait "$desktop_command_pid" 2>/dev/null || true
    fi

    if [[ -n $desktop_keyring_pid ]]; then
      kill -TERM "$desktop_keyring_pid" 2>/dev/null || true
      wait "$desktop_keyring_pid" 2>/dev/null || true
    fi

    exit "$original"
  }

  trap cleanup_inside EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  gnome-keyring-daemon --foreground --unlock --components=secrets \
    > "$XDG_RUNTIME_DIR/keyring.log" 2>&1 <<< 'desktop-test-only' &
  desktop_keyring_pid=$!
  printf 'KEYRING_PID=%s\n' "$desktop_keyring_pid"
  desktop_keyring_ready=0

  for ((desktop_attempt = 0; desktop_attempt < 50; desktop_attempt++)); do
    if ! kill -0 "$desktop_keyring_pid" 2>/dev/null; then
      break
    fi

    desktop_keyring_owner=$(gdbus call --session --dest org.freedesktop.DBus \
      --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.NameHasOwner \
      org.freedesktop.secrets 2>/dev/null)

    if [[ $desktop_keyring_owner == *true* ]] && \
      gdbus introspect --session --dest org.freedesktop.secrets \
      --object-path /org/freedesktop/secrets >/dev/null 2>&1; then
      desktop_keyring_ready=1
      break
    fi

    sleep 0.1
  done

  if (( ! desktop_keyring_ready )); then
    echo 'Одноразовая связка ключей не готова.' >&2
    exit 1
  fi

  xvfb-run -a "$@" &
  desktop_command_pid=$!
  wait "$desktop_command_pid"
  desktop_command_rc=$?
  desktop_command_pid=''
  exit "$desktop_command_rc"
fi

if (( $# == 0 )); then
  echo 'использование: isolated-session.sh <команда…>' >&2
  exit 2
fi

for desktop_dependency in dbus-run-session gnome-keyring-daemon gdbus setsid xvfb-run; do
  if ! command -v "$desktop_dependency" >/dev/null 2>&1; then
    echo "Недоступна зависимость: $desktop_dependency" >&2
    exit 1
  fi
done

desktop_test_home=$(mktemp -d /tmp/cockpit-desktop-home-XXXXXX) || exit 1
desktop_test_runtime=$(mktemp -d /tmp/cdr-XXXXXX) || {
  rm -rf -- "$desktop_test_home"
  exit 1
}
desktop_session_pid=''
desktop_signal=0

# Ждёт, пока в собственной группе сессии не останется процессов, не дольше 10 с.
# Службы, запущенные D-Bus по запросу (portal с FUSE-точкой, gvfs), не дети оболочки:
# wait их не дожидается, а после TERM они ещё снимают монтирование и пишут в runtime.
wait_session_group() {
  local attempt

  for ((attempt = 0; attempt < 100; attempt++)); do
    if ! kill -0 -- "-$desktop_session_pid" 2>/dev/null; then
      return 0
    fi

    sleep 0.1
  done

  return 1
}

# Внешняя оболочка завершает только сохранённую группу своей D-Bus сессии.
# Каталоги удаляются, когда в группе не осталось процессов, способных дописать данные.
cleanup_outside() {
  local original=$?
  trap - EXIT INT TERM

  if [[ -n $desktop_session_pid ]]; then
    kill -TERM -- "-$desktop_session_pid" 2>/dev/null || true
    wait "$desktop_session_pid" 2>/dev/null || true

    # Группа ещё существует, значит её номер не переиспользован: KILL уходит только своим.
    if ! wait_session_group; then
      kill -KILL -- "-$desktop_session_pid" 2>/dev/null || true

      if ! wait_session_group && (( original == 0 )); then
        original=1
      fi
    fi
  fi

  if ! rm -rf -- "$desktop_test_home" "$desktop_test_runtime"; then
    if (( original == 0 )); then
      original=1
    fi
  fi

  exit "$original"
}

trap cleanup_outside EXIT
trap 'desktop_signal=130; kill -INT -- "-$desktop_session_pid" 2>/dev/null || true' INT
trap 'desktop_signal=143; kill -TERM -- "-$desktop_session_pid" 2>/dev/null || true' TERM
chmod 700 "$desktop_test_home" "$desktop_test_runtime" || exit 1
printf 'SESSION_HOME=%s\nSESSION_RUNTIME=%s\n' "$desktop_test_home" "$desktop_test_runtime"

# Временный HOME прячет общий кэш браузеров Playwright, и чистый Chromium в E2E не находится.
# Путь к кэшу вычисляется до подмены HOME: браузеры только читаются, профили остаются временными.
desktop_browsers=${PLAYWRIGHT_BROWSERS_PATH:-${XDG_CACHE_HOME:-$HOME/.cache}/ms-playwright}

setsid env HOME="$desktop_test_home" XDG_DATA_HOME="$desktop_test_home/data" \
  XDG_CONFIG_HOME="$desktop_test_home/config" XDG_CACHE_HOME="$desktop_test_home/cache" \
  XDG_RUNTIME_DIR="$desktop_test_runtime" GSETTINGS_BACKEND=memory NO_AT_BRIDGE=1 \
  PLAYWRIGHT_BROWSERS_PATH="$desktop_browsers" \
  dbus-run-session -- bash "$0" --inside "$@" &
desktop_session_pid=$!
printf 'SESSION_PID=%s\n' "$desktop_session_pid"
wait "$desktop_session_pid"
desktop_session_rc=$?

if (( desktop_signal )); then
  wait "$desktop_session_pid" 2>/dev/null || true
  exit "$desktop_signal"
fi

exit "$desktop_session_rc"
