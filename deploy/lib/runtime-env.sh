#!/usr/bin/env bash

# Общий host и DeepSeek используют один Node со снятием TypeScript-типов.
# Закреплённый Harness допускает ветку 22 с 22.19 или Node 24 и новее.
GRIGDESK_MIN_NODE=22.19.0

# Вычисляет папку теми же правилами, что shared/runtime/dataHome.ts, без внешних команд.
# Пустой PATH и set -u допустимы; неверный HOME не превращается в корень диска.
grigdesk_data_home() {
  local value=${GRIGDESK_HOME:-}
  local hint=
  local LC_ALL=C
  local user_home=${HOME:-}

  if [[ -z "$value" ]]; then
    hint='; задайте GRIGDESK_HOME'

    if [[ "${HOME:-}" != /* ]]; then
      printf '%s%s%s\n' \
        'GRIGDESK_HOME должен быть абсолютным путём из латинских букв, цифр и символов ' \
        '. _ + - / @ , = : — получено: ' "${HOME:-}$hint" >&2
      return 1
    fi

    while [[ "$user_home" == */ ]]; do
      user_home=${user_home%/}
    done

    value="$user_home/.grigdesk"
  fi

  while [[ "$value" == */ ]]; do
    value=${value%/}
  done

  if [[ "$value" != /* || ! "$value" =~ ^[A-Za-z0-9._+/@,=:-]+$ \
    || "/${value#/}/" == */./* || "/${value#/}/" == */../* ]]; then
    printf '%s%s%s\n' \
      'GRIGDESK_HOME должен быть абсолютным путём из латинских букв, цифр и символов ' \
      '. _ + - / @ , = : — получено: ' "$value$hint" >&2
    return 1
  fi

  printf '%s\n' "$value"
}

# Отдельный файл настроек разрешается без обращения к папке данных.
# Неявный файл всегда берётся из проверенного результата grigdesk_data_home.
grigdesk_env_file() {
  local directory

  if [[ -n "${GRIGDESK_ENV_FILE:-}" ]]; then
    printf '%s\n' "$GRIGDESK_ENV_FILE"
    return 0
  fi

  directory=$(grigdesk_data_home) || return 1
  printf '%s/.env\n' "$directory"
}

# Проверка выполняется до чтения TS-модулей и подготовки встроенного runtime.
# Node 23 не входит в compatibility закреплённого Harness.
grigdesk_require_node() {
  local actual
  actual=$(node -p 'process.versions.node' 2>/dev/null) || {
    echo "node не найден в PATH" >&2
    return 1
  }

  local -a have
  IFS=. read -r -a have <<<"${actual%%-*}"

  if (( ${have[0]:-0} >= 24 || (${have[0]:-0} == 22 && ${have[1]:-0} >= 19) )); then
    return 0
  fi

  echo "GrigDesk требует Node ^22.19.0 || >=24.0.0, найден $actual." >&2
  echo "Обнови Node (nvm install $GRIGDESK_MIN_NODE) и повтори запуск." >&2
  return 1
}

# CLI текущей установки доступны без повторного запуска installer. Абсолютный bin
# наследуется агентами даже при старте из рабочего дерева другого проекта.
grigdesk_add_cli_paths() {
  local grigdesk_root=${1:-}
  local cli_bin_dir
  local cli_path_entry
  local -a cli_path_entries
  if [[ -z "$grigdesk_root" ]]; then
    grigdesk_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P) || return 1
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
  PATH="$grigdesk_root/bin"
  for cli_path_entry in "${cli_path_entries[@]}"; do
    [[ "$cli_path_entry" == "$grigdesk_root/bin" ]] && continue
    PATH+=":$cli_path_entry"
  done

  export PATH
}

# Загружает .env штатным парсером Node без source/eval: подстановки shell остаются
# обычным текстом, а уже экспортированное окружение имеет приоритет над файлом.
grigdesk_load_runtime_env() {
  local grigdesk_root=${1:?корень grigdesk обязателен}
  local env_file
  env_file=$(grigdesk_env_file) || return 1
  local output
  local brand_module="${BASH_SOURCE[0]%/*}/../../shared/runtime/legacyBrand.ts"

  grigdesk_require_node || return 1

  GRIGDESK_NODE_ENV_ARGS=()
  [[ -f "$env_file" ]] && GRIGDESK_NODE_ENV_ARGS=(--env-file "$env_file")

  if output=$(node --input-type=module -e '
    import fs from "node:fs";
    import { parseEnv } from "node:util";
    import { pathToFileURL } from "node:url";
    const { legacyRootProblem } = await import(pathToFileURL(process.argv[2]).href);
    const inheritedProblem = legacyRootProblem(process.env);
    if (inheritedProblem) {
      console.error(inheritedProblem);
      process.exit(78);
    }
    const file = process.argv[1];
    const values = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, "utf8")) : {};
    const fileProblem = legacyRootProblem(values, true);
    if (fileProblem) {
      console.error(fileProblem);
      process.exit(78);
    }
    for (const [key, value] of Object.entries(values)) {
      if (!Object.hasOwn(process.env, key)) {
        process.env[key] = value;
      }
    }
    const port = Number(process.env.GRIGDESK_PORT) || 8140;
    process.stdout.write(`${port}\n${process.env.GRIGDESK_CLI_TOKEN_PATH || ""}\n` +
      `${process.env.GRIGDESK_LOG || ""}\n`);
  ' -- "$env_file" "$brand_module"); then
    :
  else
    local code=$?
    echo "не удалось прочитать параметры запуска из $env_file" >&2
    return "$code"
  fi

  local -a values
  mapfile -t values <<<"$output"
  GRIGDESK_EFFECTIVE_PORT=${values[0]:-}
  GRIGDESK_EFFECTIVE_TOKEN_PATH=${values[1]:-}
  GRIGDESK_EFFECTIVE_LOG=${values[2]:-}
  [[ "$GRIGDESK_EFFECTIVE_PORT" =~ ^[0-9]+$ ]] || {
    echo "не удалось определить порт GrigDesk" >&2
    return 1
  }
}


# Скрипт берётся от самой библиотеки, а проверяемое дерево передаётся аргументом.
# Проверка выполняется до остановки процессов и любых записей запускалки.
grigdesk_require_migrated() {
  local code_root=${1:?корень grigdesk обязателен}
  local helper_root
  helper_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P) || return 1
  grigdesk_require_node || return 1
  node "$helper_root/server/scripts/dataHomeCheck.mts" --code-root "$code_root" || return $?
}

# Ждём выхода владельцев PID, даже если они уже отпустили HTTP-порт.
# После срока завершаем только переданные процессы и проверяем результат ещё две секунды.
grigdesk_stop_pids() {
  local seconds=${1:?срок обязателен}
  shift
  local pid deadline
  local -a alive=()
  for pid in "$@"; do
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  done
  (( $# )) || return 0
  kill -TERM "$@" 2>/dev/null || true
  deadline=$((SECONDS + seconds))
  while :; do
    alive=()
    for pid in "$@"; do
      kill -0 "$pid" 2>/dev/null && alive+=("$pid")
    done
    (( ${#alive[@]} )) || return 0
    (( SECONDS < deadline )) || break
    sleep 0.2
  done
  kill -KILL "${alive[@]}" 2>/dev/null || true
  deadline=$((SECONDS + 2))
  while (( SECONDS < deadline )); do
    alive=()
    for pid in "$@"; do
      kill -0 "$pid" 2>/dev/null && alive+=("$pid")
    done
    (( ${#alive[@]} )) || return 0
    sleep 0.1
  done
  echo "Процессы не завершились: ${alive[*]}" >&2
  return 1
}
