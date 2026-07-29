#!/usr/bin/env bash

# shellcheck disable=SC1091
source "${FACTORY_HOME:?}/lib/executor.sh"

runner_claude_probe() {
  command -v claude >/dev/null 2>&1 || return 4
  factory_exec provider claude --version
}

runner_claude_catalog() {
  # Claude CLI пока не отдаёт стабильный machine-readable model catalog.
  # Discovery adapter должен заменить эту заглушку live/cache/probed-seed snapshot.
  return 4
}

runner_claude_default_policy() {
  printf 'FAMILY=opus\nVERSION=latest\nVARIANT=auto\nEFFORT=max\n'
}

runner_claude_family_alias() {
  case "${1:-}" in opus|sonnet|haiku) return 0 ;; *) return 4 ;; esac
}

runner_claude_capabilities() {
  printf 'status_fd sandbox tools structured_output fanout\n'
}

runner_claude_run() {
  local task=$1 prompt=$2 stage=$3 model=$4 effort=$5 timeout_s=$6 run_dir=$7
  local -a args=(claude -p "$prompt" --output-format stream-json --verbose)
  [[ -z "$model" ]] || args+=(--model "$model")
  [[ -z "$effort" ]] || args+=(--effort "$effort")
  [[ -z "${RUNNER_CLAUDE_SETTINGS:-}" ]] || args+=(--settings "$RUNNER_CLAUDE_SETTINGS")
  local add_dir
  for add_dir in ${RUNNER_CLAUDE_ADD_DIRS:-}; do
    [[ -d "$add_dir" ]] && args+=(--add-dir "$add_dir")
  done
  args+=(--permission-mode acceptEdits)
  factory_exec provider timeout "$timeout_s" "${args[@]}"
}

_runner_fixture_meta() {
  local run_dir=$1 key=$2
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' \
    "$run_dir/meta.env" 2>/dev/null
}

runner_claude_classify() {
  local run_dir=$1 rc=$2 version verified source_kind
  [[ "$rc" == 0 ]] && { printf 'ok\n'; return; }
  [[ "$rc" == 124 ]] && { printf 'timeout\n'; return; }
  version=$(_runner_fixture_meta "$run_dir" CLI_VERSION)
  verified=$(_runner_fixture_meta "$run_dir" FIXTURE_VERIFIED)
  source_kind=$(_runner_fixture_meta "$run_dir" SOURCE)
  [[ "$version" =~ ^(1|2)\. ]] || { printf 'unknown\n'; return; }
  if grep -qiE 'sandbox denied|permission denied' "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    printf 'denied\n'
    return
  fi
  if [[ "${RUNNER_CLAUDE_LIMIT_SIGNATURE_ENABLED:-0}" == 1 &&
        ( "$verified" == 1 || "$source_kind" == runtime ) ]] && \
     grep -q '"type":"subscription_limit_reached"' "$run_dir/events.jsonl" 2>/dev/null; then
    printf 'limited\n'
    return
  fi
  printf 'unknown\n'
}

runner_claude_fanout_count() {
  grep -cE '"name":"(Agent|Task)"' "$1/events.jsonl" 2>/dev/null || printf '0\n'
}

runner_claude_dialect() {
  printf 'Claude stream-json; terminal status only through stage-result.\n'
}

runner_claude_interrupt() {
  return 0
}
