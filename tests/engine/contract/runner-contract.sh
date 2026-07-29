#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

missing=0
for file in lib/runners/index.sh lib/runner-launcher.sh lib/runner-bridge.sh; do
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

runner_registry_reset
runner_registry_add fake "$FACTORY_TESTS_HOME/fakes/runners/fake.sh"
assert_rc 0 "$?" "reference fake registers"

runner_contract_check fake
assert_rc 0 "$?" "reference fake passes common contract"

bad_module="$TEST_ROOT/bad-runner.sh"
printf 'runner_bad_probe() { :; }\n' >"$bad_module"
runner_registry_add bad "$bad_module"
runner_contract_check bad >/dev/null 2>&1
assert_rc 1 "$?" "incomplete runner fails conformance"

run_dir="$STATE_DIR/logs/runs/t42/CHECK/run-1"
status_token="runner-contract-secret"
export FACTORY_RUNNER_VERSION=fixture-1.0
runner_launch fake 42 "hello" CHECK fake-model high 5 "$run_dir" run-1 1 "$status_token"
rc=$?
assert_rc 0 "$rc" "launcher returns runner rc"
assert_file_exists "$run_dir/events.jsonl" "launcher creates events log"
assert_file_exists "$run_dir/stderr.log" "launcher creates stderr log"
assert_file_exists "$run_dir/last.md" "runner writes final response"
assert_file_exists "$run_dir/meta.env" "launcher writes run metadata"

events=$(cat "$run_dir/events.jsonl")
assert_contains "$events" '"event":"status_fd","ok":true' "status FD reaches tool subprocess"
assert_contains "$events" '"event":"fake.completed"' "runner events stay in run directory"

pid=$(awk -F= '$1=="PID"{print $2}' "$run_dir/meta.env")
pgid=$(awk -F= '$1=="PGID"{print $2}' "$run_dir/meta.env")
starttime=$(awk -F= '$1=="STARTTIME"{print $2}' "$run_dir/meta.env")
runner_version=$(awk -F= '$1=="CLI_VERSION"{print $2}' "$run_dir/meta.env")
[[ "$pid" =~ ^[0-9]+$ ]] && test_ok "launcher records pid" || test_fail "launcher records pid" "$pid"
[[ "$pgid" =~ ^[0-9]+$ && "$pgid" != "$$" ]] \
  && test_ok "runner gets separate process group" \
  || test_fail "runner gets separate process group" "pgid=$pgid harness=$$"
[[ "$starttime" =~ ^[0-9]+$ ]] \
  && test_ok "launcher records process starttime" \
  || test_fail "launcher records process starttime" "$starttime"
assert_eq fixture-1.0 "$runner_version" "launcher records classifier-compatible CLI version"

if rg -F "$status_token" "$run_dir" >/dev/null 2>&1; then
  test_fail "status capability is absent from run artifacts" "token leaked into RUN_DIR"
else
  test_ok "status capability is absent from run artifacts"
fi

kill -0 "$pid" 2>/dev/null
assert_rc 1 "$?" "foreground runner is reaped before launcher returns"

# Обычный `factory N resume` из терминала не обязан заранее экспортировать
# FACTORY_CONFIG_ROOT. Launcher должен получить безопасный персональный default,
# а не падать до запуска provider с `parameter null or not set`.
saved_config_root=$FACTORY_CONFIG_ROOT
saved_home=${HOME:-}
unset FACTORY_CONFIG_ROOT FACTORY_CONTROL_ROOT
export HOME="$TEST_ROOT/home"
fallback_run_dir="$STATE_DIR/logs/runs/t42/CHECK/run-home-default"
runner_launch fake 42 "hello" CHECK fake-model high 5 \
  "$fallback_run_dir" run-home-default 2 "$status_token"
rc=$?
assert_rc 0 "$rc" "launcher works with the default per-user config root"
[[ -d "$HOME/.factory/config/control/tokens" ]] \
  && test_ok "launcher default keeps control data under the config root" \
  || test_fail "launcher default keeps control data under the config root"
export FACTORY_CONFIG_ROOT=$saved_config_root
export HOME=$saved_home

# Ошибка до снятия launch barrier не должна навечно оставить stopped-child:
# TERM остаётся pending у процесса в состоянии T и обычный wait() зависает.
bash -c 'trap "exit 0" TERM; kill -STOP "$$"; while :; do sleep 1; done' &
barrier_pid=$!
for _poll in {1..100}; do
  [[ "$(awk '{print $3}' "/proc/$barrier_pid/stat" 2>/dev/null)" == T ]] && break
  sleep 0.01
done
if declare -F _runner_terminate_barrier_child >/dev/null; then
  _runner_terminate_barrier_child "$barrier_pid"
  kill -0 "$barrier_pid" 2>/dev/null
  assert_rc 1 "$?" "launcher termination releases and reaps a stopped barrier child"
else
  test_fail "launcher termination releases and reaps a stopped barrier child" \
    "missing _runner_terminate_barrier_child"
  kill -KILL "$barrier_pid" 2>/dev/null || true
  wait "$barrier_pid" 2>/dev/null || true
fi

finish_tests
