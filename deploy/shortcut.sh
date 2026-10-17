#!/usr/bin/env bash
# Ярлык «Кокпит»: файл .desktop на рабочем столе и в меню приложений. Оба ведут прямо в
# установленное окно (AppImage с runtime.json), а до его установки — в этот скрипт с open.
# Одна реализация на два входа: вопрос установщика (deploy/install.sh) и кнопка
# «Настройки → Сервер» (через сервер кокпита).
#
#   deploy/shortcut.sh install   создать или обновить оба файла
#   deploy/shortcut.sh remove    убрать оба
#   deploy/shortcut.sh status    состояние строками «ключ<TAB>значение» — их читает сервер
#   deploy/shortcut.sh open      щелчок по ярлыку до установки окна: cockpit open
#
# Переходный ярлык запоминает каталог node на момент создания (COCKPIT_NODE_DIR в Exec):
# сессия рабочего стола не знает nvm, а единая команда без node не запустится.
set -euo pipefail

COCKPIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$COCKPIT_DIR/deploy/lib/desktop-app.sh"
NAME="cockpit.desktop"
APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}"
LAUNCHER="$COCKPIT_DIR/deploy/shortcut.sh"
ICON="$COCKPIT_DIR/bin/cockpit.png"

# Каталог рабочего стола: xdg-user-dir, иначе его же конфиг, иначе классический Desktop.
# Пустой ответ и «сам $HOME» (так xdg-user-dir отвечает без настроенного каталога) —
# не рабочий стол.
desktop_dir() {
  local dir=""
  if command -v xdg-user-dir >/dev/null 2>&1; then
    dir="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
  elif [ -f "$CONFIG_DIR/user-dirs.dirs" ]; then
    dir="$(sed -n 's/^XDG_DESKTOP_DIR="\(.*\)"$/\1/p' "$CONFIG_DIR/user-dirs.dirs" | tail -n 1)"
    dir="${dir/\$HOME/$HOME}"
  fi
  [ -n "$dir" ] || dir="$HOME/Desktop"
  [ "$dir" != "$HOME" ] || return 1
  [ -d "$dir" ] || return 1
  printf '%s\n' "$dir"
}

# Аргумент Exec по правилам Desktop Entry: кавычки, а внутри них \ " $ ` экранированы —
# сначала как строка (\ → \\), затем как аргумент (ещё одним \).
desktop_quote() {
  local s=$1
  s=${s//\\/\\\\\\\\}
  s=${s//\"/\\\\\"}
  s=${s//\$/\\\\\$}
  s=${s//\`/\\\\\`}
  printf '"%s"' "$s"
}

# Новое окно установлено, если есть исполняемый AppImage и его runtime.json: такое окно само
# поднимает сервер, поэтому ярлыку не нужны ни переходный open, ни Node в PATH.
window_installed() {
  local app

  app="$(cockpit_desktop_app_path)"

  [ -f "$app" ] && [ -x "$app" ] && [ -f "$(cockpit_desktop_runtime_path)" ]
}

# Строка Exec: прямо в установленное окно либо, в переходном режиме, в этот скрипт с open и
# каталогом node на момент создания. Аргументы — в кавычках Desktop Entry.
entry_exec() {
  local node_dir

  if window_installed; then
    desktop_quote "$(cockpit_desktop_app_path)"
    return 0
  fi

  node_dir="$(dirname "$(command -v node)")"
  printf '/usr/bin/env %s %s open' \
    "$(desktop_quote "COCKPIT_NODE_DIR=$node_dir")" "$(desktop_quote "$LAUNCHER")"
}

# Файл ярлыка целиком переписывается одной записью: меню и рабочий стол всегда одинаковы.
# Exec вычисляется вызывающим один раз на установку.
write_entry() {
  local file=$1
  local exec_line=$2
  cat > "$file" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Кокпит
Name[en]=Cockpit
Comment=Открыть кокпит; спящий сервер поднимется сам
Comment[en]=Open the cockpit; a stopped server is started first
Exec=$exec_line
Icon=$ICON
Terminal=false
Categories=Development;
Keywords=cockpit;кокпит;
StartupNotify=false
EOF
  chmod 755 "$file"
}

status() {
  local dir
  dir="$(desktop_dir 2>/dev/null || true)"
  printf 'desktop_dir\t%s\n' "$dir"
  printf 'desktop\t%s\n' "$([ -n "$dir" ] && [ -f "$dir/$NAME" ] && echo 1 || echo 0)"
  printf 'menu\t%s\n' "$([ -f "$APPS_DIR/$NAME" ] && echo 1 || echo 0)"
}

# Ставит оба файла ярлыка с одной строкой Exec. Node в PATH нужен только переходному
# ярлыку (open); ярлык на установленное окно создаётся и без него.
install_shortcut() {
  local dir
  local exec_line
  if ! dir="$(desktop_dir)"; then
    echo "каталог рабочего стола не найден — ярлык некуда класть" >&2
    return 1
  fi
  if ! window_installed && ! command -v node >/dev/null 2>&1; then
    echo "node не найден в PATH — ярлык не сможет прочитать настройки запуска" >&2
    return 1
  fi
  [ -x "$LAUNCHER" ] || chmod 755 "$LAUNCHER"
  exec_line="$(entry_exec)"

  mkdir -p "$APPS_DIR"
  write_entry "$APPS_DIR/$NAME" "$exec_line"
  write_entry "$dir/$NAME" "$exec_line"
  # GNOME пускает ярлык с рабочего стола двойным щелчком только помеченным доверенным;
  # без gio (другая среда) остаётся исполняемый бит.
  if command -v gio >/dev/null 2>&1; then
    gio set "$dir/$NAME" metadata::trusted true >/dev/null 2>&1 || true
  fi
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
  fi
  echo "ярлык «Кокпит»: $dir/$NAME и меню приложений"
}

remove_shortcut() {
  local dir
  dir="$(desktop_dir 2>/dev/null || true)"
  rm -f "$APPS_DIR/$NAME"
  [ -n "$dir" ] && rm -f "$dir/$NAME"
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
  fi
  echo "ярлык «Кокпит» убран"
}

# Уведомление остаётся best-effort, если графическая сессия его не поддерживает.
# Причина также печатается, чтобы shell-запуск ярлыка можно было проверить.
notify() {
  if command -v notify-send >/dev/null 2>&1; then
    notify-send --app-name=Кокпит "Кокпит" "$1" >/dev/null 2>&1 || true
  fi

  echo "$1"
}

# Щелчок по переходному ярлыку: окно открывает единая команда, запуск службы она запрашивает
# сама. Каталог Node из Exec ставится первым в PATH — графическая сессия его обычно не знает.
# Терминала у ярлыка нет, поэтому отказ показывается уведомлением с причиной из stderr.
open_cockpit() {
  local problem

  if [ -n "${COCKPIT_NODE_DIR:-}" ] && [ -x "$COCKPIT_NODE_DIR/node" ]; then
    export PATH="$COCKPIT_NODE_DIR:$PATH"
  fi

  if ! problem="$("$COCKPIT_DIR/bin/cockpit" open 2>&1 >/dev/null)"; then
    notify "${problem:-Кокпит не запустился.}"
    return 1
  fi
}

case "${1:-}" in
  install) install_shortcut ;;
  remove) remove_shortcut ;;
  status) status ;;
  open) open_cockpit ;;
  *)
    echo "использование: deploy/shortcut.sh install|remove|status|open" >&2
    exit 2
    ;;
esac
