#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

export FACTORY_V2_STATE_DIR="$STATE_DIR"
source "$FACTORY_HOME/lib/route-runtime-v2.sh"

routes_dir="$TEST_ROOT/routes-v2"
publisher="$FACTORY_TESTS_HOME/fixtures/routes-v2-catalog-publish.mjs"
profile_id=demo-profile
debug_task=9001
retry_task=9002
exhausted_task=9003
instrumentation_marker="FACTORY-TRACE:t${debug_task}"
base_repo="$TEST_ROOT/source"
worktree="$TEST_ROOT/worktree-t${debug_task}"
scope="$worktree/trace.php"
FIXTURE_CONTEXT="$TEST_ROOT/context.json"
export ROUTE_V2_INSTRUMENTATION_SCOPE_FILE="$TEST_ROOT/instrumentation-scope.txt"

json_field() {
  "$NODE_BIN" -e \
    'const v=JSON.parse(process.argv[1]); let x=v; for(const k of process.argv.slice(2)) x=x[k]; process.stdout.write(x == null ? "" : String(x));' \
    "$@"
}

git init -q "$base_repo"
git -C "$base_repo" config user.email tests@example.invalid
git -C "$base_repo" config user.name Tests
printf '<?php return 1;\n' >"$base_repo/trace.php"
git -C "$base_repo" add trace.php
git -C "$base_repo" commit -qm baseline
git -C "$base_repo" worktree add -qb route-v2 "$worktree"
printf '%s\n' "$scope" >"$ROUTE_V2_INSTRUMENTATION_SCOPE_FILE"

published=$(
  "$NODE_BIN" "$publisher" "$routes_dir" null
)
assert_rc 0 "$?" "all v2 routes publish into an isolated store"

ATTEMPT_STATE_ID_OVERRIDE=a_90019001900190019001900190019001
attempt=$(attempt_state_begin_v2 "$debug_task" "$profile_id" "$routes_dir")
begin_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
assert_rc 0 "$begin_rc" "isolated v2 attempt begins"
attempt_state_select_route_v2 "$debug_task" "$attempt" debug >/dev/null
assert_rc 0 "$?" "human-selected route is pinned"

ACCEPTANCE=pending
cat >"$FIXTURE_CONTEXT" <<JSON
{
  "task": {"id": $debug_task, "title": "debug"},
  "attempt": {"id": "$attempt"},
  "project": {"profile": "$profile_id"},
  "workspace": {"backend": {"path": "$worktree"}, "frontend": {"path": "$worktree"}},
  "services": {"apiUrl": "unavailable"},
  "artifacts": {"root": "$STATE_DIR"},
  "diagnosis": {"kind": "functional"},
  "instrumentation": {
    "allowedFiles": ["$scope"],
    "marker": "$instrumentation_marker",
    "scopeFile": "$ROUTE_V2_INSTRUMENTATION_SCOPE_FILE"
  },
  "evidence": {"eventCount": 0},
  "decisions": {
    "cause": {"status": "approved", "comment": ""},
    "review": {"status": "approved", "comment": ""},
    "acceptance": {"status": "PENDING", "comment": ""}
  },
  "delivery": {
    "mode": "publish",
    "actions": ["commit", "push", "pull-request"],
    "targetBranches": {"be": "master"},
    "sourceBranch": "fixture-${debug_task}-v2"
  },
  "routeCatalog": {"debug": "$(json_field "$published" routeHashes debug)"},
  "stage": {"id": "placeholder", "runKey": "PLACEHOLDER"}
}
JSON

route_v2_workspace_roots() {
  printf '%s\n' "$worktree"
}

route_v2_context_for_node() {
  local output=$5 status=$ACCEPTANCE
  sed "s/\"status\": \"PENDING\"/\"status\": \"$status\"/" \
    "$FIXTURE_CONTEXT" >"$output"
}

FAKE_EPOCH=0
FAKE_AGENT_CALLS=0
SHIP_CALLED=0
# Статус узла в реестре на момент, когда агента ТОЛЬКО ЗОВУТ. Файл, а не переменная:
# dispatch запускается через command substitution, и сабшелл наружу ничего не отдаёт.
STATUS_AT_START="$TEST_ROOT/status-at-agent-start.log"
run_agent() {
  local task=$1 prompt=$2 stage=$3 file result=done
  [[ "${FACTORY_ROUTE_FILESYSTEM_POLICY:-}" =~ ^(state-only|workspace-write|transactional-write)$ ]] ||
    return 91
  printf '%s=%s\n' "$stage" "$(pipeline_store_get "$task" "$stage")" >>"$STATUS_AT_START"
  FAKE_AGENT_CALLS=$((FAKE_AGENT_CALLS + 1))
  FAKE_EPOCH=$((FAKE_EPOCH + 1))
  case "$stage" in
    INSTRUMENT)
      printf '// %s temporary\n' "$instrumentation_marker" >>"$scope"
      ;;
    TESTS)
      printf '<?php return 2;\n' >"$worktree/product-change.php"
      ;;
    SHIP)
      SHIP_CALLED=1
      [[ "$prompt" == *delivery* && "$prompt" == *publish* &&
         "$prompt" == *'Публикация принятого изменения'* ]] || return 93
      ;;
  esac
  file=$(run_state_active_file "$task" "$stage") || return
  _run_state_write \
    "$file" "fake-${stage}-${FAKE_EPOCH}" "$FAKE_EPOCH" \
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    committed "$result"
}

bootstrap=$(route_v2_dispatch_bootstrap "$debug_task" "$attempt")
assert_rc 0 "$?" "bootstrap accepts the route pinned from a three-route catalog"
assert_eq done "$(json_field "$bootstrap" result)" \
  "bootstrap records a committed result"
assert_eq debug "$(json_field "$bootstrap" routeId)" \
  "bootstrap keeps the human-selected route"

attempt_stage_state_init_v2 "$debug_task" "$attempt" debug >/dev/null
assert_rc 0 "$?" "trusted route cursor initializes after bootstrap"

route_v2_dispatch_next "$debug_task" "$attempt" >/dev/null
assert_rc 0 "$?" "state-only reproduction commits"
route_v2_dispatch_next "$debug_task" "$attempt" >/dev/null
assert_rc 0 "$?" "transactional instrumentation commits"
assert_contains "$(cat "$scope")" "$instrumentation_marker" \
  "instrumentation remains visible through the proof window"

route_v2_dispatch_next "$debug_task" "$attempt" >/dev/null
assert_rc 0 "$?" "diagnosis runs against the instrumented workspace"
route_v2_dispatch_next "$debug_task" "$attempt" >/dev/null
assert_rc 0 "$?" "hypothesis skeptic commits"
route_v2_dispatch_next "$debug_task" "$attempt" >/dev/null
assert_rc 0 "$?" "proof closes the instrumentation transaction"
if grep -Fq "$instrumentation_marker" "$scope"; then
  test_fail "proof removes transaction-owned instrumentation"
else
  test_ok "proof removes transaction-owned instrumentation"
fi
assert_eq '<?php return 1;' "$(tr -d '\n' <"$scope")" \
  "transaction cleanup restores the exact source baseline"

route_v2_dispatch_next "$debug_task" "$attempt" >/dev/null
assert_rc 0 "$?" "translator commits"
route_v2_dispatch_next "$debug_task" "$attempt" >/dev/null
assert_rc 20 "$?" "cause gate pauses without polling"
route_v2_gate_decide "$debug_task" "$attempt" gate_cause approved >/dev/null
assert_rc 0 "$?" "approved cause gate advances"

for expected in build review measure phpcheck lint gate_accept; do
  advanced=$(route_v2_dispatch_next "$debug_task" "$attempt")
  assert_rc 0 "$?" "agent node advances under its declared filesystem policy"
  assert_eq "$expected" "$(json_field "$advanced" currentNode)" \
    "route advances to $expected"
done
route_v2_dispatch_next "$debug_task" "$attempt" >/dev/null
assert_rc 20 "$?" "acceptance gate pauses before SHIP"
route_v2_gate_decide "$debug_task" "$attempt" gate_accept approved >/dev/null
assert_rc 0 "$?" "accepted diff advances to SHIP"
ACCEPTANCE=approved

route_v2_dispatch_until_pause "$debug_task" "$attempt" 8 >/dev/null
assert_rc 21 "$?" "normal v2 executes SHIP and RETRO through terminal done"
assert_eq 1 "$SHIP_CALLED" "SHIP is executed rather than hard-stopped"
terminal=$(attempt_stage_state_read_v2 "$debug_task" "$attempt")
assert_eq stopped "$(json_field "$terminal" state)" \
  "trusted cursor reaches a terminal state"
assert_eq done "$(json_field "$terminal" stop)" \
  "successful tail stops at done"

# Узел обязан гореть на доске ДО запуска агента, а не с момента, когда раннер забрал запуск:
# между входом в узел и стартом агента идут рендер промпта, открытие транзакции и снимок
# рабочих деревьев, и всё это время доска иначе показывает прошлый узел. Фейковый агент
# run_state_begin не зовёт вовсе, поэтому running
# в реестре здесь может взяться только из пометки на входе.
not_running=$(grep -v '=running$' "$STATUS_AT_START" || true)
assert_eq "" "$not_running" "узел помечен running до вызова агента"
assert_contains "$(cat "$STATUS_AT_START")" 'SCOUT=running' \
  "bootstrap-узел зажигается наравне с остальными"
assert_contains "$(cat "$STATUS_AT_START")" 'BUILD=running' \
  "узел после ворот тоже помечен до запуска агента"

# --- Ретраи по контракту бандла и синтетический exhausted ---
# Фейк без побочных эффектов: BUILD молчит (не пишет run-state) SILENT_LEFT раз,
# остальные этапы всегда коммитят done. Бюджет BUILD в бандле: 1 + noResult(1)
# + providerFailure.attempts(1) = 3 попытки. Счётчик вызовов — ФАЙЛ: dispatch
# зовётся через command substitution (сабшелл), переменная снаружи не видна.
CALLS_LOG="$TEST_ROOT/retry-agent-calls.log"
SILENT_LEFT=0
run_agent() {
  local task=$1 prompt=$2 stage=$3 file
  [[ "${FACTORY_ROUTE_FILESYSTEM_POLICY:-}" =~ ^(state-only|workspace-write|transactional-write)$ ]] ||
    return 91
  printf '%s\n' "$stage" >>"$CALLS_LOG"
  FAKE_EPOCH=$((FAKE_EPOCH + 1))
  if [[ "$stage" == BUILD ]] && (( SILENT_LEFT > 0 )); then
    SILENT_LEFT=$((SILENT_LEFT - 1))
    return 0
  fi
  file=$(run_state_active_file "$task" "$stage") || return
  _run_state_write \
    "$file" "fake-${stage}-${FAKE_EPOCH}" "$FAKE_EPOCH" \
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    committed done
}

ATTEMPT_STATE_ID_OVERRIDE=a_90029002900290029002900290029002
retry_attempt=$(attempt_state_begin_v2 "$retry_task" "$profile_id" "$routes_dir")
begin_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
assert_rc 0 "$begin_rc" "retry scenario attempt begins"
attempt_state_select_route_v2 "$retry_task" "$retry_attempt" trivial >/dev/null
assert_rc 0 "$?" "trivial route pins for retry scenario"
route_v2_dispatch_bootstrap "$retry_task" "$retry_attempt" >/dev/null
assert_rc 0 "$?" "retry scenario bootstrap commits"
attempt_stage_state_init_v2 "$retry_task" "$retry_attempt" trivial >/dev/null
assert_rc 0 "$?" "retry scenario cursor initializes"

SILENT_LEFT=2
: >"$CALLS_LOG"
advanced=$(route_v2_dispatch_next "$retry_task" "$retry_attempt")
assert_rc 0 "$?" "no-result attempts are retried within the bundle budget"
assert_eq 3 "$(wc -l <"$CALLS_LOG")" \
  "two silent attempts consume retry budget before the committed one"
assert_eq review "$(json_field "$advanced" currentNode)" \
  "retried node commits done and the route advances"

ATTEMPT_STATE_ID_OVERRIDE=a_90039003900390039003900390039003
exhausted_attempt=$(attempt_state_begin_v2 "$exhausted_task" "$profile_id" "$routes_dir")
begin_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
assert_rc 0 "$begin_rc" "exhausted scenario attempt begins"
attempt_state_select_route_v2 "$exhausted_task" "$exhausted_attempt" trivial >/dev/null
assert_rc 0 "$?" "trivial route pins for exhausted scenario"
route_v2_dispatch_bootstrap "$exhausted_task" "$exhausted_attempt" >/dev/null
assert_rc 0 "$?" "exhausted scenario bootstrap commits"
attempt_stage_state_init_v2 "$exhausted_task" "$exhausted_attempt" trivial >/dev/null
assert_rc 0 "$?" "exhausted scenario cursor initializes"

SILENT_LEFT=99
: >"$CALLS_LOG"
stopped=$(route_v2_dispatch_next "$exhausted_task" "$exhausted_attempt")
assert_rc 0 "$?" "burned budget commits a synthetic exhausted outcome"
assert_eq 3 "$(wc -l <"$CALLS_LOG")" \
  "exhausted fires only after the full declared budget"
assert_eq stopped "$(json_field "$stopped" state)" \
  "exhausted transition stops the route"
assert_eq human "$(json_field "$stopped" stop)" \
  "bundle routes exhausted to a human stop"
route_v2_dispatch_next "$exhausted_task" "$exhausted_attempt" >/dev/null
assert_rc 21 "$?" "stopped cursor reports terminal state on the next dispatch"

finish_tests
