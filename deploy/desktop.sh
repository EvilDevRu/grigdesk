#!/usr/bin/env bash
# Установка работает с уже собранным файлом, без запуска сборки или сервера.
# Status и remove остаются доступны без Node и без чтения .env.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/deploy/lib/desktop-app.sh"

desktop_temporary=''
desktop_data_home=''
desktop_explicit_home=0

# Окно ставится в bin/ настоящего каталога копии: путь не зависит от ссылки, через которую
# вызвана установка, и совпадает с корнем в runtime.json.
desktop_app() {
  grigdesk_desktop_app_path "$(cd "$ROOT" && pwd -P)"
}

# Уборка знает только уникальный temporary текущего шага установки.
# После успешного rename имя забывается, остальные файлы не удаляются.
cleanup_desktop_copy() {
  if [ -n "$desktop_temporary" ]; then
    rm -f -- "$desktop_temporary"
  fi
}

# runtime.json говорит окну, где сервер этой копии и каким Node его запускать. Корень —
# без символических ссылок, Node — тот, что прошёл проверку версии. JSON собирает Node из
# argv, файл заменяется атомарно с правами 0600; сбой оставляет прежнее описание.
write_runtime_descriptor() {
  local runtime
  local root
  local node_path

  runtime="$(grigdesk_desktop_runtime_path)"

  # Обновление окна из исходников не отменяет отдельный выбор серверного комплекта.
  # Общий parser проверяет форму v3; целостность выбранного R проверяется при его запуске.
  if [[ -f "$runtime" ]] && grigdesk_node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    const { parseRuntimeDescriptor } = await import(pathToFileURL(process.argv[2]).href);
    const descriptor = parseRuntimeDescriptor(readFileSync(process.argv[1], "utf8"));
    process.exit([3, 4].includes(descriptor?.version) ? 0 : 1);
  ' -- "$runtime" "$ROOT/shared/desktop/desktopRuntime.ts"; then
    echo 'Выбор сервера SEA/ELF сохранён; для смены используйте grigdesk-ctl desktop use-server <ELF|R>.'
    return 0
  fi

  root="$(cd "$ROOT" && pwd -P)"
  node_path="$(grigdesk_node -p 'process.execPath')"

  mkdir -p -- "$(dirname "$runtime")"
  desktop_temporary="$(mktemp "$(dirname "$runtime")/runtime.json.tmp.XXXXXX")"
  grigdesk_node -e '
    const [root, node, home, explicit] = process.argv.slice(1);
    const descriptor = explicit === "1" ? { version: 2, root, node, home } : { version: 1, root, node };
    process.stdout.write(JSON.stringify(descriptor) + "\n");
  ' -- "$root" "$node_path" "$desktop_data_home" "$desktop_explicit_home" > "$desktop_temporary"
  chmod 600 "$desktop_temporary"
  mv -fT -- "$desktop_temporary" "$runtime"
  desktop_temporary=''
}

# Node ищется только в явном каталоге и штатном PATH, без менеджеров версий.
# Источник берётся по manifest, установка не читает .env и не запускает сборку.
install_desktop() {
  if [ -n "${GRIGDESK_NODE_DIR:-}" ] && [ -x "$GRIGDESK_NODE_DIR/node" ]; then
    export PATH="$GRIGDESK_NODE_DIR:$PATH"
  fi

  source "$ROOT/deploy/lib/runtime-env.sh"
  grigdesk_add_cli_paths "$ROOT"
  grigdesk_require_node
  desktop_data_home=$(grigdesk_data_home) || return 1
  if [[ -n "${GRIGDESK_HOME:-}" && "$desktop_data_home" != "${HOME%/}/.grigdesk" ]]; then
    desktop_explicit_home=1
  fi

  # Папка может ещё отсутствовать; проверяем реальные границы по ближайшему предку.
  # Установка окна не создаёт папку и не переносит данные сервера.
  grigdesk_node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    function canonical(file) {
      try { return fs.realpathSync(file); }
      catch (error) {
        if (error.code !== "ENOENT" || path.dirname(file) === file) throw error;
        return path.join(canonical(path.dirname(file)), path.basename(file));
      }
    }
    const [selected, home, code] = process.argv.slice(1).map(canonical);
    const contains = (a, b) => a === b || b.startsWith(a + path.sep);
    if (selected === home || contains(code, selected) || contains(selected, code)) {
      console.error("Папка данных не должна совпадать с HOME, лежать внутри кода или содержать его.");
      process.exit(1);
    }
  ' -- "$desktop_data_home" "$HOME" "$ROOT" || return 1

  local version
  local source_file
  local destination

  version="$(grigdesk_node -p 'require(process.argv[1]).version' "$ROOT/desktop/package.json")"
  source_file="$ROOT/desktop/release/grigdesk-desktop-$version-x86_64.AppImage"
  destination="$(desktop_app)"

  if [ ! -f "$source_file" ]; then
    echo 'Готового окна нет. Собери: npm --prefix desktop run dist' >&2
    return 1
  fi

  grigdesk_migrate_desktop_profile || return $?

  # Версия 1 совместима с установленным окном и пишется перед заменой AppImage.
  # Версия 2 становится доступна только после установки окна, умеющего читать home.
  trap cleanup_desktop_copy EXIT
  if [[ "$desktop_explicit_home" == 0 ]]; then
    write_runtime_descriptor
  fi

  # Временная копия скрыта и не исполняема до chmod: bin/ стоит первым в PATH агентов.
  mkdir -p -- "$(dirname "$destination")"
  desktop_temporary="$(mktemp "$(dirname "$destination")/.grigdesk-app.XXXXXX")"
  cp -- "$source_file" "$desktop_temporary"
  chmod 755 "$desktop_temporary"
  mv -fT -- "$desktop_temporary" "$destination"
  desktop_temporary=''
  if [[ "$desktop_explicit_home" == 1 ]]; then
    write_runtime_descriptor
  fi

  # Метка: установлена сборка, которая знает папку данных. Без неё команда переноса не уберёт
  # ссылки совместимости — старая сборка окна пишет журнал и интерфейс через них.
  : > "$(grigdesk_desktop_marker_path)"
  printf '4\n' > "$(dirname "$(grigdesk_desktop_runtime_path)")/runtime-version"

  # Окно до переноса в bin/ лежало в XDG_DATA_HOME. Открытое старое окно продолжит работать:
  # удаляется только имя файла. Ярлык, если он есть, переписывается на новый путь.
  rm -f -- "$(grigdesk_desktop_legacy_app_path)"
  if [ -x "$ROOT/deploy/shortcut.sh" ]; then
    "$ROOT/deploy/shortcut.sh" refresh || echo '⚠ Ярлык не обновлён: deploy/shortcut.sh install' >&2
  fi
}

# Статус отражает пригодный к запуску файл и общий путь без требования Node.
# Три TAB-строки остаются машиночитаемыми и не запускают окно; runtime — наличие файла
# описания: разбор требовал бы Node, а status работает и без него.
desktop_status() {
  local destination
  local runtime
  local installed=0
  local described=0

  destination="$(desktop_app)"
  runtime="$(grigdesk_desktop_runtime_path)"

  if [ -f "$destination" ] && [ -x "$destination" ]; then
    installed=1
  fi

  if [ -f "$runtime" ]; then
    described=1
  fi

  printf 'installed\t%s\npath\t%s\nruntime\t%s\n' "$installed" "$destination" "$described"
}

case "${1:-}" in
  install)
    install_desktop
    ;;
  remove)
    rm -f -- "$(desktop_app)" "$(grigdesk_desktop_legacy_app_path)" \
      "$(grigdesk_desktop_runtime_path)" "$(grigdesk_desktop_marker_path)" \
      "$(dirname "$(grigdesk_desktop_runtime_path)")/runtime-version"
    ;;
  status)
    desktop_status
    ;;
  use-server|use-source)
    desktop_selection=$1
    shift
    if [[ "$desktop_selection" == use-source ]]; then
      set -- --source "$@"
    fi
    source "$ROOT/deploy/lib/runtime-env.sh"
    grigdesk_add_cli_paths "$ROOT"
    grigdesk_require_node

    if [[ -f "$ROOT/release.json" ]]; then
      exec "$_grigdesk_packaged_node" "$ROOT/server/runtime/helpers/select-sea-server.mjs" "$@"
    fi

    exec node --input-type=module -e '
      import { pathToFileURL } from "node:url";
      const { main } = await import(pathToFileURL(process.argv[2]).href);
      process.exitCode = await main(process.argv.slice(3));
    ' -- desktop-selection "$ROOT/server/src/lib/selectSeaServer.ts" "$@"
    ;;
  *)
    echo 'использование: grigdesk-ctl desktop install|remove|status|use-server <ELF|R>|use-source <root> --node <node>' >&2
    exit 2
    ;;
esac
