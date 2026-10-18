#!/usr/bin/env bash

# Ссылка в пользовательском PATH обновляется при смене копии GrigDesk.
# Чужой обычный файл или каталог сохраняется с предупреждением вместо перезаписи.
# Прежние имена команды (grigdesk и имя до переименования продукта) убираются, только если это
# ссылки в bin/ этой же копии: после переименования команды они ведут в несуществующий файл.
grigdesk_link_cli() {
  local grigdesk_root=${1:?корень grigdesk обязателен}
  local target_bin=${2:?каталог bin обязателен}
  local link_file="$target_bin/grigdesk-ctl"
  # Равно LEGACY.cliLink из shared/runtime/legacyBrand.ts; сверяется тестом.
  local legacy_cli='cockpit'
  local legacy

  mkdir -p "$target_bin" || return 1

  if [[ -e "$link_file" && ! -L "$link_file" ]]; then
    echo "⚠ Файл $link_file не перезаписан: это чужая команда или каталог." >&2
    return 1
  fi

  ln -sfn "$grigdesk_root/bin/grigdesk-ctl" "$link_file"

  for legacy in grigdesk "$legacy_cli"; do
    case "$(readlink -- "$target_bin/$legacy" 2>/dev/null)" in
      "$grigdesk_root/bin/grigdesk" | "$grigdesk_root/bin/$legacy_cli")
        rm -f -- "$target_bin/$legacy"
        ;;
    esac
  done
}
