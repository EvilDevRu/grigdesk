#!/usr/bin/env bash
# Ярлык «Кокпит»: файл .desktop на рабочем столе и в меню приложений, оба ведут в bin/launch.
# Одна реализация на два входа: вопрос установщика (deploy/install.sh) и кнопка
# «Настройки → Сервер» (через сервер кокпита).
#
#   deploy/shortcut.sh install   создать или обновить оба файла
#   deploy/shortcut.sh remove    убрать оба
#   deploy/shortcut.sh status    состояние строками «ключ<TAB>значение» — их читает сервер
#
# Ярлык запоминает каталог node на момент создания (переменная COCKPIT_NODE_DIR в Exec):
# сессия рабочего стола не знает nvm, а bin/launch без node не прочитает порт из .env.
set -euo pipefail

COCKPIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="cockpit.desktop"
APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}"
LAUNCHER="$COCKPIT_DIR/bin/launch"
ICON="$COCKPIT_DIR/web/public/icon-512.png"

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

write_entry() {
  local file=$1
  local node_dir
  node_dir="$(dirname "$(command -v node)")"
  cat > "$file" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Кокпит
Name[en]=Cockpit
Comment=Открыть кокпит в браузере; спящий сервер поднимется сам
Comment[en]=Open the cockpit in a browser; a stopped server is started first
Exec=/usr/bin/env $(desktop_quote "COCKPIT_NODE_DIR=$node_dir") $(desktop_quote "$LAUNCHER")
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

install_shortcut() {
  local dir
  if ! dir="$(desktop_dir)"; then
    echo "каталог рабочего стола не найден — ярлык некуда класть" >&2
    return 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "node не найден в PATH — ярлык не сможет прочитать настройки запуска" >&2
    return 1
  fi
  [ -x "$LAUNCHER" ] || chmod 755 "$LAUNCHER"

  mkdir -p "$APPS_DIR"
  write_entry "$APPS_DIR/$NAME"
  write_entry "$dir/$NAME"
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

case "${1:-}" in
  install) install_shortcut ;;
  remove) remove_shortcut ;;
  status) status ;;
  *)
    echo "использование: deploy/shortcut.sh install|remove|status" >&2
    exit 2
    ;;
esac
