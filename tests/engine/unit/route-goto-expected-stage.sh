#!/usr/bin/env bash
# CAS проверяется настоящим stage-state helper под его task lock.
# Два решения одного head не могут дописать два human-rewind.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/attempt-stage-state.sh"

routes_dir="$TEST_ROOT/routes"
"$NODE_BIN" "$FACTORY_TESTS_HOME/fixtures/routes-publish.mjs" "$routes_dir" 'Expected stage' null >/dev/null
attempt=$(attempt_state_begin_v2 51 demo-profile "$routes_dir")
attempt_state_select_route_v2 51 "$attempt" debug >/dev/null
initial=$(attempt_stage_state_init_v2 51 "$attempt" debug)
head=$("$NODE_BIN" -e 'process.stdout.write(JSON.parse(process.argv[1]).headEventHash)' "$initial")
dir="$(attempt_state_v2_task_root 51)/attempts/$attempt/stage-results"

attempt_stage_state_human_rewind_v2 51 "$attempt" instrument instrument 'Первое решение' human 0 "$head" >/dev/null
assert_rc 0 "$?" 'совпавший head принимает решение'
before=$(find "$dir" -name 'event.*.json' | wc -l)
attempt_stage_state_human_rewind_v2 51 "$attempt" instrument instrument 'Устаревшее решение' human 0 "$head" >/dev/null 2>&1
assert_rc 75 "$?" 'устаревший head отклонён под lock'
assert_eq "$before" "$(find "$dir" -name 'event.*.json' | wc -l)" 'отказ CAS не добавляет событий'

current=$(attempt_stage_state_read_v2 51 "$attempt")
sequence=$("$NODE_BIN" -e 'process.stdout.write(String(JSON.parse(process.argv[1]).eventSequence))' "$current")
head=$("$NODE_BIN" -e 'process.stdout.write(JSON.parse(process.argv[1]).headEventHash)' "$current")
attempt_stage_state_human_rewind_v2 51 "$attempt" instrument instrument 'Решение А' human "$sequence" "$head" >"$TEST_ROOT/a" 2>&1 &
first=$!
attempt_stage_state_human_rewind_v2 51 "$attempt" instrument instrument 'Решение Б' human "$sequence" "$head" >"$TEST_ROOT/b" 2>&1 &
second=$!
wait "$first"
first_rc=$?
wait "$second"
second_rc=$?
assert_eq 75 "$(( first_rc + second_rc ))" 'два конкурентных решения дают один эффект и один stale'
attempt_stage_state_human_rewind_v2 51 "$attempt" instrument instrument 'Старый CLI' >/dev/null
assert_rc 0 "$?" 'вызов без expected-stage сохраняет прежний контракт'

"$FACTORY_HOME/bin/factory" capabilities --format json >"$TEST_ROOT/capabilities"
assert_rc 0 "$?" 'capabilities не требует профиль или состояние'
assert_contains "$(cat "$TEST_ROOT/capabilities")" 'goto-expected-stage-v1' 'capabilities объявляет CAS goto'
finish_tests
