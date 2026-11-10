#!/usr/bin/env bash

# DeepSeek Harness ACP runner. DSH сам держит файловую границу; этот модуль только
# выбирает pinned binary, переводит route policy и запускает host-wrapper.

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/executor.sh"

_runner_deepseek_node() {
  local node=${GRIGDESK_DEEPSEEK_NODE_BIN:-${NODE_BIN:-}}
  if [[ -n "${GRIGDESK_DEEPSEEK_NODE_BIN:-}" ]]; then
    [[ -x "$node" && ! -d "$node" ]] || return 4
  else
    [[ -n "$node" && -x "$node" ]] || node=$(command -v node 2>/dev/null) || return 4
  fi
  printf '%s\n' "$node"
}

# Metadata helper использует тот же Node и descriptor, что рабочий процесс.
# Здесь нет API key, settings home, model call или автоматической сборки.
# Offline отказ126 сохраняется; недоступный CLI даёт штатный runner-код4.
_runner_deepseek_runtime_info() {
  local node rc
  node=$(_runner_deepseek_node) || return 4
  factory_exec provider "$node" "$FACTORY_HOME/../server/scripts/deepseekRuntimeInfo.mts" "$@"
  rc=$?
  if [[ "$rc" == 0 || "$rc" == 126 ]]; then
    return "$rc"
  fi
  return 4
}

runner_deepseek_refresh_probe() {
  return 0
}

# Только наш абсолютный binary; stock dsh и PATH не участвуют в выборе исполнителя.
# Metadata остаются обязательными и для явно переданного override.
_runner_deepseek_bin() {
  local candidate=${GRIGDESK_DEEPSEEK_BIN:-"$FACTORY_HOME/../bin/deepseek"}
  [[ "$candidate" == /* && -x "$candidate" && ! -d "$candidate" ]] || return 4
  printf '%s\n' "$candidate"
}

runner_deepseek_probe() {
  _runner_deepseek_runtime_info --probe
}

runner_deepseek_catalog() {
  _runner_deepseek_runtime_info --catalog
}

runner_deepseek_default_policy() {
  printf 'FAMILY=default\nVERSION=latest\nVARIANT=auto\nEFFORT=high\n'
}

runner_deepseek_family_alias() {
  return 4
}

runner_deepseek_capabilities() {
  # status_request проходит через отдельный MCP вне tool sandbox. `sandbox` не
  # объявляем: это capability execution planner-а, а не просто наличие DSH bwrap.
  # Native fanout выключен overlay-ем и тоже не заявляется.
  printf 'status status_request tools structured_output\n'
}

_runner_deepseek_model_valid() {
  case "$1" in
    '["deepseek-official","deepseek-flash"]'|\
    '["deepseek-official","deepseek-v4-flash"]'|\
    '["deepseek-official","deepseek-v4-pro"]'|\
    '["deepseek-official","deepseek-v4-flash-vision-exp"]') return 0 ;;
    *) return 1 ;;
  esac
}

runner_deepseek_run() {
  local task=$1 prompt=$2 stage=$3 model=$4 effort=$5 timeout_s=$6 run_dir=$7
  local mode bin node wrapper prompt_dir prompt_file runtime_home cwd descriptor
  local generation='' runtime_identity='' runtime_version='' runner_version='' cache_dir=''

  case "${FACTORY_ROUTE_FILESYSTEM_POLICY:-}" in
    state-only) mode=read-only ;;
    workspace-write) mode=workspace-write ;;
    *)
      printf 'DeepSeek Factory: filesystem policy не поддерживается: %s\n' \
        "${FACTORY_ROUTE_FILESYSTEM_POLICY:-<empty>}" >&2
      return 4
      ;;
  esac
  _runner_deepseek_model_valid "$model" || {
    printf 'DeepSeek Factory: неизвестная модель: %s\n' "$model" >&2
    return 4
  }
  case "$effort" in
    ''|off|low|high|max) ;;
    *)
      printf 'DeepSeek Factory: effort не поддерживается: %s\n' "$effort" >&2
      return 4
      ;;
  esac
  [[ "$timeout_s" =~ ^[1-9][0-9]*$ && "$run_dir" == /* ]] || return 4

  node=$(_runner_deepseek_node) || return 4
  {
    descriptor=$(_runner_deepseek_runtime_info) || return 4
    local -a fields=()
    mapfile -t fields < <(printf '%s' "$descriptor" | "$node" --input-type=module -e '
      let data = "";
      for await (const chunk of process.stdin) data += chunk;
      const runtime = JSON.parse(data);
      const cache = runtime.kind === "binary"
        ? runtime.prefixArgs[runtime.prefixArgs.indexOf("--cache-dir") + 1] : "";
      const fields = [runtime.command, runtime.generationDir ?? "", runtime.identity,
        runtime.runtimeVersion, runtime.runnerVersion, cache];
      if (runtime.kind !== "binary"
        || fields.some(v => typeof v !== "string" || /[\r\n\0]/u.test(v))) {
        process.exit(4);
      }
      console.log(fields.join("\n"));
    ')
    [[ "${#fields[@]}" == 6 ]] || return 4
    bin=${fields[0]}
    generation=${fields[1]}
    runtime_identity=${fields[2]}
    runtime_version=${fields[3]}
    runner_version=${fields[4]}
    cache_dir=${fields[5]}
    if [[ -n "${FACTORY_RUNNER_VERSION:-}" &&
          "$FACTORY_RUNNER_VERSION" != "$runner_version" ]]; then
      printf 'FACTORY_ERROR=runtime_changed RUNNERS=deepseek\n' >&2
      return 4
    fi
  }
  wrapper="$FACTORY_HOME/../server/scripts/deepseekRunner.mts"
  [[ -f "$wrapper" ]] || return 4
  cwd=$(realpath -e -- "$PWD" 2>/dev/null) || return 4

  prompt_dir="$run_dir/deepseek"
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
  )
  [[ -z "$effort" ]] || args+=(--effort "$effort")
  if [[ -n "$generation" ]]; then
    args+=(--artifact-dir "$generation")
  fi
  [[ -z "$runtime_identity" ]] || args+=(--runtime-identity "$runtime_identity"
    --runtime-version "$runtime_version")
  [[ -z "$cache_dir" ]] || args+=(--cache-dir "$cache_dir")

  # Prompt остаётся private-файлом, status identity — только server-owned env.
  # RUNNER_DEEPSEEK_ADD_DIRS намеренно не становится дополнительной writable root.
  factory_exec provider timeout -k 30 "$timeout_s" "${args[@]}"
}

_runner_deepseek_meta() {
  local run_dir=$1 key=$2
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' \
    "$run_dir/meta.env" 2>/dev/null
}

_runner_deepseek_no_model_activity() {
  command -v python3 >/dev/null 2>&1 || return 1
  python3 - "$1/events.jsonl" <<'PYTHON'
import json
import sys

try:
    source = open(sys.argv[1], encoding="utf-8", errors="strict")
except OSError:
    raise SystemExit(0)

for line in source:
    if not line.strip():
        continue
    try:
        event = json.loads(line)
    except (TypeError, ValueError, UnicodeError):
        # Повреждённый retained stream не доказывает отсутствие уже сделанной работы.
        raise SystemExit(1)
    if event.get("event") in {"agent_message_chunk", "tool_call"}:
        raise SystemExit(1)
raise SystemExit(0)
PYTHON
}

runner_deepseek_classify() {
  local run_dir=$1 rc=$2 verified source_kind
  [[ "$rc" == 0 ]] && { printf 'ok\n'; return; }
  [[ "$rc" == 124 ]] && { printf 'timeout\n'; return; }
  verified=$(_runner_deepseek_meta "$run_dir" FIXTURE_VERIFIED)
  source_kind=$(_runner_deepseek_meta "$run_dir" SOURCE)
  if [[ "$verified" != 1 && "$source_kind" != runtime ]]; then
    printf 'unknown\n'
    return
  fi
  # Единственная live-доказанная переключаемая сигнатура P0: неверный ключ до
  # любой model/tool activity. После activity или при повреждённом потоке повтор
  # мог бы выполнить этап дважды и потому запрещён.
  if grep -qE 'Authentication Fails, Your api key: .* is invalid' \
      "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    if _runner_deepseek_no_model_activity "$run_dir"; then
      printf 'provider_unavailable\n'
      return
    fi
  fi
  # Доказанной сигнатуры exhausted quota нет. 413/429, sandbox failure и любые
  # новые ошибки остаются unknown — автоматический replay запрещён.
  printf 'unknown\n'
}

runner_deepseek_fanout_count() {
  command -v python3 >/dev/null 2>&1 || { printf '0\n'; return; }
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
except (TypeError, ValueError, UnicodeError):
    raise SystemExit(1)
print(count)
PYTHON
}

runner_deepseek_dialect() {
  printf 'DeepSeek Harness ACP: deepseek-harness-jsonl-v1; billing usage unavailable.\n'
}

runner_deepseek_interrupt() {
  # Wrapper и DSH остаются в setsid-сессии launcher-а. При адресном abort wrapper
  # шлёт ACP cancel; внешний timeout вправе одновременно сигналить всей группе.
  # Host quiescence в обоих случаях добивает tool/MCP children этой сессии.
  return 0
}

# Варианты запуска подтверждаются metadata раннера, отдельно от каталога чатов.
# Callback не вызывает модель и не пишет реестр пользовательских настроек.
runner_deepseek_model_options() {
  source "$FACTORY_HOME/lib/runner-model-options.sh"
  _runner_model_options deepseek
}
