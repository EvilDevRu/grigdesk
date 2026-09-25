#!/usr/bin/env bash

# Минимальная версия Node: с 22.18 снятие типов встроено, и собственный TypeScript
# кокпита исполняется без единого флага. Ниже этой версии импорт `.ts` падает на
# разрешении модуля — читаемый отказ можно дать только здесь, до самого запуска.
COCKPIT_MIN_NODE=22.18.0

# Сравнение по частям: `sort -V` вернул бы 22.9 новее 22.18.
cockpit_require_node() {
  local actual
  actual=$(node -p 'process.versions.node' 2>/dev/null) || {
    echo "node не найден в PATH" >&2
    return 1
  }

  local -a have want
  IFS=. read -r -a have <<<"${actual%%-*}"
  IFS=. read -r -a want <<<"$COCKPIT_MIN_NODE"

  local i
  for i in 0 1 2; do
    (( ${have[i]:-0} > ${want[i]:-0} )) && return 0
    (( ${have[i]:-0} < ${want[i]:-0} )) && {
      echo "Cockpit требует Node $COCKPIT_MIN_NODE или новее, найден $actual." >&2
      echo "С 22.18 Node исполняет TypeScript сам; на более старой версии сервер не стартует." >&2
      echo "Обнови Node (nvm install $COCKPIT_MIN_NODE) и повтори запуск." >&2
      return 1
    }
  done

  return 0
}

# CLI текущей установки доступны без повторного запуска installer. Абсолютный bin
# наследуется агентами даже при старте из рабочего дерева другого проекта.
cockpit_add_cli_paths() {
  local cockpit_root=${1:-}
  local cli_bin_dir
  local cli_path_entry
  local -a cli_path_entries
  if [[ -z "$cockpit_root" ]]; then
    cockpit_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P) || return 1
  fi

  for cli_bin_dir in \
    "${HOME:?домашний каталог обязателен}/.kimi-code/bin" \
    "$HOME/.local/bin"; do
    case ":${PATH:-}:" in
      *":${cli_bin_dir}:"*) ;;
      *) PATH="${cli_bin_dir}${PATH:+:${PATH}}" ;;
    esac
  done

  # Текущая установка всегда первая, даже если bin уже был в хвосте PATH:
  # пользовательский симлинк может всё ещё вести в другой checkout.
  IFS=: read -r -a cli_path_entries <<<"${PATH:-}"
  PATH="$cockpit_root/bin"
  for cli_path_entry in "${cli_path_entries[@]}"; do
    [[ "$cli_path_entry" == "$cockpit_root/bin" ]] && continue
    PATH+=":$cli_path_entry"
  done

  export PATH
}

# Загружает .env штатным парсером Node без source/eval: подстановки shell остаются
# обычным текстом, а уже экспортированное окружение имеет приоритет над файлом.
cockpit_load_runtime_env() {
  local cockpit_root=${1:?корень cockpit обязателен}
  local env_file="$cockpit_root/.env"
  local output

  cockpit_require_node || return 1

  COCKPIT_NODE_ENV_ARGS=()
  [[ -f "$env_file" ]] && COCKPIT_NODE_ENV_ARGS=(--env-file "$env_file")

  if ! output=$(node "${COCKPIT_NODE_ENV_ARGS[@]}" -e '
    const port = Number(process.env.COCKPIT_PORT) || 8140;
    const tlsPort = Number(process.env.COCKPIT_TLS_PORT) || 8143;
    process.stdout.write(`${port}\t${tlsPort}\n`);
  '); then
    echo "не удалось прочитать параметры запуска из $env_file" >&2
    return 1
  fi

  IFS=$'\t' read -r COCKPIT_EFFECTIVE_PORT COCKPIT_EFFECTIVE_TLS_PORT <<<"$output"
  [[ "$COCKPIT_EFFECTIVE_PORT" =~ ^[0-9]+$ &&
     "$COCKPIT_EFFECTIVE_TLS_PORT" =~ ^[0-9]+$ ]] || {
    echo "не удалось определить порты кокпита" >&2
    return 1
  }
}
