#!/usr/bin/env bash

# Загружает машинные параметры запуска тем же штатным парсером .env, которым сервер
# читает их через `node --env-file`. Сам `.env` не source-ится и не попадает в eval:
# строки вроде `VALUE=$(command)` остаются обычным текстом. Уже экспортированное
# окружение имеет приоритет над значениями файла — это также поведение Node.
cockpit_add_cli_paths() {
  local kimi_bin_dir="${HOME:?домашний каталог обязателен}/.kimi-code/bin"
  case ":${PATH:-}:" in
    *":${kimi_bin_dir}:"*) ;;
    *) PATH="${kimi_bin_dir}${PATH:+:${PATH}}" ;;
  esac
  export PATH
}

cockpit_load_runtime_env() {
  local cockpit_root=${1:?корень cockpit обязателен}
  local env_file="$cockpit_root/.env"
  local output

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
