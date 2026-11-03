#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/pipeline-store.sh"
source "$FACTORY_HOME/lib/run-state.sh"
source "$FACTORY_HOME/lib/runners/index.sh"
source "$FACTORY_HOME/lib/runner-launcher.sh"
source "$FACTORY_HOME/lib/runtime-switch.sh"

fixture="$TEST_ROOT/browser-fixture"
mkdir -p "$fixture/routes"
export GRIGDESK_BROWSER_NODE="$NODE_BIN"
export GRIGDESK_BROWSER_HELPER="$fixture/helper.cjs"
export GRIGDESK_BROWSER_RELAY_SOCKET="$fixture/broker.sock"
export ROUTE_V2_ROUTES_DIR="$fixture/routes"
export FACTORY_ROUTE_BROWSER_POLICY=allow
export FACTORY_LIFECYCLE_ATTEMPT_ID=a_11111111111111111111111111111111
export BROWSER_FIXTURE_TRACE="$fixture/trace"
export BROWSER_FIXTURE_MODE=grigdesk

cat >"$GRIGDESK_BROWSER_HELPER" <<'JAVASCRIPT'
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const mode = process.argv[2];
const args = process.argv.slice(3);
const get = (key) => args[args.indexOf(key) + 1];
const directory = process.env.FACTORY_BROWSER_REQUEST_DIR;
const trace = (value) => fs.appendFileSync(process.env.BROWSER_FIXTURE_TRACE, value + '\n');

async function main() {
  if (mode === 'key') {
    if (process.env.BROWSER_FIXTURE_KEY_FAILURE === '1') {
      throw new Error('browser_nonce_invalid');
    }
    process.stdout.write('a'.repeat(64) + '\n');
    return;
  }

  if (mode === 'mode') {
    if (process.env.BROWSER_FIXTURE_MODE_FAILURE === '1') {
      throw new Error('browser_transport_dead');
    }
    process.stdout.write(fs.readFileSync(path.join(directory, 'host.ready'), 'utf8'));
    return;
  }

  if (mode === 'publish-binding' || mode === 'relay' || mode === 'cleanup') {
    const bytes = Buffer.alloc(4098);
    const count = fs.readSync(9, bytes, 0, bytes.length, 0);
    if (count === 0) throw new Error('missing_fd');
  }

  if (mode === 'publish-binding') {
    const counter = path.join(directory, 'publish-attempts');
    const attempts = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
    fs.writeFileSync(counter, String(attempts + 1));
    const failure = process.env.BROWSER_FIXTURE_PUBLISH_FAILURE;
    if (failure === 'invalid') {
      throw new Error('browser_run_invalid');
    }
    if (failure === 'always' || (failure === 'once' && attempts === 0)) {
      throw new Error('browser_run_stale');
    }
    trace('published:' + get('--run-id'));
    fs.writeFileSync(path.join(directory, 'binding'), 'present');
    return;
  }

  if (mode === 'cleanup') {
    fs.rmSync(path.join(directory, 'binding'), { force: true });
    trace('cleanup:' + get('--run-id'));
    return;
  }

  if (mode === 'relay') {
    if (Number(get('--parent-pid')) !== process.ppid) throw new Error('wrong_parent');
    fs.writeFileSync(path.join(directory, 'relay.pid'), String(process.pid));
    if (process.env.BROWSER_FIXTURE_RELAY_FAILURE === 'dead') {
      throw new Error('browser_run_stale');
    }
    if (process.env.BROWSER_FIXTURE_RELAY_FAILURE === 'unready') {
      await delay(30000);
      return;
    }
    fs.writeFileSync(path.join(directory, 'host.ready'), process.env.BROWSER_FIXTURE_MODE + '\n');
    trace('ready:' + get('--run-id'));
    process.on('SIGTERM', () => {
      trace('stopped:' + get('--run-id'));
      process.exit(0);
    });
    const request = path.join(directory, 'request.json');
    while (true) {
      if (fs.existsSync(request)) {
        const input = JSON.parse(fs.readFileSync(request, 'utf8'));
        if (input.action !== 'list') throw new Error('unexpected_action');
        fs.rmSync(request);
        trace('roundtrip:' + get('--run-id'));
        fs.writeFileSync(path.join(directory, 'reply.json'), JSON.stringify({ tabs: [] }));
      }
      await delay(10);
    }
  }

  if (mode === 'request') {
    fs.writeFileSync(path.join(directory, 'request.json'), get('--input-json'));
    for (let poll = 0; poll < 200; poll += 1) {
      const reply = path.join(directory, 'reply.json');
      if (fs.existsSync(reply)) {
        process.stdout.write(fs.readFileSync(reply, 'utf8') + '\n');
        return;
      }
      await delay(10);
    }
    throw new Error('request_timeout');
  }
  throw new Error('unknown_mode');
}
main().catch((error) => {
  process.stderr.write((error.message.startsWith('browser_') ? error.message : 'fixture_failed') + '\n');
  process.exitCode = 1;
});
JAVASCRIPT

module="$fixture/runner.sh"
cat >"$module" <<'BASH'
#!/usr/bin/env bash
source "$FACTORY_TESTS_HOME/fakes/runners/sandboxed.sh"
runner_browserfixture_probe() { runner_sandboxed_probe; }
runner_browserfixture_catalog() { runner_sandboxed_catalog; }
runner_browserfixture_capabilities() { runner_sandboxed_capabilities; }
runner_browserfixture_classify() { runner_sandboxed_classify "$@"; }
runner_browserfixture_fanout_count() { runner_sandboxed_fanout_count; }
runner_browserfixture_dialect() { runner_sandboxed_dialect; }
runner_browserfixture_interrupt() { return 0; }
runner_browserfixture_run() {
  local prompt=$2 run_dir=$7 result
  printf '%s' "$prompt" >"$run_dir/received-prompt"
  if [[ "$BROWSER_FIXTURE_MODE" == grigdesk ]]; then
    [[ "${FACTORY_BROWSER_ENABLED:-0}" == 1 ]] || return 81
    result=$("$GRIGDESK_BROWSER_NODE" "$GRIGDESK_BROWSER_HELPER" request --input-json '{"action":"list"}')
    [[ "$result" == '{"tabs":[]}' ]] || return 82
    printf 'ready\n' >"$run_dir/provider-ready"
  else
    [[ "${FACTORY_BROWSER_ENABLED:-0}" == 0 ]] || return 83
  fi
  if [[ "${BROWSER_FIXTURE_HOLD:-0}" == 1 ]]; then
    sleep 30
  fi
  runner_sandboxed_run "$@"
}
BASH

runner_registry_reset
runner_registry_add browserfixture "$module"
factory_control_init fixture-control
token=fixture-browser-status-secret

# Каждый запуск получает свою status identity; analytics lifecycle остаётся выключен.
# Единственный экспорт attempt нужен prepare, но сам по себе не включает lifecycle.
prepare_case() {
  local task=$1 run=$2
  pipeline_store_route_init "$task" CHECK || return
  run_state_begin "$task" CHECK "$run" 1 "$token"
}

prepare_case 241 run-browser-normal
run_dir="$STATE_DIR/logs/runs/t241/CHECK/run-browser-normal"
( runner_launch browserfixture 241 'original prompt' CHECK sandboxed-model high 5 \
  "$run_dir" run-browser-normal 1 "$token" )
assert_rc 0 "$?" 'browser roundtrip coexists with terminal status'
assert_eq done "$(pipeline_store_get 241 CHECK)" 'stage-result remains authoritative'
assert_eq done "$(pipeline_store_get 241 PLANS)" 'progress remains visible'
assert_contains "$(cat "$run_dir/received-prompt")" '[Браузер GrigDesk]' 'bridge augments prompt'
assert_contains "$(cat "$BROWSER_FIXTURE_TRACE")" 'roundtrip:run-browser-normal' 'provider used live relay'
browser_dir="$run_dir/control-requests/browser"
relay_pid=$(cat "$browser_dir/relay.pid")
kill -0 "$relay_pid" 2>/dev/null
assert_rc 1 "$?" 'normal completion reaps own relay'
assert_file_missing "$browser_dir/binding" 'normal completion removes authority binding'

export BROWSER_FIXTURE_MODE=legacy
prepare_case 242 run-browser-legacy
run_dir="$STATE_DIR/logs/runs/t242/CHECK/run-browser-legacy"
runner_launch browserfixture 242 'legacy exact prompt' CHECK sandboxed-model high 5 \
  "$run_dir" run-browser-legacy 1 "$token"
assert_rc 0 "$?" 'legacy mode preserves status protocol'
assert_eq 'legacy exact prompt' "$(cat "$run_dir/received-prompt")" 'legacy prompt unchanged'
export BROWSER_FIXTURE_MODE=grigdesk

# Отказ до CONT не вызывает adapter и не подменяет его terminal result.
# Небольшой повтор publisher допускает гонку чтения, но всегда сохраняет fail-closed.
failure_task=270
for failure in key publish publish-invalid relay unready retry-unready mode; do
  failure_task=$((failure_task + 1))
  task=$failure_task
  run="run-browser-$failure"
  prepare_case "$task" "$run"
  run_dir="$STATE_DIR/logs/runs/t${task}/CHECK/$run"
  if [[ "$failure" == key ]]; then
    export BROWSER_FIXTURE_KEY_FAILURE=1
  elif [[ "$failure" == publish ]]; then
    export BROWSER_FIXTURE_PUBLISH_FAILURE=always
  elif [[ "$failure" == publish-invalid ]]; then
    export BROWSER_FIXTURE_PUBLISH_FAILURE=invalid
  elif [[ "$failure" == retry-unready ]]; then
    export BROWSER_FIXTURE_PUBLISH_FAILURE=once BROWSER_FIXTURE_RELAY_FAILURE=unready
  elif [[ "$failure" == mode ]]; then
    export BROWSER_FIXTURE_MODE_FAILURE=1
  else
    export BROWSER_FIXTURE_RELAY_FAILURE=$([[ "$failure" == relay ]] && printf dead || printf unready)
  fi
  runner_launch browserfixture "$task" held CHECK sandboxed-model high 5 \
    "$run_dir" "$run" 1 "$token" >/dev/null 2>&1
  assert_rc 79 "$?" "$failure stops launch as infrastructure failure"
  assert_file_missing "$run_dir/received-prompt" "$failure never invokes provider"
  assert_file_missing "$run_dir/control-requests/browser/binding" "$failure removes binding"
  assert_file_missing "$(runner_trusted_identity_file "$task")" "$failure removes held identity"
  if [[ "$failure" == unready || "$failure" == retry-unready || "$failure" == mode ]]; then
    assert_eq browser_transport_dead "$BROWSER_TRANSPORT_ERROR" 'missing ready has named cause'
  elif [[ "$failure" == key ]]; then
    assert_eq browser_nonce_invalid "$BROWSER_TRANSPORT_ERROR" 'key failure preserves helper cause'
  elif [[ "$failure" == publish-invalid ]]; then
    assert_eq browser_run_invalid "$BROWSER_TRANSPORT_ERROR" 'invalid publisher preserves helper cause'
    assert_eq 1 "$(cat "$run_dir/control-requests/browser/publish-attempts")" \
      'non-stale publisher failure is not retried'
  else
    assert_eq browser_run_stale "$BROWSER_TRANSPORT_ERROR" "$failure preserves relay cause"
  fi
  if [[ "$failure" == publish ]]; then
    assert_eq 3 "$(cat "$run_dir/control-requests/browser/publish-attempts")" \
      'persistent stale stops after three publisher attempts'
  fi
  unset BROWSER_FIXTURE_PUBLISH_FAILURE BROWSER_FIXTURE_RELAY_FAILURE BROWSER_FIXTURE_KEY_FAILURE
  unset BROWSER_FIXTURE_MODE_FAILURE
done

prepare_case 280 run-browser-publish-retry
run_dir="$STATE_DIR/logs/runs/t280/CHECK/run-browser-publish-retry"
export BROWSER_FIXTURE_PUBLISH_FAILURE=once
runner_launch browserfixture 280 retry CHECK sandboxed-model high 5 \
  "$run_dir" run-browser-publish-retry 1 "$token"
assert_rc 0 "$?" 'publisher retries one transient stale before provider starts'
assert_eq 2 "$(cat "$run_dir/control-requests/browser/publish-attempts")" 'publisher retry is bounded'
unset BROWSER_FIXTURE_PUBLISH_FAILURE

export FACTORY_BROWSER_ENABLED=1 FACTORY_BROWSER_REQUEST_DIR="$fixture/missing-mailbox"
browser_transport_prompt original >/dev/null 2>&1
assert_rc 79 "$?" 'unreadable mode refuses misleading browser prompt'
assert_eq original "$BROWSER_TRANSPORT_PROMPT" 'failed mode does not prescribe unavailable transport'

ordinal=0
for point in after_held_identity after_identity_publish after_runner_started after_lineage_started; do
  ordinal=$((ordinal + 1))
  task=$((250 + ordinal))
  run="run-browser-fault-$ordinal"
  prepare_case "$task" "$run"
  run_dir="$STATE_DIR/logs/runs/t${task}/CHECK/$run"
  export FACTORY_RUNNER_LAUNCH_FAULT=$point
  runner_launch browserfixture "$task" 'held' CHECK sandboxed-model high 5 \
    "$run_dir" "$run" 1 "$token" >/dev/null 2>&1
  assert_rc 91 "$?" "$point preserves pre-release failure code"
  unset FACTORY_RUNNER_LAUNCH_FAULT
  assert_file_missing "$run_dir/provider-ready" "$point keeps provider behind barrier"
  assert_file_missing "$run_dir/control-requests/browser/binding" "$point removes browser binding"
  if [[ -f "$run_dir/control-requests/browser/relay.pid" ]]; then
    relay_pid=$(cat "$run_dir/control-requests/browser/relay.pid")
    kill -0 "$relay_pid" 2>/dev/null
    assert_rc 1 "$?" "$point reaps a started relay"
  fi
done

prepare_case 261 run-browser-term
run_dir="$STATE_DIR/logs/runs/t261/CHECK/run-browser-term"
export BROWSER_FIXTURE_HOLD=1
on_term() {
  runtime_interrupt_trusted_active 261 CHECK run-browser-term 1 0
}
trap on_term TERM
test_pid=$BASHPID
(
  for poll in {1..300}; do
    [[ -f "$run_dir/provider-ready" ]] && break
    sleep 0.02
  done
  kill -TERM "$test_pid"
) &
sender=$!
runner_launch browserfixture 261 held CHECK sandboxed-model high 35 \
  "$run_dir" run-browser-term 1 "$token" >/dev/null 2>&1
rc=$?
wait "$sender" || true
trap - TERM
unset BROWSER_FIXTURE_HOLD
[[ "$rc" != 0 ]] && test_ok 'TERM interrupts provider' || test_fail 'TERM interrupts provider'
relay_pid=$(cat "$run_dir/control-requests/browser/relay.pid")
kill -0 "$relay_pid" 2>/dev/null
assert_rc 1 "$?" 'TERM reaps relay'
assert_file_missing "$run_dir/control-requests/browser/binding" 'TERM removes binding'

export FACTORY_ROUTE_BROWSER_POLICY=forbid
browser_transport_available
assert_rc 1 "$?" 'pinned forbid prevents capability'
if rg -F "$token" "$STATE_DIR/logs" "$BROWSER_FIXTURE_TRACE" >/dev/null 2>&1; then
  test_fail 'status token absent from prompt/argv/run logs'
else
  test_ok 'status token absent from prompt/argv/run logs'
fi
finish_tests
