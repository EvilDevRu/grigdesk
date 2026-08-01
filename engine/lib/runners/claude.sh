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
  # Каталога нет (см. runner_claude_catalog), поэтому семейство уходит прямо в `--model`:
  # список обязан совпадать с алиасами установленного CLI. Fable добавлен по 2.1.220,
  # где `--model fable` резолвится самим CLI наравне с opus и sonnet.
  case "${1:-}" in opus|fable|sonnet|haiku) return 0 ;; *) return 4 ;; esac
}

runner_claude_capabilities() {
  # status_request обязателен: текущий Claude CLI не наследует fd 7 в тул-шелл;
  # fd-транспорт остаётся быстрым путём там,
  # где он ещё жив, — stage-result сам выбирает доступный.
  printf 'status status_fd status_request sandbox tools structured_output fanout\n'
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
  # -k: голый timeout шлёт только TERM и уходит. Провайдер, застрявший в необрываемом
  # вызове, пережил бы его и остался висеть с занятым слотом; KILL через 30 с закрывает
  # эту дыру. Код возврата остаётся 124 (GNU timeout не меняет его из-за KILL), поэтому
  # классификация timeout в runner_claude_classify работает как прежде.
  factory_exec provider timeout -k 30 "$timeout_s" "${args[@]}"
}

_runner_fixture_meta() {
  local run_dir=$1 key=$2
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' \
    "$run_dir/meta.env" 2>/dev/null
}

_runner_claude_no_model_activity() {
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
        # Повреждённый stream не доказывает, что до 401/403 ничего не случилось.
        raise SystemExit(1)
    if event.get("type") == "assistant":
        message = event.get("message") or {}
        model = message.get("model")
        content = message.get("content") or []
        if model and model != "<synthetic>":
            raise SystemExit(1)
        if any(isinstance(block, dict) and block.get("type") == "tool_use"
               for block in content):
            raise SystemExit(1)
    if event.get("type") == "user":
        content = (event.get("message") or {}).get("content") or []
        if any(isinstance(block, dict) and block.get("type") == "tool_result"
               for block in content):
            raise SystemExit(1)
raise SystemExit(0)
PYTHON
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
  # Любая новая сигнатура допускается только из runtime или проверенной fixture.
  # Непроверенный текст «usage limit» остаётся unknown и никогда не меняет ИИ.
  if [[ "$verified" != 1 && "$source_kind" != runtime ]]; then
    printf 'unknown\n'
    return
  fi
  if grep -qiE -e 'API Error:[[:space:]]*413' -e 'status["=: ]+413' \
      -e 'request too large' -e 'context[_ -]length[_ -]exceeded' \
      -e 'context window.*exceed' -e 'prompt is too long' \
      "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    printf 'context_overflow\n'
    return
  fi
  if grep -qiE \
      -e '"type":"subscription_limit_reached"' \
      -e '"type":"rate_limit_event".*"status":"rejected".*"rateLimitType":"seven_day"' \
      -e '429.*(weekly|subscription|usage).*(limit|reached)' \
      -e '(weekly|subscription|usage).*limit.*(reached|reset)' \
      "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    printf 'limited\n'
    return
  fi
  if grep -qiE -e 'API Error:[[:space:]]*429' -e 'status["=: ]+429' \
      -e '"type":"rate_limit_error"' -e 'too many requests' \
      "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    printf 'transient\n'
    return
  fi
  if grep -qiE -e 'API Error:[[:space:]]*(401|403)' \
      -e 'status["=: ]+(401|403)' -e 'invalid authentication credentials' \
      -e 'authentication.*(expired|required)' -e 'request not allowed' \
      -e 'run claude login' \
      "$run_dir/stderr.log" "$run_dir/events.jsonl" 2>/dev/null; then
    if _runner_claude_no_model_activity "$run_dir"; then
      printf 'provider_unavailable\n'
      return
    fi
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
