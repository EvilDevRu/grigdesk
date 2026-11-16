#!/usr/bin/env bash

# Ставит зависимости сборки с пятью попытками: обрыв сети не требует нового запуска установщика.
# Одинаково используется при отсутствующих пакетах и при восстановлении неполной установки.
grigdesk_install_agent_dependencies() {
  local root=$1
  local package=$2
  local pause=$3
  local attempt

  for attempt in 1 2 3 4 5; do
    if NODE_ENV=development npm --prefix "$root/$package" ci --include=dev --no-audit --no-fund; then
      return 0
    fi

    if (( attempt == 5 )); then
      echo "✗ Не удалось установить зависимости сборки $package." >&2
      return 1
    fi

    sleep "$pause"
  done
}

# Собирает файл, при необходимости восстанавливает зависимости и затем обновляет ссылку.
# После неудачной сборки npm ci выполняется только если его ещё не было в этом вызове.
# Отказ сборки возвращает 1 до mkdir и ln;
# чужой обычный файл в PATH не трогается и даёт 2 — сборка при этом прошла.
grigdesk_install_agent_cli() {
  local root=${1:?корень grigdesk обязателен}
  local link_dir=${2:?каталог ссылок обязателен}
  local program=$3
  local build_script=build
  local package=tracker
  local target="$root/bin/$program"

  case "$program" in
    tracker) ;;
    pipeline) build_script=build:pipeline ;;
    routes) package=routes ;;
    *)
      echo 'Неизвестная утилита агента.' >&2
      return 2
      ;;
  esac
  local pause=${GRIGDESK_B24_INSTALL_PAUSE:-10}
  local temporary
  local ci_ran=0

  if [[ -f "$root/release.json" ]]; then
    # Проверенный комплект уже содержит CLI: запись в R и инструменты сборки не нужны.
    # Ни при повреждении, ни при чужом файле fallback на исходники не выполняется.
    if [[ ! -f "$target" || ! -x "$target" ]]; then
      echo "✗ Повреждён комплект: нет готового $program $target." >&2
      return 1
    fi
  else
    if [[ ! -d "$root/$package/node_modules/esbuild" || ! -d "$root/$package/node_modules/postject" ]]; then
      grigdesk_install_agent_dependencies "$root" "$package" "$pause" || return 1
      ci_ran=1
    fi

    if ! npm --prefix "$root/$package" run "$build_script"; then
      if (( ci_ran )); then
        echo "✗ Не удалось собрать $program." >&2
        return 1
      fi

      echo "⚠ Сборка $program не удалась; переустанавливаю зависимости и повторяю сборку." >&2
      grigdesk_install_agent_dependencies "$root" "$package" "$pause" || return 1

      if ! npm --prefix "$root/$package" run "$build_script"; then
        echo "✗ Не удалось собрать $program." >&2
        return 1
      fi
    fi

  fi

  if [[ ! -f "$target" || ! -x "$target" ]]; then
    echo "✗ Сборка $program не создала исполняемый файл $target." >&2
    return 1
  fi

  mkdir -p "$link_dir" || return 1

  if [[ -e "$link_dir/$program" && ! -L "$link_dir/$program" ]]; then
    echo "⚠ Файл $link_dir/$program не перезаписан: это чужая команда или каталог." >&2
    return 2
  fi

  temporary="$link_dir/.$program-link-$$"

  if ! ln -s "$target" "$temporary" || ! mv -Tf "$temporary" "$link_dir/$program"; then
    rm -f -- "$temporary"
    echo "✗ Не удалось обновить ссылку $link_dir/$program." >&2
    return 1
  fi
}

