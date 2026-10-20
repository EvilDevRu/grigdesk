#!/usr/bin/env bash

# Общий host и DeepSeek используют один Node со снятием TypeScript-типов.
# Закреплённый Harness допускает ветку 22 с 22.19 или Node 24 и новее.
GRIGDESK_MIN_NODE=22.19.0
_grigdesk_verified_package_root=''
_grigdesk_packaged_node=''
_grigdesk_server_binary=''
_grigdesk_binary_package_id=''
_grigdesk_binary_root=''
_grigdesk_preparation_token=''
_grigdesk_preparation_home=''

# Bootstrap не требует системного Node: Python хоста разбирает только JSON как данные.
# Закрытая preparation привязывает свой Node к физическому R и текущему bin установки.
grigdesk_decode_binary_json() {
  local mode=$1
  local value=$2
  local data=${3:-}

  [[ ${#value} -le 65536 ]] || return 1
  python3 -I -S -c '
import json, os, re, sys

try:
    mode, binary, data, text = sys.argv[1:]
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError()
    package = value.get("packageId", "")
    if not isinstance(package, str) or not re.fullmatch("[a-f0-9]{64}", package):
        raise ValueError()
    if mode == "metadata":
        for key, expected in [("format", 1), ("hostContract", 1), ("packagingVersion", 2)]:
            if type(value.get(key)) is not int or value[key] != expected:
                raise ValueError()
        if value.get("version") != "0.1.0" or value.get("runtime") != {
            "node": "24.21.0", "abi": "137", "platform": "linux", "arch": "x64"
        }:
            raise ValueError()
        capabilities = value.get("capabilities")
        if not isinstance(capabilities, list) or sorted(capabilities) != ["api", "engine", "helpers", "ipc"]:
            raise ValueError()
        engine, payload = value.get("engine", {}), value.get("payload", {})
        if engine.get("protocol") != "route-v2":
            raise ValueError()
        for item in [engine.get("sha256"), payload.get("sha256")]:
            if not isinstance(item, str) or not re.fullmatch("[a-f0-9]{64}", item):
                raise ValueError()
        for key in ["size", "entryCount"]:
            if type(payload.get(key)) is not int or payload[key] < 0:
                raise ValueError()
        print(package)
    elif mode == "ownership":
        token = value.get("preparationToken", "")
        if not isinstance(token, str) or not re.fullmatch(
            "[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", token
        ):
            raise ValueError()
        print(package, token, sep="\n")
    else:
        keys = ["packageId", "root", "node", "engine", "installationBin", "preparationToken"]
        if sorted(value) != sorted(keys) or any(not isinstance(value[key], str) for key in keys):
            raise ValueError()
        if any(any(char in item for char in "\r\n\0") for item in value.values()):
            raise ValueError()
        root = os.path.join(data, "runtimes/server/packages", package)
        if value["root"] != root or os.path.realpath(root) != root:
            raise ValueError()
        for key, relative in [("node", "runtime/node/bin/node"), ("engine", "engine/bin/factory")]:
            item = os.path.join(root, relative)
            if value[key] != item or os.path.realpath(item) != item:
                raise ValueError()
            if not os.path.isfile(item) or not os.access(item, os.X_OK):
                raise ValueError()
        if value["installationBin"] != os.path.dirname(binary):
            raise ValueError()
        if not re.fullmatch("[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}",
                            value["preparationToken"]):
            raise ValueError()
        print(package, root, value["node"], value["preparationToken"], sep="\n")
except (ValueError, TypeError, AttributeError):
    sys.exit(1)
' "$mode" "$_grigdesk_server_binary" "$data" "$value"
}

# Наличие внешнего файла выбирает standalone до source и прежнего комплекта.
# Повреждённый ELF не разрешает fallback; metadata не читает D или файл настроек.
grigdesk_select_server_binary() {
  local root=${1:-}
  local magic metadata package

  if [[ -z "$root" ]]; then
    root=$(cd "${BASH_SOURCE[0]%/*}/../.." && pwd -P) || return 1
  fi

  local binary="$root/bin/grigdesk-server"
  [[ -e "$binary" || -L "$binary" ]] || return 0
  [[ "$_grigdesk_server_binary" != "$binary" ]] || return 0
  unset NODE_OPTIONS

  if [[ ! -f "$binary" || -L "$binary" || ! -x "$binary" ]]; then
    echo 'Нужен обычный исполняемый серверный ELF в bin/grigdesk-server.' >&2
    return 1
  fi

  IFS= read -r -N 4 magic < "$binary" || true
  if [[ "$magic" != $'\x7fELF' ]]; then
    echo 'Файл bin/grigdesk-server не является ELF.' >&2
    return 1
  fi

  _grigdesk_server_binary=$binary
  if ! metadata=$("$binary" --runtime-info --json) \
    || ! package=$(grigdesk_decode_binary_json metadata "$metadata"); then
    echo 'Некорректное описание серверного ELF.' >&2
    _grigdesk_server_binary=''
    return 1
  fi

  _grigdesk_binary_package_id=$package
}

# Prepare выполняется непосредственно дочерним процессом shell, а не subshell/pipeline.
# Поэтому lease принадлежит живому потребителю до release после последнего helper-а.
grigdesk_prepare_binary() {
  [[ -z "$_grigdesk_preparation_token" ]] || return 0
  local data output temporary decoded ownership
  local -a values

  data=$(grigdesk_data_home) || return 1
  temporary=$(mktemp) || return 1
  if "$_grigdesk_server_binary" --prepare --json \
    --expect-package-id "$_grigdesk_binary_package_id" > "$temporary"; then
    output=$(< "$temporary")
    rm -f -- "$temporary"
  else
    local code=$?
    rm -f -- "$temporary"
    return "$code"
  fi

  if ownership=$(grigdesk_decode_binary_json ownership "$output"); then
    mapfile -t values <<< "$ownership"
    if [[ "${values[0]}" == "$_grigdesk_binary_package_id" ]]; then
      _grigdesk_preparation_token=${values[1]}
      _grigdesk_preparation_home=$data
    fi
  fi

  if ! decoded=$(grigdesk_decode_binary_json preparation "$output" "$data"); then
    echo 'Некорректный ответ подготовки серверного ELF.' >&2
    return 1
  fi

  mapfile -t values <<< "$decoded"
  if [[ "${values[0]}" != "$_grigdesk_binary_package_id" ]]; then
    echo 'PackageId подготовки серверного ELF изменился.' >&2
    return 1
  fi

  _grigdesk_binary_root=${values[1]}
  _grigdesk_packaged_node=${values[2]}
  _grigdesk_preparation_token=${values[3]}
  _grigdesk_preparation_home=$data
  export GRIGDESK_SERVER_BINARY=$_grigdesk_server_binary
  export PYTHONDONTWRITEBYTECODE=1
}

# CLI и установщик вызывают release в EXIT, включая отказ helper-а и unit-only.
# Старый packageId передаётся явно: замена ELF на новую сборку не теряет прежний lease.
grigdesk_release_binary_preparation() {
  [[ -n "$_grigdesk_preparation_token" ]] || return 0

  GRIGDESK_HOME=$_grigdesk_preparation_home "$_grigdesk_server_binary" \
    --release-preparation "$_grigdesk_preparation_token" \
    --package-id "$_grigdesk_binary_package_id" --json >/dev/null || return $?
  _grigdesk_preparation_token=''
}

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
  grigdesk_select_packaged_node || return $?
  local actual
  actual=$(grigdesk_node -p 'process.versions.node' 2>/dev/null) || {
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

# Внутренние проверки используют собственный Node явно, не меняя выбор Node у детей.
# Source-режим сохраняет обычный поиск интерпретатора в окружении разработчика.
grigdesk_node() {
  "${_grigdesk_packaged_node:-node}" "$@"
}

# Комплект использует собственный интерпретатор как запасной для внешних команд.
# Проверки GrigDesk запускают его явно; Python не создаёт bytecode в комплекте.
grigdesk_select_packaged_node() {
  local runtime_root
  runtime_root=$(cd "${BASH_SOURCE[0]%/*}/../.." && pwd -P) || return 1

  grigdesk_select_server_binary "$runtime_root" || return $?
  if [[ -n "$_grigdesk_server_binary" ]]; then
    grigdesk_prepare_binary
    return $?
  fi

  [[ -f "$runtime_root/release.json" ]] || return 0

  # Флаги не должны сработать даже во время проверки версии вложенного Node.
  # Значение из .env также не передаётся самому SEA при ручном/служебном запуске.
  unset NODE_OPTIONS

  if [[ ! -x "$runtime_root/runtime/node/bin/node" ]]; then
    echo "Повреждён комплект: нет вложенного Node в $runtime_root/runtime/node/bin/node" >&2
    return 1
  fi

  if [[ "$_grigdesk_verified_package_root" != "$runtime_root" ]]; then
    if [[ ! -x "$runtime_root/server/grigdesk-server" ]] \
      || ! "$runtime_root/server/grigdesk-server" --check-startup >/dev/null; then
      echo "Повреждён серверный комплект GrigDesk: проверка manifest не пройдена." >&2
      return 1
    fi

    _grigdesk_verified_package_root=$runtime_root
  fi

  _grigdesk_packaged_node="$runtime_root/runtime/node/bin/node"
  local entry
  local -a entries
  IFS=: read -r -a entries <<<"${PATH:-}"
  PATH=''

  for entry in "${entries[@]}"; do
    [[ -z "$entry" || "$entry" == "$runtime_root/runtime/node/bin" ]] && continue
    PATH+="${PATH:+:}$entry"
  done

  PATH+="${PATH:+:}$runtime_root/runtime/node/bin"
  export PYTHONDONTWRITEBYTECODE=1

  export PATH
}

# Готовит argv отдельно от запуска: SEA не принимает флаги интерпретатора.
# Source сохраняет обычный Node и уже вычисленные аргументы файла окружения.
grigdesk_server_command() {
  local runtime_root=${1:?корень GrigDesk обязателен}

  grigdesk_select_server_binary "$runtime_root" || return $?

  if [[ -n "$_grigdesk_server_binary" ]]; then
    GRIGDESK_SERVER_COMMAND=("$_grigdesk_server_binary")
  elif [[ -f "$runtime_root/release.json" ]]; then
    grigdesk_select_packaged_node || return $?
    GRIGDESK_SERVER_COMMAND=("$runtime_root/runtime/node/bin/node" \
      "$runtime_root/server/runtime/helpers/launch-sea-server.mjs")
  else
    GRIGDESK_SERVER_COMMAND=(node "${GRIGDESK_NODE_ENV_ARGS[@]}" "$runtime_root/server/src/app.ts")
  fi
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

  if [[ -f "$grigdesk_root/release.json" ]]; then
    grigdesk_select_packaged_node || return $?
  fi

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

  if [[ -n "$_grigdesk_binary_root" ]]; then
    brand_module="$_grigdesk_binary_root/server/runtime/helpers/legacy-brand.mjs"
  fi

  GRIGDESK_NODE_ENV_ARGS=()
  [[ -f "$env_file" ]] && GRIGDESK_NODE_ENV_ARGS=(--env-file "$env_file")

  if output=$(grigdesk_node --input-type=module -e '
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

  if [[ -n "$_grigdesk_binary_root" ]]; then
    grigdesk_node "$_grigdesk_binary_root/server/runtime/helpers/data-home-check.mjs" \
      --code-root "$code_root"
    return $?
  fi

  grigdesk_node "$helper_root/server/scripts/dataHomeCheck.mts" --code-root "$code_root" || return $?
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
