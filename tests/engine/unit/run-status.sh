#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

missing=0
for file in lib/pipeline-store.sh lib/run-state.sh lib/stage-result.sh lib/pipeline-control.sh; do
  if [[ ! -f "$FACTORY_HOME/$file" ]]; then
    test_fail "$file exists" "missing $file"
    missing=1
  fi
done
if (( missing )); then
  finish_tests
  exit $?
fi

source "$FACTORY_HOME/lib/pipeline-store.sh"
source "$FACTORY_HOME/lib/run-state.sh"

legacy_init_task=76
bash "$FACTORY_HOME/lib/pipeline-set.sh" "$legacy_init_task" --init CHECK pending \
  >/dev/null 2>&1
assert_rc 73 "$?" "default stage skeleton init is no longer accepted"
assert_file_missing "$STATE_DIR/t${legacy_init_task}.pipeline" \
  "rejected legacy init leaves no registry behind"

ghost_task=75
bash "$FACTORY_HOME/lib/pipeline-set.sh" "$ghost_task" NOTE done >/dev/null 2>&1
assert_rc 73 "$?" "public writer requires an existing active route registry"
assert_file_missing "$STATE_DIR/t${ghost_task}.pipeline" \
  "public writer cannot create a ghost task"

archived_task=74
pipeline_store_route_init "$archived_task" CHECK PROFILE fixture CATALOG_PROTOCOL route-v2
mkdir -p "$STATE_DIR/archive"
mv "$STATE_DIR/t${archived_task}.pipeline" "$STATE_DIR/archive/t${archived_task}.pipeline"
bash "$FACTORY_HOME/lib/pipeline-set.sh" "$archived_task" NOTE resurrected >/dev/null 2>&1
assert_rc 73 "$?" "public writer cannot mutate an archived route registry"
assert_file_missing "$STATE_DIR/t${archived_task}.pipeline" \
  "archived write does not resurrect an active task"
grep -q '^NOTE=' "$STATE_DIR/archive/t${archived_task}.pipeline"
assert_rc 1 "$?" "archived registry remains byte-content immutable to public writer"

exact_task=73
printf '%s\n' \
  'RUN_PROTOCOL=2' 'CATALOG_PROTOCOL=route-v2' 'PROFILE=fixture' \
  'WF_STATUS=running' 'PLAN_DECISION=approved' 'DELIVERY_MODE=disabled' \
  'OLD=done' 'OLD_COMMENT=stale old node' 'OLD_AT=2026-01-01 00:00:00' \
  'OLD_FAILS=3' 'ACTIVE_RUN_OLD=run-old' 'ACTIVE_EPOCH_OLD=9' \
  'RUNNER_ACTUAL_OLD=alpha' 'MODEL_ACTUAL_OLD=model-old' \
  'NEW=failed' 'NEW_COMMENT=stale same-node comment' \
  'ACTIVE_RUN_NEW=run-new-old' 'ACTIVE_EPOCH_NEW=7' \
  'RUNNER_ACTUAL_NEW=beta' 'MODEL_ACTUAL_NEW=model-new-old' \
  >"$STATE_DIR/t${exact_task}.pipeline"
pipeline_store_route_init "$exact_task" 'NEW FRESH' PLAN_DECISION pending
assert_rc 0 "$?" "route init replaces the previous projection with an exact machine"
assert_eq pending "$(pipeline_store_get "$exact_task" NEW)" \
  "same-name node starts pending without its previous outcome"
assert_eq pending "$(pipeline_store_get "$exact_task" FRESH)" \
  "new machine node is initialized"
assert_eq fixture "$(pipeline_store_get "$exact_task" PROFILE)" \
  "non-stage pinned metadata survives exact re-init"
assert_eq pending "$(pipeline_store_get "$exact_task" PLAN_DECISION)" \
  "host metadata supplied with re-init is applied atomically"
grep -Eq '^(OLD|OLD_COMMENT|OLD_AT|OLD_FAILS|ACTIVE_(RUN|EPOCH)_OLD|RUNNER_ACTUAL_OLD|MODEL_ACTUAL_OLD)=' \
  "$STATE_DIR/t${exact_task}.pipeline"
assert_rc 1 "$?" "removed route node leaves no status/comment/provenance family"
grep -Eq '^(NEW_COMMENT|ACTIVE_(RUN|EPOCH)_NEW|RUNNER_ACTUAL_NEW|MODEL_ACTUAL_NEW)=' \
  "$STATE_DIR/t${exact_task}.pipeline"
assert_rc 1 "$?" "retained route node loses stale comment, run and provider provenance"

task=77
stage=CHECK
token_a="status-secret-a"
token_b="status-secret-b"
control_token="control-secret"

pipeline_store_route_init "$task" "$stage" \
  PROFILE fixture CATALOG_PROTOCOL route-v2 ROUTE feature \
  ATTEMPT_ID a_77777777777777777777777777777777 \
  ROUTE_HASH aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  RESULT active WORKSPACE_MODE shared STAND_OWNERSHIP external ORCH_PID 777 \
  STALLED_HUMAN 0 DELIVERY_MODE disabled \
  RUNNER_ACTUAL_CHECK alpha
assert_rc 0 "$?" "exact route registry initializes"
assert_eq 2 "$(pipeline_store_get "$task" RUN_PROTOCOL)" \
  "route registry is protocol 2 from its first durable write"

reserved_write_denied() {
  local key=$1 forged=$2 expected=$3 label=$4
  bash "$FACTORY_HOME/lib/pipeline-set.sh" "$task" "$key" "$forged" >/dev/null 2>&1
  assert_rc 73 "$?" "$label is reserved to the host control writer"
  assert_eq "$expected" "$(pipeline_store_get "$task" "$key")" \
    "$label cannot be forged through pipeline-set"
}

reserved_write_denied CATALOG_PROTOCOL forged route-v2 "catalog protocol"
reserved_write_denied PROFILE attacker fixture "profile identity"
reserved_write_denied ROUTE debug feature "pinned route"
reserved_write_denied ATTEMPT_ID a_00000000000000000000000000000000 \
  a_77777777777777777777777777777777 "attempt identity"
reserved_write_denied ROUTE_HASH bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "route hash"
reserved_write_denied RESULT completed active "lifecycle result"
reserved_write_denied WORKSPACE_MODE isolated shared "workspace ownership mode"
reserved_write_denied STAND_OWNERSHIP task external "stand ownership"
reserved_write_denied ORCH_PID 999 777 "orchestrator pid"
reserved_write_denied RUNNER_ACTUAL_CHECK beta alpha "runner provenance"
reserved_write_denied STALLED_HUMAN 1 0 "human-stall state"
reserved_write_denied DELIVERY_MODE publish disabled "delivery mode"

bash "$FACTORY_HOME/lib/pipeline-set.sh" "$task" ATTEMPT_ID_COMMENT forged \
  >/dev/null 2>&1
assert_rc 73 "$?" "comments derived from reserved metadata remain reserved"
assert_eq "" "$(pipeline_store_get "$task" ATTEMPT_ID_COMMENT)" \
  "reserved metadata comment cannot be injected"

bash "$FACTORY_HOME/lib/pipeline-set.sh" "$task" "$stage" waiting >/dev/null 2>&1
assert_rc 73 "$?" "route runKey state is reserved to run/control APIs"
assert_eq pending "$(pipeline_store_get "$task" "$stage")" \
  "direct writer cannot forge a route node transition"
bash "$FACTORY_HOME/lib/pipeline-set.sh" "$task" "${stage}_COMMENT" forged \
  >/dev/null 2>&1
assert_rc 73 "$?" "route runKey comment follows the same ownership boundary"

factory_control_init "$control_token"
run_state_begin "$task" "$stage" run-a 1 "$token_a"
assert_rc 0 "$?" "active run begins"

run_state_apply_result "$task" "$stage" run-old 0 "$token_a" done ""
assert_rc 73 "$?" "old run id and epoch are stale"

run_state_apply_result "$task" "$stage" run-a 1 wrong-token done ""
assert_rc 74 "$?" "wrong capability is rejected"

run_state_apply_result "$task" "$stage" run-a 1 "$token_a" done "fixture done"
assert_rc 0 "$?" "active terminal result is accepted"
assert_eq done "$(pipeline_store_get "$task" "$stage")" "accepted result reaches pipeline"
assert_eq "fixture done" "$(pipeline_store_get "$task" "${stage}_COMMENT")" "comment is atomic with result"

run_state_apply_result "$task" "$stage" run-a 1 "$token_a" failed ""
assert_rc 75 "$?" "terminal result is accepted only once"
assert_eq done "$(pipeline_store_get "$task" "$stage")" "repeat cannot replace terminal result"

run_state_begin "$task" "$stage" run-b 2 "$token_b"
assert_rc 0 "$?" "replacement run gets new epoch"
run_state_begin "$task" "$stage" run-regressed 1 regressed-token >/dev/null 2>&1
assert_rc 73 "$?" "stage epoch cannot move backwards"
assert_eq run-b "$(_run_state_get "$(run_state_active_file "$task" "$stage")" RUN_ID)" \
  "rejected epoch leaves active run intact"

bash "$FACTORY_HOME/lib/pipeline-set.sh" "$task" "$stage" done >/dev/null 2>&1
assert_rc 73 "$?" "direct terminal pipeline-set is denied for protocol v2"
assert_eq running "$(pipeline_store_get "$task" "$stage")" "direct writer cannot finish active run"

bash "$FACTORY_HOME/lib/pipeline-set.sh" "$task" "$stage=done" >/dev/null 2>&1
assert_rc 73 "$?" "KEY=terminal cannot bypass the route protocol guard"
assert_eq running "$(pipeline_store_get "$task" "$stage")" \
  "KEY=terminal bypass leaves the active route node unchanged"

bash "$FACTORY_HOME/lib/pipeline-set.sh" "$task" NOTE done >/dev/null
assert_rc 0 "$?" "non-stage free text equal to done is not a false terminal match"
assert_eq done "$(pipeline_store_get "$task" NOTE)" \
  "free-text metadata survives the key-aware guard"

bash "$FACTORY_HOME/lib/pipeline-set.sh" "$task" ACTIVE_RUN_CHECK forged >/dev/null 2>&1
assert_rc 73 "$?" "direct active-run control write is denied"
bash "$FACTORY_HOME/lib/pipeline-set.sh" "$task" RUN_PROTOCOL=1 >/dev/null 2>&1
assert_rc 73 "$?" "direct protocol downgrade in KEY=VALUE form is denied"

exec 9<<<"$token_b"
FACTORY_STATUS_FD=9 bash "$FACTORY_HOME/lib/stage-result.sh" \
  --task "$task" --stage "$stage" --run-id run-b --epoch 2 skipped "fixture skip" >/dev/null
rc=$?
exec 9<&-
assert_rc 0 "$rc" "stage-result reads capability from inherited FD"
assert_eq skipped "$(pipeline_store_get "$task" "$stage")" "stage-result applies result"

run_state_begin "$task" "$stage" run-c 3 status-secret-c
exec 8<<<"$control_token"
FACTORY_CONTROL_FD=8 bash "$FACTORY_HOME/lib/pipeline-control.sh" \
  "$task" "$stage" failed "${stage}_COMMENT" "engine stop" >/dev/null
rc=$?
exec 8<&-
assert_rc 0 "$rc" "privileged control path accepts control capability"
assert_eq failed "$(pipeline_store_get "$task" "$stage")" "control path changes pipeline"

exec 9<<<"status-secret-c"
FACTORY_STATUS_FD=9 bash "$FACTORY_HOME/lib/stage-result.sh" \
  --task "$task" --stage "$stage" --run-id run-c --epoch 3 done >/dev/null 2>&1
rc=$?
exec 9<&-
assert_rc 75 "$rc" "privileged terminal control revokes active agent result"
assert_eq failed "$(pipeline_store_get "$task" "$stage")" "revoked agent cannot replace control result"

exec 8<<<"wrong-control"
FACTORY_CONTROL_FD=8 bash "$FACTORY_HOME/lib/pipeline-control.sh" \
  "$task" "$stage" done >/dev/null 2>&1
rc=$?
exec 8<&-
assert_rc 74 "$rc" "agent/status token cannot use privileged control path"

# Typed failed — часть run-scoped capability, а не свободные поля pipeline.
# Невалидная metadata отклоняется до терминального перехода, валидная хранится
# канонически и доезжает до route runtime вместе с результатом.
run_state_begin "$task" "$stage" run-d 4 status-secret-d
exec 9<<<"status-secret-d"
FACTORY_STATUS_FD=9 bash "$FACTORY_HOME/lib/stage-result.sh" \
  --task "$task" --stage "$stage" --run-id run-d --epoch 4 \
  --failure-owner build --finding 'bad=metadata у done запрещена' done \
  >/dev/null 2>&1
rc=$?
exec 9<&-
assert_rc 2 "$rc" "non-failed result rejects failure metadata"
assert_eq running "$(pipeline_store_get "$task" "$stage")" \
  "rejected metadata leaves active run open"

exec 9<<<"status-secret-d"
FACTORY_STATUS_FD=9 bash "$FACTORY_HOME/lib/stage-result.sh" \
  --task "$task" --stage "$stage" --run-id run-d --epoch 4 \
  --failure-owner reviewer --finding 'stable-id=неизвестный owner' failed \
  >/dev/null 2>&1
rc=$?
exec 9<&-
assert_rc 2 "$rc" "typed failed rejects unknown owner"

exec 9<<<"status-secret-d"
FACTORY_STATUS_FD=9 bash "$FACTORY_HOME/lib/stage-result.sh" \
  --task "$task" --stage "$stage" --run-id run-d --epoch 4 \
  --failure-owner build failed >/dev/null 2>&1
rc=$?
exec 9<&-
assert_rc 2 "$rc" "typed failed requires at least one finding"

# Отказ обязан называть нарушенное правило. Молчащий код 2 стоил вердикта этапа: на t7802
# скептик не смог отчитаться из-за длинного summary, угадывал причину пробными вызовами, и
# терминальный исход узла закрыл диагностический плейсхолдер — повторная фиксация того же
# run уже отклоняется.
long_summary=$(printf 'x%.0s' $(seq 1 501))
verdict_stderr="$TEST_ROOT/verdict-stderr.txt"
exec 9<<<"status-secret-d"
FACTORY_STATUS_FD=9 bash "$FACTORY_HOME/lib/stage-result.sh" \
  --task "$task" --stage "$stage" --run-id run-d --epoch 4 \
  --failure-owner build --finding "too-long=$long_summary" \
  failed 'слишком длинное замечание' >/dev/null 2>"$verdict_stderr"
rc=$?
exec 9<&-
assert_rc 2 "$rc" "typed failed rejects a summary over the limit"
assert_contains "$(cat "$verdict_stderr")" "summary 501 символов, допустимо 1..500" \
  "rejection names the violated rule instead of a bare exit code"
assert_eq running "$(pipeline_store_get "$task" "$stage")" \
  "rejected verdict leaves the run open for a valid retry"

exec 9<<<"status-secret-d"
FACTORY_STATUS_FD=9 bash "$FACTORY_HOME/lib/stage-result.sh" \
  --task "$task" --stage "$stage" --run-id run-d --epoch 4 \
  --failure-owner build \
  --finding 'valid-regex-route=валидный regex не должен возвращать 422' \
  failed 'typed review failure' >/dev/null
rc=$?
exec 9<&-
assert_rc 0 "$rc" "stage-result accepts typed failed"
typed_file=$(run_state_active_file "$task" "$stage")
typed_b64=$(_run_state_get "$typed_file" VERDICT_B64)
assert_eq build "$(run_state_verdict_owner failed "$typed_b64")" \
  "trusted run record preserves typed owner"
assert_eq failed "$(pipeline_store_get "$task" "$stage")" \
  "typed result reaches the pipeline projection"

if rg -F 'status-secret-' "$STATE_DIR" "$FACTORY_CONFIG_ROOT" >/dev/null 2>&1; then
  test_fail "status capabilities do not leak to state/control files" "plaintext token found"
else
  test_ok "status capabilities do not leak to state/control files"
fi

finish_tests
