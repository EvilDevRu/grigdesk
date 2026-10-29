#!/usr/bin/env bash

# GLM этапа Factory поверх того же DSH ELF, что и DeepSeek: маршрут zai, только
# Обычный API и headless-политика этапа. Модуль выбирает binary, сверяет descriptor
# и запускает host-wrapper GLM; ход и статусный MCP принадлежат wrapper-у сервера.

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/executor.sh"

# Node и DSH ELF — общая host-поставка DSH: у GLM нет собственного CLI и Node.
_runner_glm_node() {
  local node=${GRIGDESK_DEEPSEEK_NODE_BIN:-${NODE_BIN:-}}
  if [[ -n "${GRIGDESK_DEEPSEEK_NODE_BIN:-}" ]]; then
    [[ -x "$node" && ! -d "$node" ]] || return 4
  else
    [[ -n "$node" && -x "$node" ]] || node=$(command -v node 2>/dev/null) || return 4
  fi
  printf '%s\n' "$node"
}

# Metadata helper без ключа модели, settings home и модельного вызова. Режим доступа
# сверяется по допуску ELF: Coding Plan и неизвестный режим дают штатный код 4.
_runner_glm_runtime_info() {
  local node rc
  node=$(_runner_glm_node) || return 4
  factory_exec provider "$node" "$FACTORY_HOME/../server/scripts/glmRuntimeInfo.mts" "$@"
  rc=$?
  if [[ "$rc" == 0 || "$rc" == 126 ]]; then
    return "$rc"
  fi
  return 4
}

# Поставка DSH меняется независимо от движка: каждая проба сверяет её заново.
runner_glm_refresh_probe() {
  return 0
}

runner_glm_probe() {
  _runner_glm_runtime_info --probe
}

runner_glm_catalog() {
  _runner_glm_runtime_info --catalog
}

runner_glm_default_policy() {
  printf 'FAMILY=default\nVERSION=latest\nVARIANT=auto\nEFFORT=high\n'
}

runner_glm_family_alias() {
  return 4
}

runner_glm_capabilities() {
  # Статус идёт через host-owned MCP этапа вне файловой песочницы DSH. `sandbox`
  # не объявляем (это capability planner-а), fanout и native resume не доказаны.
  printf 'status status_request tools structured_output\n'
}

# Descriptor metadata-helper-а — единственный источник ELF, identity, версии раннера,
# кэша и каталога моделей. Модель и уровень сверяются с ним до записи prompt.
_runner_glm_descriptor_fields() {
  local node=$1 model=$2 effort=$3
  "$node" --input-type=module -e '
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    const runtime = JSON.parse(data);
    const [model, effort] = process.argv.slice(1);
    const cacheAt = Array.isArray(runtime.prefixArgs) ? runtime.prefixArgs.indexOf("--cache-dir") : -1;
    const cache = cacheAt >= 0 ? runtime.prefixArgs[cacheAt + 1] : "";
    const fields = [runtime.command, runtime.identity, runtime.runtimeVersion,
      runtime.runnerVersion, cache];
    if (runtime.kind !== "binary" || !Array.isArray(runtime.models)
      || fields.some(v => typeof v !== "string" || /[\r\n\0]/u.test(v))) {
      process.exit(4);
    }
    const entry = runtime.models.find(item => item && item.id === model);
    if (!entry || (effort !== "" && !(entry.efforts || []).includes(effort))) {
      process.exit(3);
    }
    console.log(fields.join("\n"));
  ' "$model" "$effort"
}

runner_glm_run() {
  local task=$1 prompt=$2 stage=$3 model=$4 effort=$5 timeout_s=$6 run_dir=$7
  local mode node wrapper prompt_dir prompt_file runtime_home cwd descriptor
  local bin runtime_identity runtime_version runner_version cache_dir

  # Этап идёт в режиме службы (api или coding-plan — factory-policy-v2, 29.10.2026):
  # допуск режима по metadata DSH проверяет probe, ключ активного режима подставляет
  # wrapper через buildGlmChildEnv; здесь только валидация значения до похода в descriptor.
  case "${GRIGDESK_GLM_API_MODE:-}" in
    api|coding-plan) ;;
    *)
      printf 'GLM Factory: нужен режим доступа api или coding-plan (получен: %s)\n' \
        "${GRIGDESK_GLM_API_MODE:-<пусто>}" >&2
      return 4
      ;;
  esac
  case "${FACTORY_ROUTE_FILESYSTEM_POLICY:-}" in
    state-only) mode=read-only ;;
    workspace-write) mode=workspace-write ;;
    *)
      printf 'GLM Factory: filesystem policy не поддерживается: %s\n' \
        "${FACTORY_ROUTE_FILESYSTEM_POLICY:-<empty>}" >&2
      return 4
      ;;
  esac
  case "$effort" in
    ''|off|low|high|max) ;;
    *)
      printf 'GLM Factory: effort не поддерживается: %s\n' "$effort" >&2
      return 4
      ;;
  esac
  [[ "$timeout_s" =~ ^[1-9][0-9]*$ && "$run_dir" == /* ]] || return 4

  node=$(_runner_glm_node) || return 4
  descriptor=$(_runner_glm_runtime_info) || return 4
  local -a fields=()
  mapfile -t fields < <(
    printf '%s' "$descriptor" | _runner_glm_descriptor_fields "$node" "$model" "$effort"
  )
  if [[ "${#fields[@]}" != 5 ]]; then
    printf 'GLM Factory: модель или уровень не из каталога этапа: %s %s\n' "$model" "$effort" >&2
    return 4
  fi
  bin=${fields[0]}
  runtime_identity=${fields[1]}
  runtime_version=${fields[2]}
  runner_version=${fields[3]}
  cache_dir=${fields[4]}
  if [[ -n "${FACTORY_RUNNER_VERSION:-}" &&
        "$FACTORY_RUNNER_VERSION" != "$runner_version" ]]; then
    printf 'FACTORY_ERROR=runtime_changed RUNNERS=glm\n' >&2
    return 4
  fi
  wrapper="$FACTORY_HOME/../server/scripts/glmRunner.mts"
  [[ -f "$wrapper" ]] || return 4
  cwd=$(realpath -e -- "$PWD" 2>/dev/null) || return 4

  prompt_dir="$run_dir/glm"
  prompt_file="$prompt_dir/prompt.md"
  runtime_home="$prompt_dir/runtime"
  mkdir -p "$prompt_dir" || return
  chmod 700 "$prompt_dir" 2>/dev/null || return
  (umask 077; printf '%s' "$prompt" >"$prompt_file") || return
  chmod 600 "$prompt_file" 2>/dev/null || return

  local -a args=(
    "$node" "$wrapper"
    --bin "$bin"
    --cwd "$cwd"
    --run-dir "$run_dir"
    --runtime-home "$runtime_home"
    --prompt-file "$prompt_file"
    --model "$model"
    --mode "$mode"
    --runtime-identity "$runtime_identity"
    --runtime-version "$runtime_version"
  )
  [[ -z "$effort" ]] || args+=(--effort "$effort")
  [[ -z "$cache_dir" ]] || args+=(--cache-dir "$cache_dir")

  # Prompt остаётся private-файлом, ключ и status identity — только server-owned env.
  # RUNNER_GLM_ADD_DIRS намеренно не становится дополнительной writable root.
  factory_exec provider timeout -k 30 "$timeout_s" "${args[@]}"
}

runner_glm_classify() {
  local rc=$2
  [[ "$rc" == 0 ]] && { printf 'ok\n'; return; }
  [[ "$rc" == 124 ]] && { printf 'timeout\n'; return; }
  # Live-доказанной сигнатуры GLM нет: 401 до и после работы, 429, 413, обрыв потока
  # и ошибки wrapper-а остаются unknown — автоматический повтор этапа запрещён.
  printf 'unknown\n'
}

runner_glm_fanout_count() {
  # Делегирование — разбор retained JSON wrapper-а. Повреждённый поток не доказывает
  # отсутствие делегирования, поэтому даёт отказ, а не константу 0.
  command -v python3 >/dev/null 2>&1 || return 1
  python3 - "$1/events.jsonl" <<'PYTHON'
import json
import sys

delegation = {
    "subagent", "subagent-spawn-in-process", "subagent-fork-in-process",
    "tool-subagent-control", "tool-subagent-list-agents", "tool-subagent",
    "tool-subagent-fork", "workflow", "tool-workflow", "ralph", "tool-ralph",
    "jobs", "tool-jobs",
}
count = 0
try:
    source = open(sys.argv[1], encoding="utf-8", errors="strict")
except OSError:
    print(0)
    raise SystemExit(0)
try:
    for line in source:
        if not line.strip():
            continue
        event = json.loads(line)
        if event.get("event") == "tool_call" and event.get("name") in delegation:
            count += 1
except (TypeError, ValueError, UnicodeError, AttributeError):
    raise SystemExit(1)
print(count)
PYTHON
}

runner_glm_dialect() {
  printf 'GLM Factory: glm-factory-jsonl-v1 поверх DSH web; billing usage unavailable.\n'
}

runner_glm_interrupt() {
  return 0
}
