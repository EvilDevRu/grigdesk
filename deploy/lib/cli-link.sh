#!/usr/bin/env bash

# Ссылка в пользовательском PATH обновляется при смене копии GrigDesk.
# Чужой обычный файл или каталог сохраняется с предупреждением вместо перезаписи.
# Прежняя ссылка grigdesk убирается, только если ведёт в bin/ этой копии.
# После переименования команды она ведёт в несуществующий файл.
grigdesk_link_cli() {
  local grigdesk_root=${1:?корень grigdesk обязателен}
  local target_bin=${2:?каталог bin обязателен}
  local link_file="$target_bin/grigdesk-ctl"
  local executable="$grigdesk_root/bin/utilities/ctl"
  local legacy

  mkdir -p "$target_bin" || return 1

  if [[ -e "$link_file" && ! -L "$link_file" ]]; then
    echo "⚠ Файл $link_file не перезаписан: это чужая команда или каталог." >&2
    return 1
  fi

  if [[ -f "$grigdesk_root/release.json" ]]; then
    executable="$grigdesk_root/bin/grigdesk-ctl"
  fi
  ln -sfn "$executable" "$link_file" || return 1

  for legacy in grigdesk; do
    case "$(readlink -- "$target_bin/$legacy" 2>/dev/null)" in
      "$grigdesk_root/bin/grigdesk")
        rm -f -- "$target_bin/$legacy"
        ;;
    esac
  done
}
