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

# setsid отделяет процесс не мгновенно: между fork и exec он ещё в группе и
# сессии самого теста, и его «identity» — это identity теста. Сигналы ушли бы
# по своей группе: движок отвечал 73 «чужая группа не подтверждена», а прямой
# `kill -KILL -- -pgid` ниже по файлу убивал сам прогон. Под нагрузкой это
# ловилось стабильно. Ждём ровно того состояния, ради которого процесс и
# запускали: он лидер собственной группы и сессии.
wait_own_session() {
  local pid=$1 identity pgid session starttime state ppid
  for _ in {1..500}; do
    identity=$(_runner_process_full_identity "$pid" 2>/dev/null || true)
    if [[ -n "$identity" ]]; then
      read -r pgid session starttime state ppid <<<"$identity"
      if [[ "$pgid" == "$pid" && "$session" == "$pid" ]]; then
        printf '%s %s\n' "$pgid" "$starttime"
        return 0
      fi
    fi
    sleep 0.01
  done
  return 1
}

setsid bash -c 'trap "exit 0" TERM; while :; do sleep 1; done' &
child=$!
identity=$(wait_own_session "$child") ||
  test_fail "TERM stops verified separate process group" \
    "фоновый процесс $child не стал лидером своей сессии"
read -r pgid starttime <<<"$identity"
runtime_interrupt_and_wait "$child" "$pgid" "$starttime" 1
assert_rc 0 "$?" "TERM stops verified separate process group"
kill -0 "$child" 2>/dev/null
assert_rc 1 "$?" "interrupted runner is reaped"

setsid bash -c 'trap "" TERM; while :; do sleep 1; done' &
stubborn=$!
identity=$(wait_own_session "$stubborn") ||
  test_fail "stubborn runner is killed after grace" \
    "фоновый процесс $stubborn не стал лидером своей сессии"
read -r stubborn_pgid stubborn_start <<<"$identity"
runtime_interrupt_and_wait "$stubborn" "$stubborn_pgid" "$stubborn_start" 0
assert_rc 0 "$?" "stubborn runner is killed after grace"
kill -0 "$stubborn" 2>/dev/null
assert_rc 1 "$?" "KILLed runner is reaped"

# GNU timeout ставит провайдеру СВОЮ группу процессов внутри сессии setsid-моста,
# поэтому «группа лидера пуста» никогда не было
# доказательством тишины — дерево агента (claude + MCP + docker) пережило TERM,
# а launcher уже снял trusted identity. Граница остановки — сессия.
leaked_file="$TEST_ROOT/leaked-group.pid"
cat >"$TEST_ROOT/leaky-bridge.sh" <<EOF
set -m
bash -c 'trap "" TERM; while :; do sleep 1; done' &
printf '%s\n' "\$!" >"$leaked_file"
set +m
trap 'exit 0' TERM
while :; do sleep 1; done
EOF
setsid bash "$TEST_ROOT/leaky-bridge.sh" &
leaky=$!
leaked=""
for _ in {1..200}; do
  [[ -s "$leaked_file" ]] && read -r leaked <"$leaked_file" && break
  sleep 0.01
done
identity=$(wait_own_session "$leaky") ||
  test_fail "quiescence covers every group of the runner session" \
    "мост $leaky не стал лидером своей сессии"
read -r leaky_pgid leaky_start <<<"$identity"
leaked_pgid=$(ps -o pgid= -p "$leaked" 2>/dev/null | tr -d ' ')
[[ "$leaked" =~ ^[0-9]+$ && -n "$leaked_pgid" && "$leaked_pgid" != "$leaky_pgid" ]] \
  && test_ok "provider lives in its own process group inside the runner session" \
  || test_fail "provider lives in its own process group inside the runner session" \
    "leaked=$leaked pgid=$leaked_pgid bridge_pgid=$leaky_pgid"
runtime_interrupt_and_wait "$leaky" "$leaky_pgid" "$leaky_start" 1
assert_rc 0 "$?" "quiescence covers every group of the runner session"
kill -0 "$leaked" 2>/dev/null
assert_rc 1 "$?" "a provider group outside the leader group is not left orphaned"

own_session=$(ps -o sess= -p $$ 2>/dev/null | tr -d ' ')
_runner_quiesce_owned_runtime "$$" "$$" "$own_session" 1 0
assert_rc 2 "$?" "quiescence refuses to signal its own session"

setsid bash -c 'while :; do sleep 1; done' &
untouched=$!
identity=$(wait_own_session "$untouched") ||
  test_fail "mismatched starttime sends no signal" \
    "фоновый процесс $untouched не стал лидером своей сессии"
read -r untouched_pgid untouched_start <<<"$identity"
runtime_interrupt_and_wait "$untouched" "$untouched_pgid" "$((untouched_start + 1))" 0
assert_rc 73 "$?" "mismatched starttime sends no signal"
kill -0 "$untouched" 2>/dev/null
assert_rc 0 "$?" "stale identity leaves unrelated process alive"
kill -KILL -- "-$untouched_pgid" 2>/dev/null || true
wait "$untouched" 2>/dev/null || true

finish_tests
