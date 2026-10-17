#!/usr/bin/env bash

# Ставит зависимости сборки с пятью попытками: обрыв сети не требует нового запуска установщика.
# Одинаково используется при отсутствующих пакетах и при восстановлении неполной установки.
cockpit_install_b24_dependencies() {
  local root=$1
  local pause=$2
  local attempt

  for attempt in 1 2 3 4 5; do
    if NODE_ENV=development npm --prefix "$root/b24" ci --include=dev --no-audit --no-fund; then
      return 0
    fi

    if (( attempt == 5 )); then
      echo "✗ Не удалось установить зависимости сборки b24." >&2
      return 1
    fi

    sleep "$pause"
  done
}

# Собирает файл, при необходимости восстанавливает зависимости и затем обновляет ссылку.
# После неудачной сборки npm ci выполняется только если его ещё не было в этом вызове.
# Отказ сборки возвращает 1 до mkdir и ln;
# чужой обычный файл в PATH не трогается и даёт 2 — сборка при этом прошла.
cockpit_install_b24_cli() {
  local root=${1:?корень cockpit обязателен}
  local link_dir=${2:?каталог ссылок обязателен}
  local target="$root/bin/b24"
  local pause=${COCKPIT_B24_INSTALL_PAUSE:-10}
  local temporary
  local ci_ran=0

  if [[ ! -d "$root/b24/node_modules/esbuild" || ! -d "$root/b24/node_modules/postject" ]]; then
    cockpit_install_b24_dependencies "$root" "$pause" || return 1
    ci_ran=1
  fi

  if ! npm --prefix "$root/b24" run build; then
    if (( ci_ran )); then
      echo "✗ Не удалось собрать b24." >&2
      return 1
    fi

    echo "⚠ Сборка b24 не удалась; переустанавливаю зависимости и повторяю сборку." >&2
    cockpit_install_b24_dependencies "$root" "$pause" || return 1

    if ! npm --prefix "$root/b24" run build; then
      echo "✗ Не удалось собрать b24." >&2
      return 1
    fi
  fi

  if [[ ! -f "$target" || ! -x "$target" ]]; then
    echo "✗ Сборка b24 не создала исполняемый файл $target." >&2
    return 1
  fi

  mkdir -p "$link_dir" || return 1

  if [[ -e "$link_dir/b24" && ! -L "$link_dir/b24" ]]; then
    echo "⚠ Файл $link_dir/b24 не перезаписан: это чужая команда или каталог." >&2
    return 2
  fi

  temporary="$link_dir/.b24-link-$$"

  if ! ln -s "$target" "$temporary" || ! mv -Tf "$temporary" "$link_dir/b24"; then
    rm -f -- "$temporary"
    echo "✗ Не удалось обновить ссылку $link_dir/b24." >&2
    return 1
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  cockpit_install_b24_cli "$@"
  exit $?
fi
