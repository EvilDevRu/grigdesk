#!/usr/bin/env bash
# Отдельная страховка для других дорог в stopped: голый resume после skipped
# пока не двигает курсор, но отказ открытия human lifecycle должен объяснять причину.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_TESTS_HOME/fixtures/route-loop-launcher.sh"

write_profile 2
printf '%s\n' 'REVIEW|skipped|||' >"$LOOP_SCRIPT"
launch "$TEST_ROOT/start.log" start --profile demo-profile --route loop \
  --ticket-json "$TEST_ROOT/ticket.json"
assert_rc 0 "$?" 'skipped: маршрут создал остановку human'
attempt=$(registry_value ATTEMPT_ID)
launch "$TEST_ROOT/resume.log" resume --profile demo-profile --attempt "$attempt"
assert_rc 78 "$?" 'skipped: прежний отказ resume не подменяется удержанием failed'
assert_contains "$(cat "$state/logs/t${task}.stages.log")" 'нет визита узла' \
  'lifecycle объясняет отсутствие визита'
assert_contains "$(cat "$state/logs/t${task}.stages.log")" \
  'lifecycle вмешательства человека не открыт (код 78)' 'ветка 21 называет отказ lifecycle'

finish_tests
