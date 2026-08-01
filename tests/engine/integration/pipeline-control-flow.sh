#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

PROFILE_NAME=fixture
PROFILE_CTX=fixture
profile_sandbox_exists() { printf 'ready\n'; }
profile_sandbox_up() { :; }

source "$FACTORY_HOME/lib/core.sh"

PROFILE_ROUTE_STAGES_trivial=(SCOUT BUILD)
PROFILE_ROUTE_STAGES_feature=(SCOUT PLAN BUILD REVIEW)

# Имитируем контракт run_stage без вызова модели: первый BUILD меняет маршрут и
# сообщает управляющий исход rc=2, остальные этапы завершаются штатно.
run_stage() {
  local task=$1 stage=$2 route
  route=$(get "$task" ROUTE)
  printf '%s:%s\n' "$stage" "$route" >>"$TEST_ROOT/route-events"
  if [[ "$stage" == BUILD && "$route" == trivial ]]; then
    set_st "$task" ROUTE feature ROUTE_BY escalation
    return 2
  fi
  set_st "$task" "$stage" done
}

: >"$TEST_ROOT/route-events"
set_st 81 --init PROFILE fixture ROUTE trivial SCOUT done
run_pipeline 81 >"$TEST_ROOT/route-switch.out" 2>&1
assert_rc 0 "$?" "route change rebuilds the pipeline instead of stopping on rc=2"
assert_eq feature "$(get 81 ROUTE)" "escalated route remains selected"
assert_eq $'BUILD:trivial\nPLAN:feature\nBUILD:feature\nREVIEW:feature' \
  "$(cat "$TEST_ROOT/route-events")" \
  "new route is reread from its first incomplete stage"
assert_eq done "$(get 81 PLAN)" "new route planning stage completes"
assert_eq done "$(get 81 REVIEW)" "new route tail completes"
assert_contains "$(cat "$STATE_DIR/logs/t81.stages.log")" \
  "маршрут эскалирован: trivial → feature" \
  "route rebuild is visible in the orchestration log"

# Чужой процесс держит orchestration lock. Ветка lock-busy обязана отличаться
# от успешного завершения и не должна публиковать ORCH_PID.
lock="$STATE_DIR/t82.orch.lock"
ready="$TEST_ROOT/lock-ready"
release="$TEST_ROOT/lock-release"
mkfifo "$release"
(
  exec 8>"$lock"
  flock 8
  : >"$ready"
  read -r _ <"$release"
) &
holder=$!
for _poll in {1..200}; do
  [[ -f "$ready" ]] && break
  kill -0 "$holder" 2>/dev/null || break
  sleep 0.01
done
if [[ ! -f "$ready" ]]; then
  test_fail "lock holder starts" "fixture did not acquire orchestration lock"
else
  test_ok "lock holder starts"
fi

set_st 82 --init PROFILE fixture ROUTE trivial SCOUT done
run_pipeline 82 >"$TEST_ROOT/lock-busy.out" 2>&1
lock_rc=$?
printf 'release\n' >"$release"
wait "$holder"

if (( lock_rc == 0 )); then
  test_fail "busy orchestration lock returns a failure" "run_pipeline returned success"
else
  test_ok "busy orchestration lock returns a failure"
fi
assert_contains "$(cat "$TEST_ROOT/lock-busy.out")" \
  "оркестратор t82 уже держит лок" \
  "lock conflict remains diagnosable"
assert_eq "" "$(get 82 ORCH_PID)" \
  "lock conflict does not claim orchestration ownership"

finish_tests
