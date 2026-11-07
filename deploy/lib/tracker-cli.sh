#!/usr/bin/env bash

# Ставит зависимости сборки с пятью попытками: обрыв сети не требует нового запуска установщика.
# Одинаково используется при отсутствующих пакетах и при восстановлении неполной установки.
grigdesk_install_tracker_dependencies() {
  local root=$1
  local pause=$2
  local attempt

  for attempt in 1 2 3 4 5; do
    if NODE_ENV=development npm --prefix "$root/tracker" ci --include=dev --no-audit --no-fund; then
      return 0
    fi

    if (( attempt == 5 )); then
      echo "✗ Не удалось установить зависимости сборки tracker." >&2
      return 1
    fi

    sleep "$pause"
  done
}

# Собирает файл, при необходимости восстанавливает зависимости и затем обновляет ссылку.
# После неудачной сборки npm ci выполняется только если его ещё не было в этом вызове.
# Отказ сборки возвращает 1 до mkdir и ln;
# чужой обычный файл в PATH не трогается и даёт 2 — сборка при этом прошла.
grigdesk_install_tracker_cli() {
  local root=${1:?корень grigdesk обязателен}
  local link_dir=${2:?каталог ссылок обязателен}
  local target="$root/bin/tracker"
  local pause=${GRIGDESK_B24_INSTALL_PAUSE:-10}
  local temporary
  local ci_ran=0

  if [[ -f "$root/release.json" ]]; then
    # Проверенный комплект уже содержит CLI: запись в R и инструменты сборки не нужны.
    # Ни при повреждении, ни при чужом файле fallback на исходники не выполняется.
    if [[ ! -f "$target" || ! -x "$target" ]]; then
      echo "✗ Повреждён комплект: нет готового tracker $target." >&2
      return 1
    fi
  else
    if [[ ! -d "$root/tracker/node_modules/esbuild" || ! -d "$root/tracker/node_modules/postject" ]]; then
      grigdesk_install_tracker_dependencies "$root" "$pause" || return 1
      ci_ran=1
    fi

    if ! npm --prefix "$root/tracker" run build; then
      if (( ci_ran )); then
        echo "✗ Не удалось собрать tracker." >&2
        return 1
      fi

      echo "⚠ Сборка tracker не удалась; переустанавливаю зависимости и повторяю сборку." >&2
      grigdesk_install_tracker_dependencies "$root" "$pause" || return 1

      if ! npm --prefix "$root/tracker" run build; then
        echo "✗ Не удалось собрать tracker." >&2
        return 1
      fi
    fi

  fi

  if [[ ! -f "$target" || ! -x "$target" ]]; then
    echo "✗ Сборка tracker не создала исполняемый файл $target." >&2
    return 1
  fi

  mkdir -p "$link_dir" || return 1

  if [[ -e "$link_dir/tracker" && ! -L "$link_dir/tracker" ]]; then
    echo "⚠ Файл $link_dir/tracker не перезаписан: это чужая команда или каталог." >&2
    return 2
  fi

  temporary="$link_dir/.tracker-link-$$"

  if ! ln -s "$target" "$temporary" || ! mv -Tf "$temporary" "$link_dir/tracker"; then
    rm -f -- "$temporary"
    echo "✗ Не удалось обновить ссылку $link_dir/tracker." >&2
    return 1
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  grigdesk_install_tracker_cli "$@"
  exit $?
fi
