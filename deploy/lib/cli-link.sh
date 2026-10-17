#!/usr/bin/env bash

# Ссылка в пользовательском PATH обновляется при смене копии Кокпита.
# Чужой обычный файл или каталог сохраняется с предупреждением вместо перезаписи.
cockpit_link_cli() {
  local cockpit_root=${1:?корень cockpit обязателен}
  local target_bin=${2:?каталог bin обязателен}
  local link_file="$target_bin/cockpit"

  mkdir -p "$target_bin" || return 1

  if [[ -e "$link_file" && ! -L "$link_file" ]]; then
    echo "⚠ Файл $link_file не перезаписан: это чужая команда или каталог." >&2
    return 1
  fi

  ln -sfn "$cockpit_root/bin/cockpit" "$link_file"
}
