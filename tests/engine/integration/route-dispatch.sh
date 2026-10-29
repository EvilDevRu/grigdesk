#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

export FACTORY_ROUTE_STATE_DIR="$STATE_DIR"
source "$FACTORY_HOME/lib/route-runtime.sh"

routes_dir="$TEST_ROOT/routes"
publisher="$FACTORY_TESTS_HOME/fixtures/routes-catalog-publish.mjs"
profile_id=demo-profile
debug_task=9001
retry_task=9002
exhausted_task=9003
rewind_task=9004
evidence_task=9005
hunt_task=9006
command_task=9007
stop_feedback_task=9008
instrumentation_marker="FACTORY-TRACE:t${debug_task}"
base_repo="$TEST_ROOT/source"
worktree="$TEST_ROOT/worktree-t${debug_task}"
scope="$worktree/trace.txt"
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
printf 'baseline\n' >"$base_repo/trace.txt"
git -C "$base_repo" add trace.txt
git -C "$base_repo" commit -qm baseline
git -C "$base_repo" worktree add -qb route-run "$worktree"
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
CONTEXT_DELIVERY=publish
cat >"$FIXTURE_CONTEXT" <<JSON
{
  "task": {"id": $debug_task, "title": "debug"},
  "attempt": {"id": "$attempt"},
  "project": {"profile": "$profile_id"},
  "workspace": {"service": {"path": "$worktree"}, "client": {"path": "$worktree"}},
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
    "targetBranches": {"service": "main"},
    "sourceBranch": "fixture-${debug_task}"
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
  if [[ "$CONTEXT_DELIVERY" == disabled ]]; then
    "$NODE_BIN" -e '
      const fs = require("node:fs");
      const file = process.argv[1];
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      value.delivery = { mode: "disabled", actions: [], targetBranches: {}, sourceBranch: value.delivery.sourceBranch };
      fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
    ' "$output"
  fi
}

FAKE_EPOCH=0
FAKE_AGENT_CALLS=0
SHIP_CALLED=0
INSTRUMENT_FAILURES_LEFT=1
INSTRUMENT_TRANSACTIONS="$TEST_ROOT/instrument-transactions.log"
INSTRUMENT_BASELINES="$TEST_ROOT/instrument-baselines.log"
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
      _route_v2_transaction_active_id "$task" >>"$INSTRUMENT_TRANSACTIONS"
      cat "$scope" >>"$INSTRUMENT_BASELINES"
      printf '# %s temporary\n' "$instrumentation_marker" >>"$scope"
      if (( INSTRUMENT_FAILURES_LEFT > 0 )); then
        INSTRUMENT_FAILURES_LEFT=$((INSTRUMENT_FAILURES_LEFT - 1))
        file=$(run_state_active_file "$task" "$stage") || return
        MULTI_LAST_RUN_ID="fake-${stage}-${FAKE_EPOCH}"
        MULTI_LAST_RUN_EPOCH=$FAKE_EPOCH
        _run_state_write "$file" "$MULTI_LAST_RUN_ID" "$FAKE_EPOCH" \
          aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa active
        DISPATCH_RESULT_KIND=transient
        return 1
      fi
      ;;
    TESTS)
      printf 'changed\n' >"$worktree/product-change.txt"
      ;;
    SHIP)
      SHIP_CALLED=1
      [[ "$prompt" == *delivery* && "$prompt" == *publish* &&
         "$prompt" == *'Публикация принятого изменения'* ]] || return 93
      ;;
  esac
  file=$(run_state_active_file "$task" "$stage") || return
  MULTI_LAST_RUN_ID="fake-${stage}-${FAKE_EPOCH}"
  MULTI_LAST_RUN_EPOCH=$FAKE_EPOCH
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
instrument_rc=$?
assert_rc 0 "$instrument_rc" "инструментация повторяется после временного отказа раннера"
if (( instrument_rc != 0 )); then
  finish_tests
  exit 1
fi
assert_eq 2 "$(wc -l <"$INSTRUMENT_TRANSACTIONS")" \
  "после временного отказа агент вызывается повторно"
assert_eq 2 "$(sort -u "$INSTRUMENT_TRANSACTIONS" | wc -l)" \
  "повтор получает отдельную транзакцию"
assert_eq $'baseline\nbaseline' "$(cat "$INSTRUMENT_BASELINES")" \
  "повтор инструментации начинает с восстановленного исходника"
first_tx=$(head -1 "$INSTRUMENT_TRANSACTIONS")
second_tx=$(tail -1 "$INSTRUMENT_TRANSACTIONS")
first_tx_dir=$(instrumentation_tx_dir "$debug_task" "$first_tx")
assert_eq completed "$(_instrumentation_tx_get "$first_tx_dir/state.env" STATE)" \
  "закрытая транзакция первого захода сохранена"
assert_eq "$second_tx" "$(_route_v2_transaction_active_id "$debug_task")" \
  "proof наследует транзакцию успешного повтора"
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
assert_eq 'baseline' "$(tr -d '\n' <"$scope")" \
  "transaction cleanup restores the exact source baseline"

route_v2_dispatch_next "$debug_task" "$attempt" >/dev/null
assert_rc 0 "$?" "translator commits"
route_v2_dispatch_next "$debug_task" "$attempt" >/dev/null
assert_rc 20 "$?" "cause gate pauses without polling"
route_v2_gate_decide "$debug_task" "$attempt" gate_cause approved >/dev/null
assert_rc 0 "$?" "approved cause gate advances"

for expected in build review measure syntax_check lint gate_accept; do
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

# Rejected без rewind раньше законно принимал комментарий в mutable-проекцию. После
# переноса текста в ledger этот маршрут нельзя сломать: reason остаётся аудитом
# человеческой остановки, хотя доставлять его следующему узлу некуда.
ATTEMPT_STATE_ID_OVERRIDE=a_90089008900890089008900890089008
stop_feedback_attempt=$(attempt_state_begin_v2 \
  "$stop_feedback_task" "$profile_id" "$routes_dir")
stop_feedback_begin_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
assert_rc 0 "$stop_feedback_begin_rc" "stop-feedback attempt begins"
attempt_state_select_route_v2 \
  "$stop_feedback_task" "$stop_feedback_attempt" debug >/dev/null
attempt_stage_state_init_v2 \
  "$stop_feedback_task" "$stop_feedback_attempt" debug >/dev/null
for stop_node in repro instrument diagnose hyposkeptic proof translator; do
  attempt_stage_state_commit_v2 \
    "$stop_feedback_task" "$stop_feedback_attempt" "$stop_node" done >/dev/null
  assert_rc 0 "$?" "stop-feedback route advances through $stop_node"
done
attempt_stage_state_pause_v2 \
  "$stop_feedback_task" "$stop_feedback_attempt" gate_cause 'human gate: gate_cause' \
  >/dev/null
stop_feedback='причина отвергнута, продолжать нельзя'
route_v2_gate_decide \
  "$stop_feedback_task" "$stop_feedback_attempt" gate_cause rejected "$stop_feedback" \
  >/dev/null
assert_rc 0 "$?" "rejected stop commits with bounded human feedback"
stop_feedback_cursor=$(attempt_stage_state_read_v2 \
  "$stop_feedback_task" "$stop_feedback_attempt")
assert_eq stopped "$(json_field "$stop_feedback_cursor" state)" \
  "rejected stop remains a terminal human decision"
stop_feedback_event=$(attempt_stage_state_latest_event_v2 \
  "$stop_feedback_task" "$stop_feedback_attempt")
assert_eq "$stop_feedback" "$(json_field "$stop_feedback_event" reason)" \
  "rejected stop preserves feedback in the immutable audit"

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
  local task=$1 prompt=$2 stage=$3 run_id token=fake-token
  [[ "${FACTORY_ROUTE_FILESYSTEM_POLICY:-}" =~ ^(state-only|workspace-write|transactional-write)$ ]] ||
    return 91
  printf '%s\n' "$stage" >>"$CALLS_LOG"
  FAKE_EPOCH=$((FAKE_EPOCH + 1))
  run_id="fake-${stage}-${FAKE_EPOCH}"
  MULTI_LAST_RUN_ID=$run_id
  MULTI_LAST_RUN_EPOCH=$FAKE_EPOCH
  run_state_begin "$task" "$stage" "$run_id" "$FAKE_EPOCH" "$token" || return
  if [[ "$stage" == BUILD ]] && (( SILENT_LEFT > 0 )); then
    SILENT_LEFT=$((SILENT_LEFT - 1))
    return 0
  fi
  run_state_apply_result "$task" "$stage" "$run_id" "$FAKE_EPOCH" "$token" done
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

# Пробный шаг получает тот же immutable fixture как JSON: два отсутствующих
# результата и зафиксированный done должны совпасть с тремя реальными вызовами
# фейкового раннера dispatcher выше.
simulation_step() {
  local observed=$1 counters_json=$2
  "$NODE_BIN" --input-type=module -e '
import { pathToFileURL } from "node:url";
const { ROUTE_DEFINITIONS, bootstrap, bootstrapPrompts, PROFILE_ID } =
  await import(pathToFileURL(process.argv[1]));
process.stdout.write(JSON.stringify({
  catalogInput: { profile: PROFILE_ID, routes: ROUTE_DEFINITIONS,
    bootstrap, bootstrapPrompts },
  cursor: { scope: "route", routeId: "trivial", nodeId: "build", terminal: false },
  counters: JSON.parse(process.argv[3]), outcome: process.argv[2],
  failureOwner: null, selectedRouteId: null, pinned: false, stepIndex: 1,
}));
' "$FACTORY_TESTS_HOME/fixtures/routes-catalog-definitions.mjs" \
    "$observed" "$counters_json" |
    "$FACTORY_HOME/bin/factory-route" --profile "$profile_id" editor-step
}

simulation_counters() {
  "$NODE_BIN" -e \
    'process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).counters))' "$1"
}

simulation_first=$(simulation_step noResult \
  '{"noResult":{},"productFailure":{},"rewinds":{}}')
assert_rc 0 "$?" "editor-step принимает тот же fixture маршрута"
assert_eq noResult "$(json_field "$simulation_first" action retry)" \
  "первый noResult повторяется как у dispatcher"
simulation_second=$(simulation_step noResult "$(simulation_counters "$simulation_first")")
assert_eq noResult "$(json_field "$simulation_second" action retry)" \
  "второй noResult тратит последний retry-бюджет"
simulation_done=$(simulation_step done "$(simulation_counters "$simulation_second")")
assert_eq review "$(json_field "$simulation_done" cursor nodeId)" \
  "после двух молчаний и done симуляция попадает туда же, куда dispatcher"

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
exhausted_run_file=$(run_state_active_file "$exhausted_task" BUILD)
assert_eq failed "$(pipeline_store_get "$exhausted_task" BUILD)" \
  "synthetic exhausted closes the running stage projection"
assert_eq committed "$(_run_state_get "$exhausted_run_file" STATE)" \
  "synthetic exhausted closes the exact run fencing record"
assert_eq failed "$(_run_state_get "$exhausted_run_file" RESULT)" \
  "closed run records a failed provider attempt for diagnostics"
route_v2_dispatch_next "$exhausted_task" "$exhausted_attempt" >/dev/null
assert_rc 21 "$?" "stopped cursor reports terminal state on the next dispatch"

# --- Продолжение после exhausted: бюджет повторов обнуляется доверенным возвратом ---
# stop=human с исходом exhausted — внешний сбой (раннер не зафиксировал результат,
# например лежал провайдер), а не исход агента: resume возвращает курсор на узел
# сам, без отдельного goto, и новый заход заводит бюджет повторов заново.
rewound=$(route_v2_rewind_exhausted_stop "$exhausted_task" "$exhausted_attempt")
assert_rc 0 "$?" "resume rewind after exhausted stop is trusted"
assert_eq build "$rewound" "cursor returns exactly to the exhausted node"
resume_cursor=$(attempt_stage_state_read_v2 "$exhausted_task" "$exhausted_attempt")
assert_eq ready "$(json_field "$resume_cursor" state)" \
  "rewound cursor is runnable again"
assert_eq build "$(json_field "$resume_cursor" currentNode)" \
  "cursor lands on the exhausted node"
# Эпоха фейка живёт в переменной, а dispatch уходит в сабшелл command
# substitution: продолжение обязано начать строго больше закрытого fencing
# рекорда, иначе run_state_begin откажет кодом 73 и заход снова сожжёт бюджет.
FAKE_EPOCH=$(_run_state_get "$exhausted_run_file" EPOCH)
SILENT_LEFT=0
: >"$CALLS_LOG"
advanced=$(route_v2_dispatch_next "$exhausted_task" "$exhausted_attempt")
assert_rc 0 "$?" "replayed node runs with a fresh retry budget"
assert_eq 1 "$(wc -l <"$CALLS_LOG")" \
  "fresh budget spends exactly one attempt when the runner recovers"
assert_eq review "$(json_field "$advanced" currentNode)" \
  "route advances after the replayed node commits"

# --- Общий предохранитель автономных rewind-петель ---
# Published route разрешает REVIEW failed → BUILD, но движок обязан остановить
# третью одинаковую дугу даже для уже закреплённого бандла без собственного лимита.
run_agent() {
  local task=$1 prompt=$2 stage=$3 file result=done
  [[ "${FACTORY_ROUTE_FILESYSTEM_POLICY:-}" =~ ^(state-only|workspace-write|transactional-write)$ ]] ||
    return 91
  printf '%s\n' "$stage" >>"$CALLS_LOG"
  FAKE_EPOCH=$((FAKE_EPOCH + 1))
  [[ "$stage" != REVIEW ]] || result=failed
  file=$(run_state_active_file "$task" "$stage") || return
  MULTI_LAST_RUN_ID="fake-${stage}-${FAKE_EPOCH}"
  MULTI_LAST_RUN_EPOCH=$FAKE_EPOCH
  _run_state_write \
    "$file" "fake-${stage}-${FAKE_EPOCH}" "$FAKE_EPOCH" \
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    committed "$result"
}

ATTEMPT_STATE_ID_OVERRIDE=a_90049004900490049004900490049004
rewind_attempt=$(attempt_state_begin_v2 "$rewind_task" "$profile_id" "$routes_dir")
begin_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
assert_rc 0 "$begin_rc" "rewind-limit scenario attempt begins"
attempt_state_select_route_v2 "$rewind_task" "$rewind_attempt" trivial >/dev/null
assert_rc 0 "$?" "trivial route pins for rewind-limit scenario"
route_v2_dispatch_bootstrap "$rewind_task" "$rewind_attempt" >/dev/null
assert_rc 0 "$?" "rewind-limit scenario bootstrap commits"
attempt_stage_state_init_v2 "$rewind_task" "$rewind_attempt" trivial >/dev/null
assert_rc 0 "$?" "rewind-limit scenario cursor initializes"

: >"$CALLS_LOG"
route_v2_dispatch_until_pause "$rewind_task" "$rewind_attempt" 8 >/dev/null
assert_rc 21 "$?" "third autonomous review rewind reaches a trusted stop"
assert_eq 6 "$(wc -l <"$CALLS_LOG")" \
  "exactly two BUILD replays run before the third review stops"
rewind_cursor=$(attempt_stage_state_read_v2 "$rewind_task" "$rewind_attempt")
assert_eq stopped "$(json_field "$rewind_cursor" state)" \
  "dispatcher leaves no runnable cursor after the loop limit"
assert_eq rewind-limit "$(json_field "$rewind_cursor" stop)" \
  "dispatcher exposes the engine-level stop reason"
assert_eq review "$(json_field "$rewind_cursor" lastCommit node)" \
  "stop identifies the repeatedly failing source node"
assert_eq failed "$(json_field "$rewind_cursor" lastCommit outcome)" \
  "stop preserves the product outcome that requested rewind"
not_rewound=$(route_v2_rewind_exhausted_stop "$rewind_task" "$rewind_attempt")
assert_rc 0 "$?" "resume rewind ignores an automation loop stop"
assert_eq "" "$not_rewound" \
  "rewind-limit still waits for an explicit human goto with a fresh hypothesis"

# --- Host-side evidence hook может отклонить красивый done от runner'а ---
EVIDENCE_HOOK_LOG="$TEST_ROOT/evidence-hook.log"
EVIDENCE_RUNS_LOG="$TEST_ROOT/evidence-runs.log"
EVIDENCE_REASON='fixture-guard: manifest нельзя полностью выполнить: frontend:tests/unit/x.test.mjs'
profile_route_node_evidence_check() {
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$@" >>"$EVIDENCE_HOOK_LOG"
  [[ "$4" == BUILD ]] || return 0
  # Диагноз сторожа — последней строкой stderr, как у профильных скриптов.
  printf 'fixture-guard: подробности выше\n%s\n' "$EVIDENCE_REASON" >&2
  return 78
}
run_agent() {
  local task=$1 prompt=$2 stage=$3 file
  FAKE_EPOCH=$((FAKE_EPOCH + 1))
  printf '%s\t%s\t%s\t%s\n' "$stage" "${FACTORY_STAGE_RETRY:-}" \
    "${FACTORY_STAGE_RETRY_REASON:-}" "${FACTORY_STAGE_RETRY_NOTE:-}" >>"$EVIDENCE_RUNS_LOG"
  file=$(run_state_active_file "$task" "$stage") || return
  MULTI_LAST_RUN_ID="fake-${stage}-${FAKE_EPOCH}"
  MULTI_LAST_RUN_EPOCH=$FAKE_EPOCH
  _run_state_write \
    "$file" "fake-${stage}-${FAKE_EPOCH}" "$FAKE_EPOCH" \
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    committed done 'всё готово'
}

ATTEMPT_STATE_ID_OVERRIDE=a_90059005900590059005900590059005
evidence_attempt=$(attempt_state_begin_v2 "$evidence_task" "$profile_id" "$routes_dir")
begin_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
assert_rc 0 "$begin_rc" "evidence-hook scenario attempt begins"
attempt_state_select_route_v2 "$evidence_task" "$evidence_attempt" trivial >/dev/null
assert_rc 0 "$?" "trivial route pins for evidence-hook scenario"
route_v2_dispatch_bootstrap "$evidence_task" "$evidence_attempt" >/dev/null
assert_rc 0 "$?" "evidence-hook scenario bootstrap commits"
attempt_stage_state_init_v2 "$evidence_task" "$evidence_attempt" trivial >/dev/null
assert_rc 0 "$?" "evidence-hook scenario cursor initializes"

evidence_stopped=$(route_v2_dispatch_next "$evidence_task" "$evidence_attempt")
assert_rc 0 "$?" "host evidence rejection becomes a committed product outcome"
assert_eq stopped "$(json_field "$evidence_stopped" state)" \
  "rejected evidence stops the route"
assert_eq human "$(json_field "$evidence_stopped" stop)" \
  "rejected evidence wakes a human instead of retrying no-result"
assert_eq failed "$(json_field "$evidence_stopped" lastCommit outcome)" \
  "runner done is replaced by trusted failed"
evidence_prefix="${evidence_task}"$'\ttrivial\tbuild\tBUILD\tdone'
assert_contains "$(cat "$EVIDENCE_HOOK_LOG")" "$evidence_prefix" \
  "hook receives task, route, node, runKey, runner result and exact runId"
# Отказ сторожа — не слепой retry и не сразу человек: один повтор с цитатой причины
# (t8702: агент устранил бы лишнюю строку manifest сам), и только второй отказ подряд
# останавливает маршрут. Причина при этом переезжает в реестр поверх победного отчёта.
assert_eq 2 "$(grep -c $'\tBUILD\tdone' "$EVIDENCE_HOOK_LOG")" \
  "rejected evidence is re-checked exactly once more before stopping"
assert_eq $'BUILD\t1\t\t' "$(grep '^BUILD' "$EVIDENCE_RUNS_LOG" | sed -n '1p')" \
  "first BUILD run is a plain initial run"
assert_eq $'BUILD\t2\tevidence-rejected\t'"$EVIDENCE_REASON" \
  "$(grep '^BUILD' "$EVIDENCE_RUNS_LOG" | sed -n '2p')" \
  "second BUILD run is an evidence retry quoting the guard's last line"
assert_eq 2 "$(grep -c '^BUILD' "$EVIDENCE_RUNS_LOG")" \
  "evidence retry budget is one: no third run without a human"
assert_eq failed "$(pipeline_store_get "$evidence_task" BUILD)" \
  "registry shows the trusted failed, not the runner's done"
assert_eq "сторож отверг сдачу — $EVIDENCE_REASON" \
  "$(pipeline_store_get "$evidence_task" BUILD_COMMENT)" \
  "registry comment carries the guard reason for the stop card"

# --- Полный no-ship lifecycle: mandatory verify/triage, reject и approve ворот ---
unset -f profile_route_node_evidence_check
HUNT_CALLS="$TEST_ROOT/hunt-calls.log"
CONTEXT_DELIVERY=disabled
run_agent() {
  local task=$1 prompt=$2 stage=$3 file result=done
  FAKE_EPOCH=$((FAKE_EPOCH + 1))
  case "$stage" in HUNT_*) result=skipped ;; esac
  printf '%s\t%s\n' "$stage" "$result" >>"$HUNT_CALLS"
  file=$(run_state_active_file "$task" "$stage") || return
  MULTI_LAST_RUN_ID="fake-${stage}-${FAKE_EPOCH}"
  MULTI_LAST_RUN_EPOCH=$FAKE_EPOCH
  _run_state_write \
    "$file" "fake-${stage}-${FAKE_EPOCH}" "$FAKE_EPOCH" \
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    committed "$result"
}

ATTEMPT_STATE_ID_OVERRIDE=a_90069006900690069006900690069006
hunt_attempt=$(attempt_state_begin_v2 "$hunt_task" "$profile_id" "$routes_dir")
begin_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
assert_rc 0 "$begin_rc" "no-ship hunt attempt begins"
attempt_state_select_route_v2 "$hunt_task" "$hunt_attempt" hunt >/dev/null
assert_rc 0 "$?" "hunt route pins from the same immutable catalog"
route_v2_dispatch_bootstrap "$hunt_task" "$hunt_attempt" >/dev/null
assert_rc 0 "$?" "hunt bootstrap accepts disabled delivery context"
attempt_stage_state_init_v2 "$hunt_task" "$hunt_attempt" hunt >/dev/null
assert_rc 0 "$?" "hunt cursor initializes without a SHIP node"

route_v2_dispatch_until_pause "$hunt_task" "$hunt_attempt" 16 >/dev/null
assert_rc 20 "$?" "zero-findings hunt reaches GATE_ACCEPT after mandatory verify and triage"
assert_contains "$(cat "$HUNT_CALLS")" $'VERIFY\tdone' \
  "VERIFY runs even when every lens is skipped"
assert_contains "$(cat "$HUNT_CALLS")" $'TRIAGE\tdone' \
  "TRIAGE runs even when every lens is skipped"
if grep -q '^SHIP' "$HUNT_CALLS"; then
  test_fail "no-ship hunt never executes delivery" "$(cat "$HUNT_CALLS")"
else
  test_ok "no-ship hunt never executes delivery"
fi

route_v2_gate_decide "$hunt_task" "$hunt_attempt" gate_accept rejected >/dev/null
assert_rc 0 "$?" "hunt rejection is committed"
hunt_cursor=$(attempt_stage_state_read_v2 "$hunt_task" "$hunt_attempt")
assert_eq triage "$(json_field "$hunt_cursor" currentNode)" \
  "hunt rejection rewinds only the report"
route_v2_dispatch_next "$hunt_task" "$hunt_attempt" >/dev/null
assert_rc 0 "$?" "triage reruns after rejection"
route_v2_dispatch_next "$hunt_task" "$hunt_attempt" >/dev/null
assert_rc 20 "$?" "hunt pauses at acceptance again"
route_v2_gate_decide "$hunt_task" "$hunt_attempt" gate_accept approved >/dev/null
assert_rc 0 "$?" "approved hunt advances directly to RETRO"
route_v2_dispatch_until_pause "$hunt_task" "$hunt_attempt" 4 >/dev/null
assert_rc 21 "$?" "hunt terminates done without delivery tail"
hunt_terminal=$(attempt_stage_state_read_v2 "$hunt_task" "$hunt_attempt")
assert_eq done "$(json_field "$hunt_terminal" stop)" \
  "approved no-ship report has a normal done terminal"

# --- Trusted command executor: без модели, со строгим JSON verdict и owner routing ---
COMMAND_CAPABILITIES="$TEST_ROOT/profiles/$profile_id/routes/editor-capabilities.json"
mkdir -p -- "$(dirname "$COMMAND_CAPABILITIES")"
cat >"$COMMAND_CAPABILITIES" <<'JSON'
{"schema":1,"commands":[{"id":"fixture-verify","label":"Проверка","filesystem":["state-only"]}],"contextSections":[]}
JSON
DECLARED_COMMAND_ID=$("$NODE_BIN" -e '
  const fs = require("node:fs");
  process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).commands[0].id);
' "$COMMAND_CAPABILITIES")
COMMAND_HOOK_LOG="$TEST_ROOT/command-hook.log"
COMMAND_AGENT_LOG="$TEST_ROOT/command-agent.log"
COMMAND_OUTCOME=failed
profile_route_command() {
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$@" >>"$COMMAND_HOOK_LOG"
  if [[ "$5" != "$DECLARED_COMMAND_ID" ]]; then
    return 78
  fi
  if [[ "$COMMAND_OUTCOME" == failed ]]; then
    printf '%s\n' \
      '{"schema":1,"outcome":"failed","comment":"fixture check failed","failureOwner":"build","findings":[{"id":"fixture-check","summary":"детерминированная проверка не прошла"}]}'
  else
    printf '%s\n' \
      '{"schema":1,"outcome":"done","comment":"fixture check passed","failureOwner":null,"findings":[]}'
  fi
}
run_agent() {
  local task=$1 prompt=$2 stage=$3 file
  printf '%s\n' "$stage" >>"$COMMAND_AGENT_LOG"
  FAKE_EPOCH=$((FAKE_EPOCH + 1))
  file=$(run_state_active_file "$task" "$stage") || return
  MULTI_LAST_RUN_ID="fake-${stage}-${FAKE_EPOCH}"
  MULTI_LAST_RUN_EPOCH=$FAKE_EPOCH
  _run_state_write \
    "$file" "fake-${stage}-${FAKE_EPOCH}" "$FAKE_EPOCH" \
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    committed done
}

ATTEMPT_STATE_ID_OVERRIDE=a_90079007900790079007900790079007
command_attempt=$(attempt_state_begin_v2 "$command_task" "$profile_id" "$routes_dir")
begin_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
assert_rc 0 "$begin_rc" "trusted-command scenario attempt begins"
attempt_state_select_route_v2 "$command_task" "$command_attempt" command >/dev/null
assert_rc 0 "$?" "command route pins from the immutable catalog"
route_v2_dispatch_bootstrap "$command_task" "$command_attempt" >/dev/null
assert_rc 0 "$?" "command scenario bootstrap commits"
attempt_stage_state_init_v2 "$command_task" "$command_attempt" command >/dev/null
assert_rc 0 "$?" "command cursor initializes"

: >"$COMMAND_AGENT_LOG"
: >"$COMMAND_HOOK_LOG"
route_v2_dispatch_next "$command_task" "$command_attempt" >/dev/null
assert_rc 0 "$?" "preparation agent advances to command"
agent_calls_before=$(wc -l <"$COMMAND_AGENT_LOG")
command_rewind=$(route_v2_dispatch_next "$command_task" "$command_attempt")
assert_rc 0 "$?" "trusted command commits typed failed"
assert_eq "$agent_calls_before" "$(wc -l <"$COMMAND_AGENT_LOG")" \
  "command executor does not invoke a model runner"
assert_eq prepare "$(json_field "$command_rewind" currentNode)" \
  "command failureOwner build selects the declared rewind"
assert_contains "$(cat "$COMMAND_HOOK_LOG")" \
  $'9007\tcommand\tverify\tVERIFY\tfixture-verify' \
  "profile hook receives the pinned command identity"
command_findings=$(attempt_stage_state_findings_v2 "$command_task" "$command_attempt")
assert_eq fixture-check "$(json_field "$command_findings" open 0 id)" \
  "typed command finding enters the trusted ledger"

route_v2_dispatch_next "$command_task" "$command_attempt" >/dev/null
assert_rc 0 "$?" "author reruns after command rewind"
COMMAND_OUTCOME=done
command_advanced=$(route_v2_dispatch_next "$command_task" "$command_attempt")
assert_rc 0 "$?" "successful command advances without a model"
assert_eq retro "$(json_field "$command_advanced" currentNode)" \
  "successful trusted command reaches the tail"
command_findings=$(attempt_stage_state_findings_v2 "$command_task" "$command_attempt")
assert_eq 0 "$(json_field "$command_findings" open length)" \
  "successful repeat removes the command finding from open projection"
assert_eq fixture-check "$(json_field "$command_findings" closed 0 id)" \
  "closed command finding remains auditable"
route_v2_dispatch_until_pause "$command_task" "$command_attempt" 2 >/dev/null
assert_rc 21 "$?" "command route terminates normally"
unknown_command_output="$TEST_ROOT/unknown-command.out"
profile_route_command "$command_task" command verify VERIFY unknown-command state-only \
  >"$unknown_command_output"
assert_rc 78 "$?" "trusted hook rejects an ID absent from editor-capabilities.json"
assert_eq '' "$(cat "$unknown_command_output")" \
  "unknown command produces no executable verdict"

# Вход в проверяющего: задание → автор → приёмка. Отдельной разведки нет,
# а новый current не меняет политику уже закреплённой попытки.
direct_routes="$TEST_ROOT/direct-routes"
direct_publisher="$TEST_ROOT/publish-direct.mjs"
cat >"$direct_publisher" <<'JS'
import { pathToFileURL } from 'node:url';

const [root, baseDir, policy] = process.argv.slice(2);
const { RoutesStore } = await import(pathToFileURL(`${root}/server/src/modules/routes/store.ts`));
const fixtures = await import(pathToFileURL(`${root}/tests/engine/fixtures/routes-catalog-definitions.mjs`));
const route = structuredClone(fixtures.ROUTE_DEFINITIONS.trivial.route);
route.id = 'direct';
route.bootstrap = policy;
route.entry = 'review';
route.sequence = { main: ['build', 'review'], tail: [] };
route.nodes = route.nodes.filter((node) => ['build', 'review'].includes(node.id));
route.nodes.find((node) => node.id === 'review').on.done = { stop: 'done' };
const prompts = {
  'prompts/build.base.md': 'Исполни задание из artifacts.plan и открытых findings. Запиши artifacts.report.',
  'prompts/review.base.md': 'Подготовь задание, затем проверь отчёт. При замечаниях верни автору.',
};
for (const node of route.nodes) {
  node.prompt.requiredContext = ['task', 'artifacts', 'evidence'];
}
const bootstrap = structuredClone(fixtures.bootstrap);
bootstrap.nodes[0].on.done.escalate.routes = ['direct'];
bootstrap.escalation[0].allowedRoutes = ['direct'];
const store = new RoutesStore({ baseDir });
const previous = await store.readCurrent(fixtures.PROFILE_ID);
const published = await store.publishRoute(fixtures.PROFILE_ID, route.id, { route, prompts });
const result = await store.publishCatalog(fixtures.PROFILE_ID, {
  catalog: {
    schema: 2, profile: fixtures.PROFILE_ID,
    routes: { direct: published.routeHash }, bootstrap: { file: 'bootstrap/scout.json' },
  },
  bootstrap,
  prompts: fixtures.bootstrapPrompts,
}, { expectedCatalogHash: previous?.catalogHash ?? null });
process.stdout.write(result.catalogHash);
JS
direct_catalog=$("$NODE_BIN" "$direct_publisher" "$FACTORY_HOME/.." "$direct_routes" skip)
assert_rc 0 "$?" "двухузловой цикл без SCOUT публикуется в изолированный каталог"
direct_task=9009
direct_attempt=$(attempt_state_begin_v2 "$direct_task" "$profile_id" "$direct_routes")
assert_rc 0 "$?" "попытка прямого входа создаётся"
attempt_state_select_route_v2 "$direct_task" "$direct_attempt" direct >/dev/null
assert_rc 0 "$?" "маршрут прямого входа закреплён"

source <(sed -n '/^v2_registry_stage_keys() {/,/^}/p' "$FACTORY_HOME/bin/factory")
PROFILE=$profile_id ROUTES_DIR=$direct_routes ROUTE=direct \
  direct_keys=$(v2_registry_stage_keys "$direct_catalog")
assert_eq 'BUILD REVIEW' "$direct_keys" "реестр не содержит неисполняемого SCOUT"

DIRECT_CALLS="$TEST_ROOT/direct-calls.log"
: >"$DIRECT_CALLS"
route_v2_context_for_node() {
  local findings
  findings=$(attempt_stage_state_findings_v2 "$1" "$2") || return
  "$NODE_BIN" - "$FIXTURE_CONTEXT" "$5" "$STATE_DIR" "$findings" <<'JS'
const fs = require('node:fs');
const [source, output, state, findings] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(source, 'utf8'));
value.artifacts = { plan: `${state}/direct.plan`, report: `${state}/direct.report` };
value.evidence.findings = JSON.parse(findings);
value.delivery = { mode: 'disabled', actions: [], targetBranches: {}, sourceBranch: 'fixture' };
fs.writeFileSync(output, JSON.stringify(value));
JS
}
run_agent() {
  local task=$1 prompt=$2 stage=$3 file result=done verdict='' epoch
  printf '%s\n' "$stage" >>"$DIRECT_CALLS"
  epoch=$(wc -l <"$DIRECT_CALLS")
  case "$stage" in
    REVIEW)
      if [[ ! -f "$STATE_DIR/direct.report" ]]; then
        printf '%s\n' 'Реализовать незакрытый сценарий' >"$STATE_DIR/direct.plan"
        result=failed
        verdict=$(run_state_verdict_encode failed build \
          'remaining-scenario=Требуемый сценарий ещё не реализован') || return
      else
        [[ "$(cat "$STATE_DIR/direct.report")" == 'Сценарий проверен' ]] || return 92
      fi
      ;;
    BUILD)
      [[ "$(cat "$STATE_DIR/direct.plan")" == 'Реализовать незакрытый сценарий' ]] || return 93
      [[ "$prompt" == *remaining-scenario* ]] || return 94
      printf '%s\n' 'Сценарий проверен' >"$STATE_DIR/direct.report"
      ;;
    *) return 95 ;;
  esac
  file=$(run_state_active_file "$task" "$stage") || return
  _run_state_write "$file" "direct-${stage}-${epoch}" "$epoch" \
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    committed "$result" '' "$verdict"
}

direct_bootstrap=$(route_v2_dispatch_bootstrap "$direct_task" "$direct_attempt")
assert_rc 0 "$?" "явная политика пропускает отдельную разведку"
assert_eq skipped "$(json_field "$direct_bootstrap" bootstrap)" "пропуск не выдаётся за работу агента"
assert_eq '' "$(cat "$DIRECT_CALLS")" "bootstrap не вызывает модель"
direct_root=$(attempt_state_v2_task_root "$direct_task")
[[ ! -e "$direct_root/attempts/$direct_attempt/artifacts/bootstrap.json" ]]
assert_rc 0 "$?" "фиктивный результат SCOUT не создаётся"
direct_cursor=$(attempt_stage_state_init_v2 "$direct_task" "$direct_attempt" direct)
assert_rc 0 "$?" "курсор инициализируется без разведки"
assert_eq review "$(json_field "$direct_cursor" currentNode)" "первым запускается проверяющий"
route_v2_dispatch_next "$direct_task" "$direct_attempt" >/dev/null
assert_rc 0 "$?" "постановка проверяющего передаёт незакрытый критерий автору"
direct_findings=$(attempt_stage_state_findings_v2 "$direct_task" "$direct_attempt")
assert_eq remaining-scenario "$(json_field "$direct_findings" open 0 id)" "задание сохранено в findings"

"$NODE_BIN" "$direct_publisher" "$FACTORY_HOME/.." "$direct_routes" required >/dev/null
assert_rc 0 "$?" "новый current снова требует разведку"
route_v2_dispatch_bootstrap "$direct_task" "$direct_attempt" >/dev/null
assert_rc 0 "$?" "resume сохраняет skip из прежнего route pin"
assert_eq REVIEW "$(cat "$DIRECT_CALLS")" "после смены current лишний агент не запускается"
route_v2_dispatch_next "$direct_task" "$direct_attempt" >/dev/null
assert_rc 0 "$?" "автор получает план и findings и возвращает отчёт"
direct_terminal=$(route_v2_dispatch_next "$direct_task" "$direct_attempt")
assert_rc 0 "$?" "повторная проверка принимает отчёт без ручных ворот"
assert_eq done "$(json_field "$direct_terminal" stop)" "цикл завершается принятием"
assert_eq $'REVIEW\nBUILD\nREVIEW' "$(cat "$DIRECT_CALLS")" \
  "фактический порядок ровно проверка → автор → проверка"
direct_findings=$(attempt_stage_state_findings_v2 "$direct_task" "$direct_attempt")
assert_eq 0 "$(json_field "$direct_findings" open length)" "принятие закрывает незавершённые критерии"
assert_eq remaining-scenario "$(json_field "$direct_findings" closed 0 id)" \
  "история передачи остаётся в журнале"

finish_tests
