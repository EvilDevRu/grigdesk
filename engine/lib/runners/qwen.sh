#!/usr/bin/env bash

# Внешний npm CLI выбирается движком; host-wrapper удерживает его reader lease.
# Каталог приходит из того же изолированного ACP discovery, что и модели чата.
source "${FACTORY_HOME:?}/lib/executor.sh"

_runner_qwen_bin() {
  local selected
  selected=$(factory_external_bin qwen "${GRIGDESK_QWEN_BIN:-qwen}") || return 4
  command -v -- "$selected" 2>/dev/null || return 4
}

_runner_qwen_node() {
  local node=${NODE_BIN:-}
  [[ -n "$node" ]] || node="$FACTORY_HOME/../runtime/node/bin/node"
  [[ -x "$node" ]] || node=$(command -v node) || return 4
  printf '%s\n' "$node"
}

runner_qwen_probe() {
  local cli
  cli=$(_runner_qwen_bin) || return 4
  factory_external_exec qwen "$cli" --version
}

runner_qwen_catalog() {
  local cli node
  cli=$(_runner_qwen_bin) || return 4
  node=$(_runner_qwen_node) || return 4
  factory_exec provider "$node" "$FACTORY_HOME/../server/scripts/qwenRunner.mts" \
    --metadata catalog --bin "$cli"
}

runner_qwen_default_policy() {
  printf 'FAMILY=default\nVERSION=latest\nVARIANT=auto\n'
}

runner_qwen_family_alias() {
  return 4
}

runner_qwen_capabilities() {
  printf 'status status_request tools structured_output\n'
}

# Prompt хранится private-файлом; ключ и run identity приходят только окружением.
# Встроенный effort high инертен: Qwen использует generationConfig выбранной модели.
runner_qwen_run() {
  local task=$1 prompt=$2 stage=$3 model=$4 effort=$5 timeout_s=$6 run_dir=$7
  local cli node mode cwd prompt_dir prompt_file runtime_home
  cli=$(_runner_qwen_bin) || return 4
  node=$(_runner_qwen_node) || return 4
  mode=${FACTORY_ROUTE_FILESYSTEM_POLICY:-}
  case "$mode" in
    state-only)
      [[ "${STATE_DIR:-}" == /* ]] || return 4
      cwd=$(realpath -e -- "$STATE_DIR") || return 4
      ;;
    workspace-write) cwd=$(realpath -e -- "$PWD") || return 4 ;;
    *) printf 'Qwen: неизвестная filesystem policy\n' >&2; return 4 ;;
  esac
  [[ "$timeout_s" =~ ^[1-9][0-9]*$ && "$run_dir" == /* ]] || return 4
  prompt_dir="$run_dir/qwen"
  prompt_file="$prompt_dir/prompt.md"
  runtime_home="$prompt_dir/runtime"
  mkdir -p "$prompt_dir" || return
  chmod 700 "$prompt_dir" || return
  (umask 077; printf '%s' "$prompt" >"$prompt_file") || return
  chmod 600 "$prompt_file" || return
  GRIGDESK_QWEN_CONFIG_ROOT="${GRIGDESK_QWEN_CONFIG_ROOT:-$PWD}" \
    factory_exec provider timeout -k 30 "$timeout_s" \
    "$node" "$FACTORY_HOME/../server/scripts/qwenRunner.mts" \
    --bin "$cli" --cwd "$cwd" --run-dir "$run_dir" --runtime-home "$runtime_home" \
    --prompt-file "$prompt_file" --model "$model" --mode "$mode"
}

runner_qwen_classify() {
  case "$2" in
    0) printf 'ok\n' ;;
    124) printf 'timeout\n' ;;
    *) printf 'unknown\n' ;;
  esac
}

# Делегирование не заявлено; повреждённые события не доказывают нулевой fanout.
# Счётчик читает реальные retained tool calls и не назначает исход по тексту модели.
runner_qwen_fanout_count() {
  python3 - "$1/events.jsonl" <<'PYTHON'
import json
import sys

count = 0
try:
    source = open(sys.argv[1], encoding="utf-8")
except FileNotFoundError:
    print(0)
    raise SystemExit(0)
for line in source:
    if not line.strip():
        continue
    event = json.loads(line)
    if event.get("event") == "tool_call" and event.get("name") in {"task", "subagent", "Agent"}:
        count += 1
print(count)
PYTHON
}

runner_qwen_dialect() {
  printf 'Qwen ACP: qwen-jsonl-unknown; billing usage unavailable.\n'
}

runner_qwen_interrupt() {
  return 0
}

runner_qwen_model_options() {
  source "$FACTORY_HOME/lib/runner-model-options.sh"
  _runner_model_options qwen
}
