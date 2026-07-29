#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

if [[ ! -f "$FACTORY_HOME/lib/multi-runner.sh" ]]; then
  test_fail "multi-runner integration exists" "missing lib/multi-runner.sh"
  finish_tests
  exit $?
fi

export FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners"
export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
mkdir -p "$FACTORY_PROFILES_DIR/fixture"
config="$FACTORY_PROFILES_DIR/fixture/runners.env"
printf '%s\n' \
  'RUNNERS_SCHEMA=1' \
  'CONFIG_REVISION=1' \
  'PROJECT_RUNNER_PRIMARY=alpha' \
  'PROJECT_RUNNER_FAILOVER=beta' \
  'MODEL_BUILD_ALPHA_FAMILY=fixture' \
  'MODEL_BUILD_ALPHA_VERSION=latest' \
  'MODEL_BUILD_ALPHA_EFFORT=high' \
  'MODEL_BUILD_BETA_FAMILY=fixture' \
  'MODEL_BUILD_BETA_VERSION=latest' \
  'MODEL_BUILD_BETA_EFFORT=high' >"$config"

PROFILE_NAME=fixture
PROFILE_CTX=fixture
PROFILE_AGENT_CWD="$TEST_ROOT/work"
PROFILE_AGENT_DIRS="$TEST_ROOT/work"
profile_stage_prompt() { printf 'perform fixture work\n'; }
profile_stage_fanout() { [[ "$1" == BUILD ]] && printf 'AUTO 2-3\n'; }

source "$FACTORY_HOME/lib/core.sh"
: >"$STATE_DIR/t41.pipeline"
: >"$TEST_ROOT/invocations"

export FAKE_ALPHA_RESULT=limited
run_stage 41 BUILD
assert_rc 0 "$?" "core completes stage through failover"
assert_eq done "$(get 41 BUILD)" "run-scoped result reaches pipeline view"
assert_eq $'alpha\nbeta' "$(cat "$TEST_ROOT/invocations")" \
  "proven limit changes provider exactly once"
assert_eq beta "$(get 41 RUNNER_ACTUAL_BUILD)" "actual provider is visible in registry"
assert_eq alpha "$(get 41 RUNNER_REQUESTED_BUILD)" "requested primary is preserved across failover"
assert_eq fallback_limit "$(get 41 RUNNER_REASON_BUILD)" "fallback reason is visible in registry"
assert_eq degraded "$(get 41 PLAN_LEVEL_BUILD)" \
  "missing native fanout degrades instead of blocking fallback"
assert_contains "$(cat "$TEST_ROOT/beta.prompt")" "последовательно" \
  "degraded execution is explicit in replacement prompt"
assert_eq 1 "$(get 41 TRY_BUILD)" "provider failover does not spend a stage attempt"
assert_file_missing "$STATE_DIR/t41.BUILD.status" "protocol v2 ignores fixed marker channel"

alpha_fingerprint=$(printf 'alpha|default' | sha256sum | awk '{print substr($1,1,24)}')
breaker_clear alpha "$alpha_fingerprint" provider "" ""
: >"$STATE_DIR/t42.pipeline"
: >"$TEST_ROOT/invocations"
export FAKE_ALPHA_RESULT=unknown
run_stage 42 BUILD >/dev/null 2>&1
assert_rc 2 "$?" "unknown error eventually stalls existing retry loop"
assert_eq $'alpha\nalpha\nalpha' "$(cat "$TEST_ROOT/invocations")" \
  "unknown error never changes provider"
assert_eq 1 "$(get 42 STALLED_HUMAN)" "exhausted unknown attempts request a human"

breaker_clear alpha "$alpha_fingerprint" provider "" ""
: >"$STATE_DIR/t43.pipeline"
: >"$TEST_ROOT/invocations"
export FAKE_ALPHA_RESULT=failed
run_stage 43 BUILD >/dev/null 2>&1
assert_rc 1 "$?" "semantic agent failure stops the stage"
assert_eq alpha "$(cat "$TEST_ROOT/invocations")" "agent failure never invokes fallback"
assert_eq failed "$(get 43 BUILD)" "agent failure remains semantic failure"

breaker_clear alpha "$alpha_fingerprint" provider "" ""
: >"$STATE_DIR/t44.pipeline"
: >"$TEST_ROOT/invocations"
export FAKE_ALPHA_RESULT=wait
run_stage 44 BUILD >"$TEST_ROOT/switch-stage.out" 2>&1 &
stage_pid=$!
meta=""
for _poll in {1..200}; do
  meta=$(find "$STATE_DIR/logs/runs/t44/BUILD" -name meta.env -type f 2>/dev/null | head -1)
  if [[ -n "$meta" && "$(cat "$TEST_ROOT/invocations")" == alpha ]]; then
    break
  fi
  kill -0 "$stage_pid" 2>/dev/null || break
  sleep 0.02
done
assert_file_exists "$meta" "active run publishes process identity before model work"
assert_eq alpha "$(cat "$TEST_ROOT/invocations")" \
  "manual switch waits until the primary attempt actually starts"
old_pid=$(awk -F= '$1=="PID"{print $2}' "$meta")
"$FACTORY_HOME/bin/factory" 44 runner switch BUILD beta >"$TEST_ROOT/switch.out"
assert_rc 0 "$?" "CLI requests an exact active-run switch"
wait "$stage_pid"
assert_rc 0 "$?" "switched stage completes on requested provider"
assert_eq $'alpha\nbeta' "$(cat "$TEST_ROOT/invocations")" \
  "manual switch replaces only the active runner"
assert_eq done "$(get 44 BUILD)" "replacement run commits terminal status"
assert_eq 1 "$(get 44 TRY_BUILD)" "manual switch does not spend a stage attempt"
assert_eq manual_switch "$(get 44 RUNNER_REASON_BUILD)" "manual switch remains visible"
assert_eq manual_switch "$(awk -F= '$1=="RESULT_CLASS"{v=$2} END{print v}' "$meta")" \
  "interrupted attempt metadata distinguishes an operator switch from a crash"
kill -0 "$old_pid" 2>/dev/null
assert_rc 1 "$?" "old runner process is reaped before replacement completes"

: >"$STATE_DIR/t46.pipeline"
: >"$TEST_ROOT/invocations"
export FAKE_ALPHA_RESULT=denied
run_stage 46 BUILD >/dev/null 2>&1
assert_rc 2 "$?" "sandbox denial stalls without switching provider"
assert_eq alpha "$(cat "$TEST_ROOT/invocations")" "sandbox denial is not retried on another AI"
assert_eq 1 "$(get 46 STALLED_HUMAN)" "sandbox denial requests human action immediately"

: >"$STATE_DIR/t47.pipeline"
: >"$TEST_ROOT/invocations"
export FAKE_ALPHA_RESULT=timeout
run_stage 47 BUILD >/dev/null 2>&1
assert_rc 2 "$?" "timeout stays in the existing retry budget"
assert_eq $'alpha\nalpha\nalpha' "$(cat "$TEST_ROOT/invocations")" \
  "timeout never changes provider"
assert_contains "$(cat "$STATE_DIR/logs/t47.stages.log")" "таймауту" \
  "normalized timeout remains visible in stage log"

# run_stage уже поставил STALLED_HUMAN и вернул rc=2: внешний pipeline обязан
# завершиться сразу. Иначе он начинает новый пакет из трёх попыток и молотит provider
# бесконечно — именно так исторический REVIEW #7379 накопил 113 сбоев.
breaker_clear alpha "$alpha_fingerprint" provider "" ""
: >"$STATE_DIR/t48.pipeline"
: >"$TEST_ROOT/invocations"
set_st 48 ROUTE feature BUILD pending
PROFILE_ROUTE_STAGES_feature=(BUILD)
profile_sandbox_exists() { printf 'ready\n'; }
export FAKE_ALPHA_RESULT=unknown
run_pipeline 48 >"$TEST_ROOT/pipeline-human-stall.out" 2>&1 &
pipeline_pid=$!
for _poll in {1..200}; do
  kill -0 "$pipeline_pid" 2>/dev/null || break
  sleep 0.01
done
if kill -0 "$pipeline_pid" 2>/dev/null; then
  kill -TERM "$pipeline_pid" 2>/dev/null || true
  wait "$pipeline_pid" 2>/dev/null || true
  test_fail "pipeline exits at the human-stall boundary" "run_pipeline repeated a stalled stage"
else
  wait "$pipeline_pid" 2>/dev/null || true
  test_ok "pipeline exits at the human-stall boundary"
fi
assert_eq $'alpha\nalpha\nalpha' "$(cat "$TEST_ROOT/invocations")" \
  "human-stall never starts a fourth provider attempt"

printf 'RUNNERS_COVERAGE=required\n' >>"$config"
: >"$STATE_DIR/t45.pipeline"
: >"$TEST_ROOT/invocations"
export FAKE_ALPHA_RESULT=done
run_stage 45 BUILD >/dev/null 2>&1
assert_rc 2 "$?" "resilient config without current coverage fails closed"
assert_eq "" "$(cat "$TEST_ROOT/invocations")" "coverage gate blocks before every model call"
assert_eq coverage_unavailable "$(get 45 RUNNER_REASON_BUILD)" \
  "coverage blocker is visible to operators"

finish_tests
