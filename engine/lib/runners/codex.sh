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
  if [[ "${RUNNER_CODEX_LIMIT_SIGNATURE_ENABLED:-0}" == 1 &&
        ( "$verified" == 1 || "$source_kind" == runtime ) ]] && \
     grep -q '"type":"usage_limit_reached"' "$run_dir/events.jsonl" 2>/dev/null; then
    printf 'limited\n'
    return
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
