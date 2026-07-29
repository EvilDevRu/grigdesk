#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

missing=0
for file in lib/runtime-switch.sh lib/run-state.sh lib/runner-launcher.sh; do
  if [[ ! -f "$FACTORY_HOME/$file" ]]; then
    test_fail "$file exists" "missing $file"
    missing=1
  fi
done
if (( missing )); then
  finish_tests
  exit $?
fi
source "$FACTORY_HOME/lib/runners/index.sh"
source "$FACTORY_HOME/lib/runner-launcher.sh"
source "$FACTORY_HOME/lib/run-state.sh"
source "$FACTORY_HOME/lib/runtime-switch.sh"

task=88
stage=BUILD
bash "$FACTORY_HOME/lib/pipeline-set.sh" "$task" --init "$stage" pending >/dev/null
run_state_begin "$task" "$stage" run-a 1 token-a

runtime_switch_request "$task" "$stage" run-old 0 codex request-old
assert_rc 73 "$?" "switch for stale run is rejected"

runtime_switch_request "$task" "$stage" run-a 1 codex request-a
assert_rc 0 "$?" "switch request CAS accepts active run"
runtime_switch_request "$task" "$stage" run-a 1 claude request-b
assert_rc 76 "$?" "second concurrent switch conflicts"

target=$(runtime_switch_consume "$task" "$stage" run-a 1 request-a)
assert_eq codex "$target" "matching request is consumed once"
runtime_switch_consume "$task" "$stage" run-a 1 request-a >/dev/null
assert_rc 75 "$?" "consumed request cannot replay"

task_done=89
bash "$FACTORY_HOME/lib/pipeline-set.sh" "$task_done" --init "$stage" pending >/dev/null
run_state_begin "$task_done" "$stage" run-done 1 token-done
runtime_switch_request "$task_done" "$stage" run-done 1 codex request-done
run_state_apply_result "$task_done" "$stage" run-done 1 token-done done
runtime_switch_consume "$task_done" "$stage" run-done 1 request-done >/dev/null
assert_rc 73 "$?" "stage completed before switch CAS is never restarted"

setsid bash -c 'trap "exit 0" TERM; while :; do sleep 1; done' &
child=$!
identity=""
for _ in {1..100}; do
  identity=$(_runner_process_identity "$child") && break
  sleep 0.01
done
read -r pgid starttime <<<"$identity"
runtime_interrupt_and_wait "$child" "$pgid" "$starttime" 1
assert_rc 0 "$?" "TERM stops verified separate process group"
kill -0 "$child" 2>/dev/null
assert_rc 1 "$?" "interrupted runner is reaped"

setsid bash -c 'trap "" TERM; while :; do sleep 1; done' &
stubborn=$!
identity=""
for _ in {1..100}; do
  identity=$(_runner_process_identity "$stubborn") && break
  sleep 0.01
done
read -r stubborn_pgid stubborn_start <<<"$identity"
runtime_interrupt_and_wait "$stubborn" "$stubborn_pgid" "$stubborn_start" 0
assert_rc 0 "$?" "stubborn runner is killed after grace"
kill -0 "$stubborn" 2>/dev/null
assert_rc 1 "$?" "KILLed runner is reaped"

setsid bash -c 'while :; do sleep 1; done' &
untouched=$!
identity=$(_runner_process_identity "$untouched")
read -r untouched_pgid untouched_start <<<"$identity"
runtime_interrupt_and_wait "$untouched" "$untouched_pgid" "$((untouched_start + 1))" 0
assert_rc 73 "$?" "mismatched starttime sends no signal"
kill -0 "$untouched" 2>/dev/null
assert_rc 0 "$?" "stale identity leaves unrelated process alive"
kill -KILL -- "-$untouched_pgid" 2>/dev/null || true
wait "$untouched" 2>/dev/null || true

finish_tests
