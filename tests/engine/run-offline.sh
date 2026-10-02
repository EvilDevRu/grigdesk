#!/usr/bin/env bash
set -uo pipefail

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FACTORY_HOME="$PROJECT_ROOT/engine"
FACTORY_TESTS_HOME="$PROJECT_ROOT/tests/engine"
HOST_NODE_BIN=$(command -v node 2>/dev/null || true)

# Режим воркера: скрипт запускает сам себя по одному файлу на процесс. Изоляция
# та же, что была у последовательного прогона (свой TEST_ROOT + `env -i`), поэтому
# файлы не видят друг друга и порядок между ними ничего не значит.
if [[ "${1:-}" == "--one" ]]; then
  test_file=${2:?test file}
  test_root=$(mktemp -d /tmp/factory-offline.XXXXXX) || exit 1
  out_buf=$(mktemp /tmp/factory-offline-out.XXXXXX) || exit 1
  cleanup_worker() {
    case "$test_root" in /tmp/factory-offline.*) rm -rf -- "$test_root" ;; esac
    rm -f -- "$out_buf"
  }
  trap cleanup_worker EXIT INT TERM
  mkdir -p "$test_root/config" "$test_root/state" "$test_root/xdg-config" \
    "$test_root/xdg-state" "$test_root/xdg-cache" "$test_root/work" \
    "$test_root/profiles"
  env -i \
    PATH="$FACTORY_TESTS_HOME/fakes/bin:/usr/bin:/bin" \
    LC_ALL=C \
    FACTORY_HOME="$FACTORY_HOME" \
    FACTORY_PROFILES_DIR="$test_root/profiles" \
    FACTORY_TESTS_HOME="$FACTORY_TESTS_HOME" \
    FACTORY_TESTING=1 \
    FACTORY_FORBID_LIVE=1 \
    TEST_REPEAT="${TEST_REPEAT:-5}" \
    FACTORY_CONFIG_ROOT="$test_root/config" \
    FACTORY_STATE="$test_root/state" \
    STATE_DIR="$test_root/state" \
    XDG_CONFIG_HOME="$test_root/xdg-config" \
    XDG_STATE_HOME="$test_root/xdg-state" \
    XDG_CACHE_HOME="$test_root/xdg-cache" \
    TEST_ROOT="$test_root" \
    NODE_BIN="$HOST_NODE_BIN" \
    COCKPIT_PROVIDER_PREFS_PATH="$test_root/provider-prefs.json" \
    COCKPIT_DEEPSEEK_RUNTIME_MODE=installed \
    bash --noprofile --norc "$test_file" >"$out_buf" 2>&1
  test_rc=$?
  # Вывод файла печатается одним куском под общим flock: иначе строки соседних
  # прогонов перемешались бы и TAP стал бы нечитаемым.
  {
    flock 9
    printf '── %s\n' "${test_file#"$PROJECT_ROOT/"}"
    cat -- "$out_buf"
  } 9>"${OFFLINE_OUT_LOCK:?}"
  exit "$test_rc"
fi

TEST_FILTER="${1:-}"

mapfile -t TEST_FILES < <(
  find "$FACTORY_TESTS_HOME/characterization" \
       "$FACTORY_TESTS_HOME/unit" \
       "$FACTORY_TESTS_HOME/contract" \
       "$FACTORY_TESTS_HOME/integration" \
       "$FACTORY_TESTS_HOME/race" \
       -maxdepth 1 -type f -name '*.sh' 2>/dev/null | sort
)

if [[ -n "$TEST_FILTER" ]]; then
  mapfile -t TEST_FILES < <(printf '%s\n' "${TEST_FILES[@]}" | grep "$TEST_FILTER" || true)
fi

if [[ ${#TEST_FILES[@]} -eq 0 ]]; then
  echo "нет offline-тестов${TEST_FILTER:+ по фильтру $TEST_FILTER}" >&2
  exit 2
fi

# Файлы независимы, а самый долгий из них держал всю очередь: последовательный
# прогон стоил столько же, сколько сумма всех, при простое остальных ядер.
JOBS=${TEST_JOBS:-$(nproc 2>/dev/null || echo 4)}
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || JOBS=1

OFFLINE_OUT_LOCK=$(mktemp /tmp/factory-offline-lock.XXXXXX) || exit 1
export OFFLINE_OUT_LOCK
cleanup_lock() { rm -f -- "$OFFLINE_OUT_LOCK"; }
trap cleanup_lock EXIT INT TERM

printf '%s\0' "${TEST_FILES[@]}" |
  xargs -0 -n1 -P "$JOBS" bash "$SELF" --one
xargs_rc=$?

# xargs отдаёт 123, если хоть один тест вышел ненулевым, и свои коды на прочих
# сбоях. Наружу отдаём единый признак «suite упал», как и раньше.
[[ "$xargs_rc" -eq 0 ]] || exit 1
exit 0
