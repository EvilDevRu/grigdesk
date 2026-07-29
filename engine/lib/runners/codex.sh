#!/usr/bin/env bash

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/executor.sh"

runner_codex_probe() {
  command -v codex >/dev/null 2>&1 || return 4
  factory_exec provider codex --version
}

runner_codex_catalog() {
  local cache
  if [[ -n "${FACTORY_CODEX_MODEL_CACHE:-}" ]]; then
    cache=$FACTORY_CODEX_MODEL_CACHE
  elif [[ -n "${CODEX_HOME:-}" ]]; then
    cache="$CODEX_HOME/models_cache.json"
  else
    cache="${HOME:?}/.codex/models_cache.json"
  fi
  [[ -r "$cache" ]] || return 4
  python3 - "$cache" <<'PYTHON'
import json
import re
import sys

try:
    with open(sys.argv[1], encoding='utf-8') as source:
        payload = json.load(source)
except (OSError, ValueError):
    raise SystemExit(4)

count = 0
for model in payload.get('models', []):
    slug = model.get('slug')
    priority = model.get('priority')
    if model.get('visibility') != 'list' or not isinstance(slug, str):
        continue
    match = re.fullmatch(r'gpt-(\d+(?:\.\d+)+)-([a-z][a-z0-9-]*)', slug)
    if not match or not isinstance(priority, int) or priority < 0:
        continue
    fields = (
        slug, 'codex', match.group(2), match.group(1), 'default',
        str(1_000_000 - priority), '1', '0', '1', '0.0.0', '999.999.999',
    )
    print('\t'.join(fields))
    count += 1
raise SystemExit(0 if count else 4)
PYTHON
}

runner_codex_default_policy() {
  printf 'FAMILY=sol\nVERSION=latest\nVARIANT=auto\nEFFORT=xhigh\n'
}

runner_codex_family_alias() {
  return 4
}

runner_codex_capabilities() {
  printf 'status_fd sandbox tools structured_output\n'
}

runner_codex_run() {
  local task=$1 prompt=$2 stage=$3 model=$4 effort=$5 timeout_s=$6 run_dir=$7
  local sandbox=${RUNNER_CODEX_SANDBOX:-workspace-write}
  local -a args=(codex exec --json --skip-git-repo-check --sandbox "$sandbox")
  [[ -z "$model" ]] || args+=(-m "$model")
  [[ -z "$effort" ]] || args+=(-c "model_reasoning_effort=\"$effort\"")
  local add_dir
  for add_dir in ${RUNNER_CODEX_ADD_DIRS:-}; do
    [[ -d "$add_dir" ]] && args+=(--add-dir "$add_dir")
  done
  args+=(-o "$run_dir/last.md" -)
  factory_exec provider timeout "$timeout_s" "${args[@]}" <<<"$prompt"
}

_runner_codex_meta() {
  local run_dir=$1 key=$2
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' \
    "$run_dir/meta.env" 2>/dev/null
}

_runner_codex_no_model_activity() {
  command -v python3 >/dev/null 2>&1 || return 1
  python3 - "$1/events.jsonl" <<'PYTHON'
import json
import sys

try:
    source = open(sys.argv[1], encoding="utf-8", errors="replace")
except OSError:
    raise SystemExit(1)

for line in source:
    if not line.strip():
        continue
    try:
        event = json.loads(line)
    except (TypeError, ValueError):
        raise SystemExit(1)
    kind = event.get("type", "")
    item = event.get("item") or {}
    if kind in {"item.started", "item.completed"} and item.get("type") in {
        "agent_message", "command_execution", "file_change", "mcp_tool_call",
    }:
        raise SystemExit(1)
    usage = event.get("usage") or {}
    if kind == "turn.completed" and any(
        isinstance(value, (int, float)) and value > 0 for value in usage.values()
    ):
        raise SystemExit(1)
raise SystemExit(0)
PYTHON
}

runner_codex_classify() {
  local run_dir=$1 rc=$2 version verified source_kind
  [[ "$rc" == 0 ]] && { printf 'ok\n'; return; }
  [[ "$rc" == 124 ]] && { printf 'timeout\n'; return; }
  version=$(_runner_codex_meta "$run_dir" CLI_VERSION)
  verified=$(_runner_codex_meta "$run_dir" FIXTURE_VERIFIED)
  source_kind=$(_runner_codex_meta "$run_dir" SOURCE)
  [[ "$version" =~ ^0\.145\. ]] || { printf 'unknown\n'; return; }
  if grep -qiE 'sandbox[_ ]denied|permission denied' \
      "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    printf 'denied\n'
    return
  fi
  if [[ "$verified" != 1 && "$source_kind" != runtime ]]; then
    printf 'unknown\n'
    return
  fi
  if grep -qiE -e '(^|[^0-9])413([^0-9]|$)' -e 'request too large' \
      -e 'context[_ -]length[_ -]exceeded' -e 'context window.*exceed' \
      "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    printf 'context_overflow\n'
    return
  fi
  if grep -q '"type":"usage_limit_reached"' "$run_dir/events.jsonl" 2>/dev/null || \
     grep -qiE '429.*(weekly|subscription|usage).*(limit|reached)|\
(weekly|subscription|usage).*limit.*(reached|reset)' \
       "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    printf 'limited\n'
    return
  fi
  if grep -qiE '(^|[^0-9])429([^0-9]|$)|"type":"rate_limit_error"|too many requests' \
      "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    printf 'transient\n'
    return
  fi
  if grep -qiE -e '(^|[^0-9])(401|403)([^0-9]|$)' -e 'unauthorized' \
      -e 'authentication.*(expired|required)' -e 'request not allowed' \
      -e 'run codex login' \
      "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    if _runner_codex_no_model_activity "$run_dir"; then
      printf 'provider_unavailable\n'
      return
    fi
  fi
  printf 'unknown\n'
}

runner_codex_fanout_count() {
  printf '0\n'
}

runner_codex_dialect() {
  printf 'Codex JSONL; no native Claude Task requirement; terminal status through stage-result.\n'
}

runner_codex_interrupt() {
  return 0
}
