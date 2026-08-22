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
source "$FACTORY_HOME/lib/runtime-switch.sh"

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

# Провайдер владеет своим run-каталогом и может подменить имя пути, пока launcher ещё
# держит исходные безопасно открытые дескрипторы. Это должно быть явной ошибкой хоста
# даже при нулевом коде провайдера: иначе успешный продуктовый результат обойдёт
# обязательное запечатывание источника.
tamper_module="$TEST_ROOT/source-tamper-runner.sh"
printf '%s\n' \
  'runner_tamper_probe() { printf "ready\n"; }' \
  'runner_tamper_catalog() { printf "fake-model\ttamper\tfixture\t1\tdefault\t1\t1\t0\t1\t0.0.0\t999.0.0\n"; }' \
  'runner_tamper_capabilities() { printf "status status_fd foreground structured_output\n"; }' \
  'runner_tamper_run() {' \
  '  local run_dir=$7' \
  '  rm -f -- "$run_dir/events.jsonl"' \
  '  : >"$run_dir/events.jsonl"' \
  '  chmod 600 -- "$run_dir/events.jsonl"' \
  '  printf "{\"event\":\"retained-source\"}\n"' \
  '  : >"$run_dir/provider-finished"' \
  '}' \
  'runner_tamper_classify() { printf "ok\n"; }' \
  'runner_tamper_fanout_count() { printf "0\n"; }' \
  'runner_tamper_dialect() { printf "fixture\n"; }' \
  'runner_tamper_interrupt() { return 0; }' >"$tamper_module"
runner_registry_add tamper "$tamper_module"
tamper_run_dir="$STATE_DIR/logs/runs/t44/CHECK/run-source-tamper"
runner_launch tamper 44 "tamper" CHECK fake-model high 5 \
  "$tamper_run_dir" run-source-tamper 1 "$status_token" >/dev/null 2>&1
assert_rc 76 "$?" "source identity failure overrides a zero provider exit"
assert_file_exists "$tamper_run_dir/provider-finished" \
  "source identity failure is detected after provider completion"
if rg -F retained-source "$tamper_run_dir/events.jsonl" >/dev/null 2>&1; then
  test_fail "replaced provider path never substitutes for the retained source"
else
  test_ok "replaced provider path never substitutes for the retained source"
fi

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

# Расширяем окно между fork и барьером доверенной инициализацией модуля, затем
# посылаем запускателю сигнал внутри этого окна. Сигнал должен быть воспроизведён
# только после появления точной идентичности в корне управления; код провайдера
# не должен пересечь барьер.
slow_module="$TEST_ROOT/slow-barrier-runner.sh"
printf '%s\n' \
  'if [[ "${FACTORY_LAUNCH_BARRIER:-0}" == 1 ]]; then' \
  '  : >"${TEST_ROOT:?}/slow-barrier-sourced"' \
  '  sleep 0.2' \
  'fi' \
  'runner_slowbarrier_probe() { printf "ready\n"; }' \
  'runner_slowbarrier_catalog() { printf "fake-model\tslowbarrier\tfixture\t1\tdefault\t1\t1\t0\t1\t0.0.0\t999.0.0\n"; }' \
  'runner_slowbarrier_capabilities() { printf "status status_fd foreground structured_output\n"; }' \
  'runner_slowbarrier_run() { : >"${TEST_ROOT:?}/slow-barrier-ran"; }' \
  'runner_slowbarrier_classify() { printf "unknown\n"; }' \
  'runner_slowbarrier_fanout_count() { printf "0\n"; }' \
  'runner_slowbarrier_dialect() { printf "fixture\n"; }' \
  'runner_slowbarrier_interrupt() { return 0; }' >"$slow_module"
runner_registry_add slowbarrier "$slow_module"

barrier_signal_handler() {
  local trusted_rc
  runner_trusted_identity_read 43 CHECK run-signal 1 \
    >"$TEST_ROOT/signal-trusted-record"
  trusted_rc=$?
  printf '%s\n' "$trusted_rc" >"$TEST_ROOT/signal-trusted-rc"
  (( trusted_rc == 0 )) || return "$trusted_rc"
  runtime_interrupt_trusted_active 43 CHECK run-signal 1 0
}
trap barrier_signal_handler TERM
test_shell_pid=$BASHPID
(
  for _poll in {1..100}; do
    [[ -f "$TEST_ROOT/slow-barrier-sourced" ]] && break
    sleep 0.01
  done
  kill -TERM "$test_shell_pid"
) &
signal_sender=$!
signal_run_dir="$STATE_DIR/logs/runs/t43/CHECK/run-signal"
runner_launch slowbarrier 43 "signal" CHECK fake-model high 5 \
  "$signal_run_dir" run-signal 1 "$status_token" >/dev/null 2>&1
wait "$signal_sender" 2>/dev/null || true
trap - TERM
assert_eq 0 "$(cat "$TEST_ROOT/signal-trusted-rc")" \
  "deferred launch signal observes trusted identity before replay"
assert_file_missing "$TEST_ROOT/slow-barrier-ran" \
  "deferred signal stops the runner before provider code crosses the barrier"
assert_file_missing "$(runner_trusted_identity_file 43)" \
  "deferred signal retires the exact identity after PGID quiescence"
assert_eq idle "$RUNNER_LAUNCH_STATE" \
  "launcher leaves the signal critical section in a quiescent state"

# В каждую долговечную границу после fork и до SIGCONT можно инъецировать сбой.
# Удерживаемый потомок должен быть собран, trusted-идентичность снята, а код провайдера
# не должен создать первый артефакт независимо от того, какая публикация хоста упала.
fault_ordinal=0
for fault_point in after_held_identity after_identity_publish after_runner_started after_lineage_started; do
  fault_ordinal=$((fault_ordinal + 1))
  fault_task=$((60 + fault_ordinal))
  fault_run="run-fault-$fault_ordinal"
  fault_dir="$STATE_DIR/logs/runs/t${fault_task}/CHECK/$fault_run"
  export FACTORY_RUNNER_LAUNCH_FAULT=$fault_point
  runner_launch fake "$fault_task" "must-not-run" CHECK fake-model high 5 \
    "$fault_dir" "$fault_run" 1 "$status_token" >/dev/null 2>&1
  fault_rc=$?
  unset FACTORY_RUNNER_LAUNCH_FAULT
  assert_rc 91 "$fault_rc" "$fault_point aborts at its exact post-fork boundary"
  assert_file_missing "$fault_dir/last.md" \
    "$fault_point keeps provider code behind SIGSTOP"
  assert_file_missing "$(runner_trusted_identity_file "$fault_task")" \
    "$fault_point retires any published trusted identity"
  assert_eq idle "$RUNNER_LAUNCH_STATE" \
    "$fault_point leaves launcher state quiescent"
  if [[ -f "$fault_dir/meta.env" ]]; then
    fault_pid=$(awk -F= '$1=="PID"{print $2}' "$fault_dir/meta.env")
    kill -0 "$fault_pid" 2>/dev/null
    assert_rc 1 "$?" "$fault_point reaps the held process session"
  else
    test_ok "$fault_point reaps before a diagnostic meta mirror exists"
  fi
done

# Воспроизводим непосредственно окно восстановления: восстановление TERM само
# отправляет INT, пока INT ещё указывает на временный trap отложенного сигнала.
# Helper должен прочитать слот после восстановления обоих обработчиков и повторить сигнал.
late_restore_handler() {
  printf 'replayed\n' >"$TEST_ROOT/late-restore-signal"
}
trap late_restore_handler INT
saved_int=$(trap -p INT)
trap 'RUNNER_LAUNCH_DEFERRED_SIGNAL=${RUNNER_LAUNCH_DEFERRED_SIGNAL:-INT}' INT
RUNNER_LAUNCH_DEFERRED_SIGNAL=""
_runner_launch_restore_signal_traps \
  "trap - TERM; kill -INT $BASHPID" "$saved_int"
assert_eq replayed "$(tr -d '\n' <"$TEST_ROOT/late-restore-signal")" \
  "late signal in trap-restore seam is replayed instead of erased"
trap - INT

finish_tests
