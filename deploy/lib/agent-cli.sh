#!/usr/bin/env bash

# Build scope не зависит от PATH утилиты. Готовая поставка принимает
# только уже собранный файл той же установки.
grigdesk_install_agent_cli() {
  local root
  root="$(cd -- "${1:?корень grigdesk обязателен}" && pwd -P)" || return 1
  local link_dir=${2:?каталог ссылок обязателен}
  local program=$3
  local target="$root/bin/$program"
  local temporary

  case "$program" in
    tracker|pipeline|routes) ;;
    *) printf '%s\n' 'Неизвестная утилита агента.' >&2; return 2 ;;
  esac

  if [[ ! -f "$root/release.json" ]]; then
    target="$root/bin/utilities/$program"
    if ! grigdesk_agent_cli_ready "$target" "$program"; then
      bash "$root/tools/build-go-utilities.sh" "$root/bin/utilities" || return 1
    fi
  fi

  if ! grigdesk_agent_cli_ready "$target" "$program"; then
    echo "✗ Сборка $program не создала исполняемый файл $target." >&2
    return 1
  fi

  mkdir -p "$link_dir" || return 1

  if [[ -e "$link_dir/$program" && ! -L "$link_dir/$program" ]]; then
    echo "⚠ Файл $link_dir/$program не перезаписан: это чужая команда или каталог." >&2
    return 2
  fi

  temporary="$link_dir/.$program-link-$$"

  if ! ln -s "$target" "$temporary"; then
    return 1
  fi
  local move=(-Tf)
  if [[ "$(uname -s)" == Darwin ]]; then
    move=(-fh)
  fi
  if ! mv "${move[@]}" "$temporary" "$link_dir/$program"; then
    rm -f -- "$temporary"
    echo "✗ Не удалось обновить ссылку $link_dir/$program." >&2
    return 1
  fi
}

# Проверяет метаданные нужной команды до публикации ссылки.
grigdesk_agent_cli_ready() {
  local target=$1 program=$2 info

  [[ -f "$target" && ! -L "$target" && -x "$target" ]] || return 1
  info="$("$target" --runtime-info --json 2>/dev/null)" || return 1
  [[ "$info" == *"\"kind\":\"$program\""* && "$info" == *'"runtime":"go"'* ]]
}
