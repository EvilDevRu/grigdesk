#!/usr/bin/env bash

# DeepSeek Harness ACP runner. DSH сам держит файловую границу; этот модуль только
# выбирает pinned binary, переводит route policy и запускает host-wrapper.

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/executor.sh"

_runner_deepseek_node() {
  local node=${COCKPIT_DEEPSEEK_NODE_BIN:-${NODE_BIN:-}}
  if [[ -n "${COCKPIT_DEEPSEEK_NODE_BIN:-}" ]]; then
    [[ -x "$node" && ! -d "$node" ]] || return 4
  else
    [[ -n "$node" && -x "$node" ]] || node=$(command -v node 2>/dev/null) || return 4
  fi
  printf '%s\n' "$node"
}

_runner_deepseek_embedded() {
  [[ -z "${COCKPIT_DEEPSEEK_BIN:-}" ]] || return 1
  local mode=${COCKPIT_DEEPSEEK_RUNTIME_MODE:-}
  if [[ -z "$mode" ]]; then
    local node
    node=$(_runner_deepseek_node) || return 4
    mode=$("$node" --input-type=module -e '
      const { deepSeekDistributionMode } = await import(process.argv[1]);
      console.log(deepSeekDistributionMode(process.argv[2]));
    ' "$FACTORY_HOME/../server/src/lib/deepseek/distribution.ts" \
      "$FACTORY_HOME/../server/deepseek-runtime-contract.json" 2>/dev/null) || mode=embedded
  fi
  [[ -z "${COCKPIT_DEEPSEEK_BIN:-}" ]] &&
    [[ "$mode" == embedded ||
       -n "${COCKPIT_DEEPSEEK_ARTIFACT_DIR:-}" ]]
}

# Metadata helper использует тот же Node и descriptor, что рабочий процесс.
# Здесь нет API key, settings home, model call или автоматической сборки.
_runner_deepseek_runtime_info() {
  local node
  node=$(_runner_deepseek_node) || return 4
  factory_exec local "$node" "$FACTORY_HOME/../server/scripts/deepseekRuntimeInfo.mts" "$@"
}

runner_deepseek_refresh_probe() {
  _runner_deepseek_embedded
}

_runner_deepseek_bin() {
  local candidate runtime_home state_root
  if [[ -n "${COCKPIT_DEEPSEEK_BIN:-}" ]]; then
    [[ -x "$COCKPIT_DEEPSEEK_BIN" && ! -d "$COCKPIT_DEEPSEEK_BIN" ]] || return 4
    printf '%s\n' "$COCKPIT_DEEPSEEK_BIN"
    return 0
  fi

  state_root=${FACTORY_STATE:-${STATE_DIR:-${HOME:?}/.factory/state}}
  runtime_home=${COCKPIT_DEEPSEEK_RUNTIME_HOME:-"$state_root/cockpit-deepseek"}
  candidate="$runtime_home/install/current/node_modules/.bin/dsh"
  if [[ -x "$candidate" && ! -d "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  command -v dsh 2>/dev/null || return 4
}

runner_deepseek_probe() {
  local bin version
  if _runner_deepseek_embedded; then
    _runner_deepseek_runtime_info --probe
    return
  fi
  bin=$(_runner_deepseek_bin) || return 4
  version=$(factory_exec provider "$bin" -V) || return
  version=${version%%[[:space:]]*}
  [[ "$version" == 0.1.5-rc.2 ]] || return 4
  printf '%s\n' "$version"
}

runner_deepseek_catalog() {
  if _runner_deepseek_embedded; then
    _runner_deepseek_runtime_info --catalog
    return
  fi
  # Opaque ACP ids и их доступность сняты pinned metadata-probe P0. У id нет
  # стабильного family metadata, поэтому family честно `default`; release задаёт
  # только default (V4 Flash), а не сравнительную «силу» моделей.
  printf '%s\n' \
    $'["deepseek-official","deepseek-v4-flash"]\tdeepseek\tdefault\t1\tdefault\t100\t1\t0\t1\t0.1.5-rc.2\t0.1.5-rc.2' \
    $'["deepseek-official","deepseek-v4-pro"]\tdeepseek\tdefault\t1\tdefault\t90\t1\t0\t1\t0.1.5-rc.2\t0.1.5-rc.2' \
    $'["deepseek-official","deepseek-flash"]\tdeepseek\tdefault\t1\tdefault\t80\t1\t0\t1\t0.1.5-rc.2\t0.1.5-rc.2' \
    $'["deepseek-official","deepseek-v4-flash-vision-exp"]\tdeepseek\tdefault\t1\tdefault\t70\t1\t0\t1\t0.1.5-rc.2\t0.1.5-rc.2'
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
  local generation='' runtime_identity='' runtime_version=''

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
  if _runner_deepseek_embedded; then
    descriptor=$(_runner_deepseek_runtime_info) || return 4
    local -a fields=()
    mapfile -t fields < <(printf '%s' "$descriptor" | "$node" --input-type=module -e '
      let data = "";
      for await (const chunk of process.stdin) data += chunk;
      const runtime = JSON.parse(data);
      const fields = [runtime.command, runtime.generationDir, runtime.identity, runtime.runtimeVersion];
      if (runtime.kind !== "embedded" || fields.some(v => typeof v !== "string" || /[\r\n\0]/u.test(v))) {
        process.exit(4);
      }
      console.log(fields.join("\n"));
    ')
    [[ "${#fields[@]}" == 4 ]] || return 4
    bin=${fields[0]}
    generation=${fields[1]}
    runtime_identity=${fields[2]}
    runtime_version=${fields[3]}
    if [[ -n "${FACTORY_RUNNER_VERSION:-}" &&
          "$FACTORY_RUNNER_VERSION" != "$runtime_version" ]]; then
      printf 'FACTORY_ERROR=runtime_changed RUNNERS=deepseek\n' >&2
      return 4
    fi
  else
    bin=$(_runner_deepseek_bin) || return 4
  fi
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
    args+=(--artifact-dir "$generation" --runtime-identity "$runtime_identity"
      --runtime-version "$runtime_version")
  fi

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
