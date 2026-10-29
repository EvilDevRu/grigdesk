#!/usr/bin/env bash
# Настоящий goto с CAS и resume доводит окончательный текст до fake runner в его prompt.
# Проверяется именно доставка, а не только argv серверного вызова.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_TESTS_HOME/fixtures/route-loop-launcher.sh"

export FACTORY_CONTROL_ROOT="$control"
export FACTORY_ROUTE_STATE_DIR="$state"
export ARBITER_CAPTURE_PROMPT="$TEST_ROOT/received-prompt.txt"
export ARBITER_CAPTURE_NOTE="$TEST_ROOT/received-note.txt"
source "$FACTORY_HOME/lib/route-runtime.sh"
write_profile 2

# Подмена принадлежит этой фикстуре; живые исполнители не используются.
python3 - "$FACTORY_RUNNERS_DIR/alpha.sh" <<'PY'
from pathlib import Path
import sys

file = Path(sys.argv[1])
source = file.read_text()
source = source.replace('runner_alpha_run() {', '''runner_alpha_run() {
  printf '%s' "$2" >"$ARBITER_CAPTURE_PROMPT"
  printf '%s' "${FACTORY_STAGE_HUMAN_NOTE:-}" >"$ARBITER_CAPTURE_NOTE"''', 1)
file.write_text(source)
PY

printf '%s\n' 'REVIEW|failed|human|decision=Нужно указание человека|' >"$LOOP_SCRIPT"
launch "$TEST_ROOT/start.log" start --profile demo-profile --route plain \
  --ticket-json "$TEST_ROOT/ticket.json"
assert_rc 0 "$?" 'исходная остановка получена настоящим dispatcher'
attempt=$(registry_value ATTEMPT_ID)
cursor=$(attempt_stage_state_read_v2 "$task" "$attempt")
sequence=$(jq -r .eventSequence <<<"$cursor")
head=$(jq -r .headEventHash <<<"$cursor")
instruction=$("$NODE_BIN" -e 'process.stdout.write("Окончательное указание человека.\n" + "Проверь весь журнал и сохрани вывод. ".repeat(350))')

launch "$TEST_ROOT/goto.log" goto --profile demo-profile --attempt "$attempt" \
  --node review --reason "$instruction" --expected-stage "$sequence:$head"
assert_rc 0 "$?" 'goto с exact expected-stage принят'
printf '%s\n' 'REVIEW|done|||' >"$LOOP_SCRIPT"
launch "$TEST_ROOT/resume.log" resume --profile demo-profile --attempt "$attempt"
assert_rc 0 "$?" 'resume выполняет выбранный узел'
assert_eq "$instruction" "$(cat "$ARBITER_CAPTURE_NOTE")" 'FACTORY_STAGE_HUMAN_NOTE содержит полный окончательный текст'
quoted_instruction=$(printf '%s' "$instruction" | sed 's/^/> /')
assert_contains "$(cat "$ARBITER_CAPTURE_PROMPT")" "$quoted_instruction" \
  'полный текст включён в реальный prompt runner как цитата человека'
assert_eq waiting "$(registry_value GATE_ACCEPT)" 'повторённый узел завершился и дошёл до ворот'
finish_tests
