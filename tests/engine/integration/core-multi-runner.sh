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
export FAKE_BETA_CAPTURE_ACTIVE_REASON=1
run_stage 41 BUILD
assert_rc 0 "$?" "core completes stage through failover"
assert_eq done "$(get 41 BUILD)" "run-scoped result reaches pipeline view"
assert_eq $'alpha\nbeta' "$(cat "$TEST_ROOT/invocations")" \
  "proven limit changes provider exactly once"
assert_eq beta "$(get 41 RUNNER_ACTUAL_BUILD)" "actual provider is visible in registry"
assert_eq alpha "$(get 41 RUNNER_REQUESTED_BUILD)" "requested primary is preserved across failover"
assert_eq fallback_limit "$(get 41 RUNNER_REASON_BUILD)" "fallback reason is visible in registry"
assert_eq fallback_limit "$(cat "$TEST_ROOT/beta.active-reason")" \
  "fallback reason is visible while the reserve is still running"
assert_eq degraded "$(get 41 PLAN_LEVEL_BUILD)" \
  "missing native fanout degrades instead of blocking fallback"
assert_contains "$(cat "$TEST_ROOT/beta.prompt")" "последовательно" \
  "degraded execution is explicit in replacement prompt"
assert_eq 1 "$(get 41 TRY_BUILD)" "provider failover does not spend a stage attempt"
assert_file_missing "$STATE_DIR/t41.BUILD.status" "protocol v2 ignores fixed marker channel"
unset FAKE_BETA_CAPTURE_ACTIVE_REASON

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
trusted_identity=$(runner_trusted_identity_file 44)
for _poll in {1..200}; do
  meta=$(find "$STATE_DIR/logs/runs/t44/BUILD" -name meta.env -type f 2>/dev/null | head -1)
  if [[ -n "$meta" && -f "$trusted_identity" &&
        "$(cat "$TEST_ROOT/invocations")" == alpha ]]; then
    break
  fi
  kill -0 "$stage_pid" 2>/dev/null || break
  sleep 0.02
done
assert_file_exists "$meta" "active run publishes process identity before model work"
assert_file_exists "$trusted_identity" \
  "launcher publishes trusted identity while the active runner is alive"
assert_eq alpha "$(cat "$TEST_ROOT/invocations")" \
  "manual switch waits until the primary attempt actually starts"
trusted_record=$(runner_trusted_identity_read 44)
read -r trusted_stage trusted_run trusted_epoch trusted_runner old_pid \
  trusted_pgid trusted_session trusted_starttime <<<"$trusted_record"
# Имитируем перезапись провайдером доступных ему диагностических метаданных.
# Управляющий CLI должен игнорировать их и завершить только точный доверенный процесс.
sed -i \
  -e 's/^PID=.*/PID=1/' \
  -e 's/^PGID=.*/PGID=1/' \
  -e 's/^STARTTIME=.*/STARTTIME=1/' \
  "$meta"
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
  "provider-writable metadata cannot redirect the operator switch"
kill -0 "$old_pid" 2>/dev/null
assert_rc 1 "$?" "old runner process is reaped before replacement completes"
assert_file_missing "$trusted_identity" \
  "completed replacement leaves no stale trusted active identity"

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
# бесконечно, накапливая повторные сбои.
breaker_clear alpha "$alpha_fingerprint" provider "" ""
: >"$STATE_DIR/t48.pipeline"
: >"$TEST_ROOT/invocations"
set_st 48 ROUTE feature BUILD pending
PROFILE_ROUTE_STAGES_feature=(BUILD)
profile_sandbox_exists() { printf 'ready\n'; }
export FAKE_ALPHA_RESULT=unknown
rm -f "$TEST_ROOT/pipeline-human-stall.rc"
# Код возврата снимаем ВНУТРИ фонового шелла, как это делает bin/factory (pipeline_rc=$?):
# на выходе сабшелла его затирает EXIT-trap самого run_pipeline, и снаружи wait видит 0.
{ run_pipeline 48 >"$TEST_ROOT/pipeline-human-stall.out" 2>&1
  printf '%s\n' "$?" >"$TEST_ROOT/pipeline-human-stall.rc"; } &
pipeline_pid=$!
# Нарушение ловим по ФАКТУ повтора — четвёртому заходу к провайдеру, — а не по секундомеру.
# Прежнее «жив через 2 с, значит повторил» было гонкой: под нагрузкой параллельного прогона
# честный сценарий (три попытки ≈ 2 с) не успевал и краснел, а настоящую регрессию признавал
# по той же примете, что и медленную машину. Дедлайн ниже — только страховка от зависания.
pipeline_repeat=0
for (( _poll=0; _poll<600; _poll++ )); do
  if (( $(wc -l <"$TEST_ROOT/invocations") > 3 )); then pipeline_repeat=1; break; fi
  kill -0 "$pipeline_pid" 2>/dev/null || break
  sleep 0.05
done
if (( pipeline_repeat )) || kill -0 "$pipeline_pid" 2>/dev/null; then
  # Зациклившийся или зависший конвейер сам не остановится. Снимаем с ограниченным
  # ожиданием: падение должно стоить секунды, а не минуты голого wait.
  kill -TERM "$pipeline_pid" 2>/dev/null || true
  for (( _poll=0; _poll<40; _poll++ )); do
    kill -0 "$pipeline_pid" 2>/dev/null || break
    sleep 0.05
  done
  kill -KILL "$pipeline_pid" 2>/dev/null || true
  wait "$pipeline_pid" 2>/dev/null || true
  if (( pipeline_repeat )); then
    test_fail "pipeline exits at the human-stall boundary" "run_pipeline repeated a stalled stage"
  else
    test_fail "pipeline exits at the human-stall boundary" \
      "run_pipeline never returned after the human stall"
  fi
else
  wait "$pipeline_pid" 2>/dev/null || true
  assert_eq 2 "$(cat "$TEST_ROOT/pipeline-human-stall.rc" 2>/dev/null)" \
    "pipeline exits at the human-stall boundary"
fi
assert_eq 1 "$(get 48 STALLED_HUMAN)" "pipeline leaves the human stall visible to the operator"
assert_eq $'alpha\nalpha\nalpha' "$(cat "$TEST_ROOT/invocations")" \
  "human-stall never starts a fourth provider attempt"

# TERM демону обязан снять и демона, и текущего агента, и сработать РОВНО ОДИН раз.
# `pkill -P $$` перечислял детей РОДИТЕЛЯ (в сабшелле $$ — не свой PID), то есть слал TERM
# самому обработчику: тот входил сам в себя, писал журнал тысячами строк и не выходил вовсе.
breaker_clear alpha "$alpha_fingerprint" provider "" ""
: >"$STATE_DIR/t49.pipeline"
: >"$TEST_ROOT/invocations"
set_st 49 ROUTE feature BUILD pending
export FAKE_ALPHA_RESULT=wait
run_pipeline 49 >"$TEST_ROOT/pipeline-term.out" 2>&1 &
term_pid=$!
term_identity=$(runner_trusted_identity_file 49)
for (( _poll=0; _poll<400; _poll++ )); do
  [[ -s "$TEST_ROOT/invocations" && -f "$term_identity" ]] && break
  kill -0 "$term_pid" 2>/dev/null || break
  sleep 0.01
done
# PID живого агента запоминаем ДО сигнала: смысл pkill в обработчике — не оставить
# работающего агента за умершим демоном (иначе он доживает сиротой и жжёт лимит).
read -r _ _ _ _ term_agent_pid _ <<<"$(runner_trusted_identity_read 49)"
kill -TERM "$term_pid" 2>/dev/null || true
term_exited=0
for (( _poll=0; _poll<100; _poll++ )); do
  kill -0 "$term_pid" 2>/dev/null || { term_exited=1; break; }
  sleep 0.05
done
if (( term_exited )); then
  wait "$term_pid" 2>/dev/null || true
  test_ok "daemon stops on TERM instead of signalling its own handler"
else
  kill -KILL "$term_pid" 2>/dev/null || true
  wait "$term_pid" 2>/dev/null || true
  test_fail "daemon stops on TERM instead of signalling its own handler" \
    "run_pipeline kept running after TERM"
fi
assert_eq 1 "$(grep -c 'остановлен сигналом TERM' "$STATE_DIR/logs/t49.stages.log" 2>/dev/null)" \
  "TERM handler records the stop exactly once"
if [[ "$term_agent_pid" =~ ^[0-9]+$ ]]; then
  term_agent_gone=0
  for (( _poll=0; _poll<40; _poll++ )); do
    kill -0 "$term_agent_pid" 2>/dev/null || { term_agent_gone=1; break; }
    sleep 0.05
  done
  if (( term_agent_gone )); then
    test_ok "TERM takes the running agent down with the daemon"
  else
    kill -KILL "$term_agent_pid" 2>/dev/null || true
    test_fail "TERM takes the running agent down with the daemon" \
      "agent $term_agent_pid outlived the daemon"
  fi
else
  test_fail "TERM takes the running agent down with the daemon" \
    "no trusted identity published for t49"
fi

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
