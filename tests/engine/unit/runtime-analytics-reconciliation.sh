#!/usr/bin/env bash
# Проверяет reconciliation runtime-аналитики: он связывает неизменяемые usage-документы
# с lifecycle-событиями и закрывает только точные разрывы после падения.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/attempt-stage-state.sh"
source "$FACTORY_HOME/lib/runtime-analytics.sh"
source "$FACTORY_HOME/lib/runner-launcher.sh"

publisher="$FACTORY_TESTS_HOME/fixtures/routes-publish.mjs"
routes_dir="$TEST_ROOT/routes"
task=71
attempt=a_71717171717171717171717171717171

json_file_value() {
  runtime_analytics_json_get_v2 "$1" "$2"
}

lifecycle_rows() {
  attempt_lifecycle_read_v2 "$task" "$attempt"
}

lifecycle_count() {
  local kind=$1
  lifecycle_rows | python3 -c '
import json, sys
kind = sys.argv[1]
print(sum(json.loads(line).get("kind") == kind for line in sys.stdin))
' "$kind"
}

lifecycle_last() {
  local kind=$1 output=$2
  lifecycle_rows | python3 -c '
import json, sys
kind, output = sys.argv[1:]
matches = [json.loads(line) for line in sys.stdin if json.loads(line).get("kind") == kind]
if not matches:
    raise SystemExit(3)
with open(output, "w", encoding="utf-8") as target:
    json.dump(matches[-1], target, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    target.write("\n")
' "$kind" "$output"
}

make_usage_document() {
  local run_id=$1 epoch=$2 observed_at=$3
  "$NODE_BIN" --input-type=module - \
    "$FACTORY_HOME/../server/src/lib/analytics/usageDocument.ts" \
    "$usage_dir/$run_id.json" "$attempt" "$run_id" "$epoch" "$observed_at" <<'NODE'
import { chmodSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [modulePath, output, attemptId, runId, epochRaw, observedAt] = process.argv.slice(2);
const { buildUsageDocument, encodeUsageDocument } = await import(pathToFileURL(modulePath));
const zeros = Object.freeze({
  uncachedInput: '0', output: '0', cacheRead: '0',
  cacheWrite5m: '0', cacheWrite1h: '0', cacheWriteUnknown: '0',
});
const document = buildUsageDocument({
  identity: {
    taskId: 't71', attemptId,
    nodeVisitId: 'nv_11111111111111111111111111111111',
    nodeExecutionId: 'ne_22222222222222222222222222222222',
    dispatchId: 'd_33333333333333333333333333333333',
    runId, epoch: Number(epochRaw),
  },
  provider: 'fake',
  requestedModel: 'fake-model',
  resolvedModel: 'fake-model',
  observedAt,
  sourceFingerprint: {
    dev: '1', ino: '2', size: '0', mtimeNs: '3',
    sha256: '4'.repeat(64), finalFstatHash: '5'.repeat(64), rawFsyncCompleted: true,
  },
  providerSessionMode: 'fresh',
  normalization: {
    provider: 'fake', normalizerDialect: 'fixture/1', extractorVersion: 'fixture/1',
    source: 'unavailable', completeness: 'missing', provenance: 'exact',
    samples: [], usageSegments: [], tokenSummary: zeros,
    providerReportedCost: null, providerRootResult: null,
    terminalCounterCheckpoint: null, lastObservedCounter: null,
    diagnostics: ['usageUnavailable'],
  },
});
writeFileSync(output, encodeUsageDocument(document), { mode: 0o600, flag: 'wx' });
chmodSync(output, 0o600);
NODE
}

published=$("$NODE_BIN" "$publisher" "$routes_dir" 'analytics reconciliation' null)
assert_rc 0 "$?" "route fixture for reconciliation is published"
catalog_hash=$("$NODE_BIN" -e \
  'process.stdout.write(JSON.parse(process.argv[1]).catalogHash)' "$published")
route_hash=$("$NODE_BIN" -e \
  'process.stdout.write(JSON.parse(process.argv[1]).routeHash)' "$published")
ATTEMPT_STATE_ID_OVERRIDE=$attempt
created=$(attempt_state_begin_v2 "$task" demo-profile "$routes_dir")
unset ATTEMPT_STATE_ID_OVERRIDE
assert_eq "$attempt" "$created" "reconciliation attempt is created with stable identity"
attempt_state_select_route_v2 "$task" "$attempt" debug >/dev/null
assert_rc 0 "$?" "reconciliation attempt pins its route"
ATTEMPT_STAGE_STATE_TIME_OVERRIDE=2026-08-20T01:00:00Z \
  attempt_stage_state_init_v2 "$task" "$attempt" debug >/dev/null
assert_rc 0 "$?" "stage ledger initializes before lifecycle reconciliation"

attempt_lifecycle_init_v2 "$task" "$attempt"
assert_rc 0 "$?" "lifecycle ledger initializes for reconciliation"
runtime_lifecycle_set_context_v2 \
  "$task" "$attempt" demo-profile '' '' os_11111111111111111111111111111111 >/dev/null
runtime_lifecycle_session_begin_v2 initial '' >/dev/null
assert_rc 0 "$?" "initial analytics writer session opens"
runtime_lifecycle_set_route_v2 debug "$route_hash"
runtime_lifecycle_route_selected_v2 \
  "$catalog_hash" "$(printf pin | sha256sum | awk '{print $1}')" \
  2026-08-20T01:00:00.000Z operator_override >/dev/null
assert_rc 0 "$?" "route pin enters lifecycle before scoped events"

ATTEMPT_STAGE_STATE_TIME_OVERRIDE=2026-08-20T01:00:05Z \
  attempt_stage_state_commit_v2 "$task" "$attempt" instrument done >/dev/null
assert_rc 0 "$?" "stage transition commits before its lifecycle side"
stage_projection="$TEST_ROOT/stage-transitions.ndjson"
attempt_stage_state_routing_transitions_v2 "$task" "$attempt" >"$stage_projection"
assert_rc 0 "$?" "routing projection is emitted from the verified stage chain"
assert_eq 1 "$(wc -l <"$stage_projection" | tr -d ' ')" \
  "init and pause are excluded from routing transitions"
stage_hash=$(json_file_value "$stage_projection" stageEventHash)
assert_eq next "$(json_file_value "$stage_projection" action)" \
  "forward stage commit projects action=next"
assert_eq check "$(json_file_value "$stage_projection" targetNodeId)" \
  "routing projection preserves its exact target"

runtime_lifecycle_reconcile_routing_v2 "$task" "$attempt" >/dev/null
assert_rc 0 "$?" "writable reconciliation appends the missing routing side"
routing_event="$TEST_ROOT/routing-event.json"
lifecycle_last routing_transition_reconciled "$routing_event"
assert_rc 0 "$?" "reconciled routing event is readable from the durable ledger"
assert_eq "$stage_hash" "$(json_file_value "$routing_event" details.stageEventHash)" \
  "routing reconciliation joins by exact stage bytes"
assert_eq 2026-08-20T01:00:05.000Z "$(json_file_value "$routing_event" at)" \
  "routing reconciliation retains the original stage timestamp"
assert_eq derived "$(json_file_value "$routing_event" clock.fidelity)" \
  "routing reconciliation labels its reconstructed clock fidelity"
runtime_lifecycle_reconcile_routing_v2 "$task" "$attempt" >/dev/null
assert_rc 0 "$?" "routing reconciliation retry is idempotent"
assert_eq 1 "$(lifecycle_count routing_transition_reconciled)" \
  "routing reconciliation never duplicates a repaired transition"

runtime_lifecycle_session_finish_v2 succeeded normal '' >/dev/null
assert_rc 0 "$?" "first writer session closes normally"
runtime_lifecycle_set_context_v2 \
  "$task" "$attempt" demo-profile debug "$route_hash" \
  os_22222222222222222222222222222222 >/dev/null
crashed_start=$(runtime_lifecycle_session_begin_v2 resume os_11111111111111111111111111111111)
assert_rc 0 "$?" "session used by crash fixture starts durably"
open_session="$TEST_ROOT/open-session.json"
session_stderr="$TEST_ROOT/open-session.stderr"
runtime_lifecycle_previous_open_session_v2 "$task" "$attempt" "$open_session" 2>"$session_stderr"
assert_rc 0 "$?" "unclosed prior orchestrator session is detected"
[[ ! -s "$session_stderr" ]]
assert_rc 0 "$?" "успешный поиск открытой сессии не пишет в stderr"
assert_eq os_22222222222222222222222222222222 \
  "$(json_file_value "$open_session" orchestratorSessionId)" \
  "crash detector returns the exact open session"
crashed_hash=$(json_file_value "$open_session" eventHash)

runtime_lifecycle_set_context_v2 \
  "$task" "$attempt" demo-profile debug "$route_hash" \
  os_33333333333333333333333333333333 >/dev/null
runtime_lifecycle_session_begin_v2 resume os_22222222222222222222222222222222 >/dev/null
runtime_lifecycle_attempt_interrupted_v2 crash_detected "$crashed_hash" >/dev/null
assert_rc 0 "$?" "new writer records crash_detected against prior start hash"
runtime_lifecycle_session_finish_v2 succeeded normal '' >/dev/null
assert_rc 0 "$?" "replacement session closes normally"
runtime_lifecycle_previous_open_session_v2 "$task" "$attempt" "$open_session" \
  >/dev/null 2>"$session_stderr"
assert_rc 3 "$?" "crash marker prevents rediscovering the old open session forever"
[[ ! -s "$session_stderr" ]]
assert_rc 0 "$?" "штатное отсутствие открытой сессии не пишет в stderr"
assert_eq 1 "$(lifecycle_count attempt_interrupted)" \
  "exact crashed session receives one interruption marker"

# Открываем одну writable-сессию terminal-раннера и публикуем только сторону
# неизменяемого документа. Общий финализатор/startup-reconciler должен связать её с
# точной идентичностью runner_finished и один раз дописать недостающую lifecycle-сторону.
runtime_lifecycle_set_context_v2 \
  "$task" "$attempt" demo-profile debug "$route_hash" \
  os_44444444444444444444444444444444 >/dev/null
runtime_lifecycle_session_begin_v2 resume os_33333333333333333333333333333333 >/dev/null
export FACTORY_LIFECYCLE_NODE_VISIT_ID=nv_11111111111111111111111111111111
export FACTORY_LIFECYCLE_NODE_EXECUTION_ID=ne_22222222222222222222222222222222
export FACTORY_LIFECYCLE_NODE_ID=instrument
export FACTORY_LIFECYCLE_RUN_KEY=CHECK
export FACTORY_LIFECYCLE_DISPATCH_ID=d_33333333333333333333333333333333
export FACTORY_LIFECYCLE_CANDIDATE_ORDINAL=1
IFS=$'\t' read -r runner_at runner_ns runner_boot < <(runtime_analytics_now_v2)
runner_started_out="$TEST_ROOT/runner-started.hash"
FACTORY_LIFECYCLE_EVENT_AT=$runner_at \
FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$runner_ns \
FACTORY_LIFECYCLE_EVENT_BOOT_ID=$runner_boot \
  _runner_lifecycle_started_v2 fake run-reconcile 1 fake-model high exact \
    "$BASHPID" "$BASHPID" "$BASHPID" 1 fresh '' null '' '' \
    >"$runner_started_out"
runner_started_hash=$(<"$runner_started_out")
assert_rc 0 "$?" "trusted runner start is present before usage reconciliation"
IFS=$'\t' read -r observed_at runner_end_ns runner_boot < <(runtime_analytics_now_v2)
quiescence_hash=$(printf quiesced-run-reconcile | sha256sum | awk '{print $1}')
FACTORY_LIFECYCLE_EVENT_AT=$observed_at \
FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$runner_end_ns \
FACTORY_LIFECYCLE_EVENT_BOOT_ID=$runner_boot \
  _runner_lifecycle_finished_v2 ok 0 "$runner_ns" "$runner_end_ns" \
    "$observed_at" "$quiescence_hash" >/dev/null
assert_rc 0 "$?" "trusted runner finish is durable before usage document"

usage_dir="$(attempt_state_v2_task_root "$task")/attempts/$attempt/lifecycle/usage"
make_usage_document run-reconcile 1 "$observed_at"
assert_rc 0 "$?" "doc-only terminal usage fixture is canonical and immutable"
make_usage_document run-orphan 2 "$observed_at"
assert_rc 0 "$?" "orphan usage fixture is canonical but has no trusted runner"

# Второй независимо завершённый документ доказывает, что режим capture_run финализатора
# раннера исправляет только свою идентичность. Полный startup-reconciliation по-прежнему
# отвечает за обход всех более старых разрывов после падения.
IFS=$'\t' read -r other_started_at other_started_ns other_boot < <(runtime_analytics_now_v2)
other_started_out="$TEST_ROOT/runner-other-started.hash"
FACTORY_LIFECYCLE_EVENT_AT=$other_started_at \
FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$other_started_ns \
FACTORY_LIFECYCLE_EVENT_BOOT_ID=$other_boot \
  _runner_lifecycle_started_v2 fake run-other 3 fake-model high exact \
    "$BASHPID" "$BASHPID" "$BASHPID" 1 fresh '' null '' '' \
    >"$other_started_out"
assert_rc 0 "$?" "second trusted runner start is durable"
IFS=$'\t' read -r other_observed_at other_finished_ns other_boot < <(runtime_analytics_now_v2)
other_quiescence=$(printf quiesced-run-other | sha256sum | awk '{print $1}')
FACTORY_LIFECYCLE_EVENT_AT=$other_observed_at \
FACTORY_LIFECYCLE_EVENT_MONOTONIC_NS=$other_finished_ns \
FACTORY_LIFECYCLE_EVENT_BOOT_ID=$other_boot \
  _runner_lifecycle_finished_v2 ok 0 "$other_started_ns" "$other_finished_ns" \
    "$other_observed_at" "$other_quiescence" >/dev/null
assert_rc 0 "$?" "second trusted runner finish is durable"
make_usage_document run-other 3 "$other_observed_at"
assert_rc 0 "$?" "second document-only crash gap is published"

runtime_lifecycle_reconcile_usage_v2 "$task" "$attempt" run-reconcile >/dev/null
assert_rc 0 "$?" "writable usage reconciliation repairs the document/event crash gap"
assert_eq 1 "$(lifecycle_count runner_usage_reconciled)" \
  "targeted finalizer reconciles only its requested run identity"
usage_event="$TEST_ROOT/usage-event.json"
lifecycle_last runner_usage_reconciled "$usage_event"
assert_eq run-reconcile "$(json_file_value "$usage_event" runId)" \
  "usage reconciliation keeps the trusted run identity"
assert_eq "$observed_at" "$(json_file_value "$usage_event" details.observedAt)" \
  "usage reconciliation preserves document observedAt"
assert_eq reconciled "$(json_file_value "$usage_event" details.coverage.linkCoverage)" \
  "usage reconciliation records reconciled link coverage"
assert_eq derived "$(json_file_value "$usage_event" clock.fidelity)" \
  "usage reconciliation exposes derived writer timing"
[[ "$RUNTIME_LIFECYCLE_USAGE_RECONCILED_HASH" =~ ^[a-f0-9]{64}$ ]]
assert_rc 0 "$?" "usage reconciler returns the repaired event hash to finalizer"
runtime_lifecycle_reconcile_usage_v2 "$task" "$attempt" run-reconcile >/dev/null
assert_rc 0 "$?" "usage reconciliation retry validates both commit sides"
assert_eq 1 "$(lifecycle_count runner_usage_reconciled)" \
  "usage reconciliation retry does not duplicate the event"

runtime_lifecycle_reconcile_usage_v2 "$task" "$attempt" >/dev/null
assert_rc 0 "$?" "startup usage reconciliation sweeps every remaining crash gap"
assert_eq 2 "$(lifecycle_count runner_usage_reconciled)" \
  "full sweep repairs the second exact document without accepting the orphan"

# HumanIntervention ссылается на уже завершённый NodeVisit. Новый административный
# процесс закрывает вопрос, но не получает этот исторический визит как открытый.
runtime_lifecycle_clear_entity_v2
runtime_lifecycle_node_visit_begin_v2 check CHECK 1 initial >/dev/null
assert_rc 0 "$?" "визит перед человеческой остановкой открыт"
closed_visit=$FACTORY_LIFECYCLE_NODE_VISIT_ID
runtime_lifecycle_node_visit_finish_v2 failed product_failure attempt_terminal >/dev/null
assert_rc 0 "$?" "визит завершён до ожидания человека"
runtime_lifecycle_human_begin_v2 manual_resume_required "$stage_hash" >/dev/null
assert_rc 0 "$?" "вопрос сохраняет ссылку на завершённый визит"
runtime_lifecycle_session_finish_v2 succeeded normal '' >/dev/null

runtime_lifecycle_set_context_v2 \
  "$task" "$attempt" demo-profile debug "$route_hash" \
  os_55555555555555555555555555555555 >/dev/null
runtime_lifecycle_session_begin_v2 resume os_44444444444444444444444444444444 >/dev/null
resolution_hash=$(runtime_analytics_hash_string_v2 'operator abandon')
resolution_output="$TEST_ROOT/human-resolution.hash"
runtime_lifecycle_resolve_open_human_v2 abandon "$resolution_hash" >"$resolution_output"
assert_rc 0 "$?" "первое закрытие вопроса выполнено без повторного действия человека"
assert_eq '' "${FACTORY_LIFECYCLE_NODE_VISIT_ID:-}" \
  "закрытый визит не становится текущим визитом административной команды"
assert_eq '' "${FACTORY_LIFECYCLE_NODE_ID:-}" \
  "исторический узел вопроса не меняет контекст команды"
assert_eq "$(<"$resolution_output")" "$RUNTIME_LIFECYCLE_LAST_EVENT_HASH" \
  "hash подтверждённого события доступен вызывающему процессу"
human_event="$TEST_ROOT/human-resolved.json"
lifecycle_last human_intervention_resolved "$human_event"
assert_eq "$closed_visit" "$(json_file_value "$human_event" nodeVisitId)" \
  "событие решения связано с исходным визитом"
assert_eq os_55555555555555555555555555555555 \
  "$(json_file_value "$human_event" orchestratorSessionId)" \
  "событие решения записано текущей административной сессией"
assert_eq abandon "$(json_file_value "$human_event" details.resolutionCode)" \
  "в журнале сохранено действие abandon"
runtime_lifecycle_resolve_open_human_v2 abandon "$resolution_hash" >/dev/null 2>&1
assert_rc 0 "$?" "повтор закрытия вопроса идемпотентен"
assert_eq 1 "$(lifecycle_count human_intervention_resolved)" \
  "повтор не добавляет второго решения"

# Продолжение может уже иметь собственный живой визит. Его identity и таймеры
# должны пережить закрытие старого вопроса, а событие решения хранит прежнюю связь.
runtime_lifecycle_node_visit_begin_v2 check CHECK 2 initial >/dev/null
second_closed_visit=$FACTORY_LIFECYCLE_NODE_VISIT_ID
runtime_lifecycle_node_visit_finish_v2 failed product_failure attempt_terminal >/dev/null
runtime_lifecycle_human_begin_v2 manual_resume_required "$stage_hash" >/dev/null
runtime_lifecycle_session_finish_v2 succeeded normal '' >/dev/null
runtime_lifecycle_set_context_v2 \
  "$task" "$attempt" demo-profile debug "$route_hash" \
  os_66666666666666666666666666666666 >/dev/null
runtime_lifecycle_session_begin_v2 resume os_55555555555555555555555555555555 >/dev/null
runtime_lifecycle_node_visit_begin_v2 check CHECK 3 initial >/dev/null
current_visit=$FACTORY_LIFECYCLE_NODE_VISIT_ID
current_visit_clock=$RUNTIME_LIFECYCLE_VISIT_STARTED_NS
current_visit_span=$RUNTIME_LIFECYCLE_VISIT_SPAN_ID
resolution_hash=$(runtime_analytics_hash_string_v2 'operator resume')
runtime_lifecycle_resolve_open_human_v2 resume "$resolution_hash" >/dev/null
assert_rc 0 "$?" "старый вопрос закрывается при наличии нового живого визита"
assert_eq "$current_visit" "$FACTORY_LIFECYCLE_NODE_VISIT_ID" \
  "закрытие вопроса сохраняет текущий визит"
assert_eq "$current_visit_clock" "$RUNTIME_LIFECYCLE_VISIT_STARTED_NS" \
  "таймер текущего визита не меняется"
assert_eq "$current_visit_span" "$RUNTIME_LIFECYCLE_VISIT_SPAN_ID" \
  "span текущего визита не меняется"
lifecycle_last human_intervention_resolved "$human_event"
assert_eq "$second_closed_visit" "$(json_file_value "$human_event" nodeVisitId)" \
  "решение второго вопроса не подменяет его исходный визит текущим"
runtime_lifecycle_node_visit_finish_v2 abandoned attempt_terminal attempt_terminal >/dev/null
assert_rc 0 "$?" "текущий визит корректно закрывается после решения старого вопроса"
assert_eq 3 "$(lifecycle_count node_visit_finished)" \
  "каждый визит закрыт ровно один раз"

runtime_lifecycle_session_finish_v2 succeeded normal '' >/dev/null

# Новая часть использует реальные stage/lifecycle API и новый pending wrapper.
source "$FACTORY_HOME/lib/route-runtime.sh"
export FACTORY_ROUTE_STATE_DIR="$STATE_DIR"
_route_v2_load_attempt "$task" "$attempt"
assert_rc 0 "$?" 'origin: pins загружены'
pending_before=$(attempt_stage_state_read_v2 "$task" "$attempt")
pending_sequence=$(jq -r .eventSequence <<<"$pending_before")
assert_eq check "$(jq -r .currentNode <<<"$pending_before")" 'origin: fixture стоит на check'
runtime_lifecycle_set_context_v2 "$task" "$attempt" demo-profile debug "$route_hash" \
  os_77777777777777777777777777777777 >/dev/null
runtime_lifecycle_session_begin_v2 resume os_66666666666666666666666666666666 >/dev/null
runtime_lifecycle_node_visit_begin_v2 check CHECK "$pending_sequence" recovery >/dev/null
origin_visit=$FACTORY_LIFECYCLE_NODE_VISIT_ID
origin_session=$FACTORY_LIFECYCLE_SESSION_ID
printf '%s\n' "$pending_before" >"$TEST_ROOT/pending-base.json"
printf 'postflight fixture\n' >"$TEST_ROOT/pending-tree.tsv"
pending_dir="$(attempt_state_v2_task_root "$task")/attempts/$attempt"
pending_verdict=$(run_state_verdict_encode failed environment 'origin-stop=Требуется оператор')
python3 "$FACTORY_HOME/lib/pending_transition.py" prepare "$pending_dir/pending-transition.json" \
  "$TEST_ROOT/pending-base.json" "$pending_sequence" "$TEST_ROOT/pending-tree.tsv" \
  "$task" "$attempt" check failed 0 "$pending_verdict" 0 0 0 '' 0
assert_rc 0 "$?" 'origin: captured receipt сохранён настоящим CLI'
attempt_stage_state_commit_v2 "$task" "$attempt" check failed 0 "$pending_verdict" >/dev/null
assert_rc 0 "$?" 'origin: реальный writer создал human stop'
pending_after=$(attempt_stage_state_read_v2 "$task" "$attempt")
origin_hash=$(jq -r .headEventHash <<<"$pending_after")
runtime_lifecycle_node_visit_finish_v2 failed product_failure attempt_terminal '' "$origin_hash" >/dev/null
runtime_lifecycle_session_finish_v2 failed unavailable '' >/dev/null
runtime_lifecycle_set_context_v2 "$task" "$attempt" demo-profile debug "$route_hash" \
  os_88888888888888888888888888888888 >/dev/null
runtime_lifecycle_session_begin_v2 resume "$origin_session" >/dev/null
writer_session=$FACTORY_LIFECYCLE_SESSION_ID
assert_eq '' "${FACTORY_LIFECYCLE_NODE_VISIT_ID:-}" 'origin: fresh session не наследует visit'

# Чужой текущий visit не должен подмениться историческим.
runtime_lifecycle_node_visit_begin_v2 check CHECK "$((pending_sequence + 10))" recovery >/dev/null
other_visit=$FACTORY_LIFECYCLE_NODE_VISIT_ID
other_clock=$RUNTIME_LIFECYCLE_VISIT_STARTED_NS
before_origin_reject=$(lifecycle_rows | sha256sum)
_route_v2_pending_adopt_origin "$task" "$attempt" "$pending_dir/pending-transition.json"
assert_rc 78 "$?" 'origin: другой текущий visit отвергнут'
assert_eq "$other_visit" "$FACTORY_LIFECYCLE_NODE_VISIT_ID" 'origin: текущий visit не затёрт'
assert_eq "$other_clock" "$RUNTIME_LIFECYCLE_VISIT_STARTED_NS" 'origin: текущие часы сохранены'
assert_eq "$before_origin_reject" "$(lifecycle_rows | sha256sum)" 'origin: reject не дописал ledger'
runtime_lifecycle_node_visit_finish_v2 abandoned attempt_terminal attempt_terminal >/dev/null
runtime_lifecycle_clear_entity_v2
closed_before=$(lifecycle_count node_visit_finished)

# Уже accepted event не требует workspace roots или нового guard/model call.
_route_v2_guard_snapshot() { return 91; }
_route_v2_pending_drive "$task" "$attempt" 2 >/dev/null
assert_rc 21 "$?" 'origin: replay передал human stop владельцу проекции'
assert_eq "$origin_visit" "$FACTORY_LIFECYCLE_NODE_VISIT_ID" 'origin: восстановлен exact source visit'
assert_eq "$writer_session" "$FACTORY_LIFECYCLE_SESSION_ID" 'origin: сохранена новая writer session'
assert_eq "$closed_before" "$(lifecycle_count node_visit_finished)" 'origin: нет повторного finish'
assert_file_exists "$pending_dir/pending-transition.json" 'origin: до human projection receipt жив'
_route_v2_pending_ack_stop "$task" "$attempt"
assert_rc 78 "$?" 'origin: без human record нельзя погасить receipt'
assert_file_exists "$pending_dir/pending-transition.json" 'origin: неуспешный ack оставил receipt'
runtime_lifecycle_human_begin_once_v2 manual_resume_required "$origin_hash" >/dev/null
assert_rc 0 "$?" 'origin: human привязан к source visit в новой session'
after_human=$(lifecycle_rows | sha256sum)
runtime_lifecycle_human_begin_once_v2 manual_resume_required "$origin_hash" >/dev/null
assert_rc 0 "$?" 'origin: повтор human проекции идемпотентен'
assert_eq "$after_human" "$(lifecycle_rows | sha256sum)" 'origin: повтор не генерирует event/time'
lifecycle_last human_intervention_started "$TEST_ROOT/pending-human.json"
assert_eq "$origin_visit" "$(json_file_value "$TEST_ROOT/pending-human.json" nodeVisitId)" \
  'origin: human имеет исходный visit'
assert_eq "$writer_session" "$(json_file_value "$TEST_ROOT/pending-human.json" orchestratorSessionId)" \
  'origin: human написан текущей session'
_route_v2_pending_ack_stop "$task" "$attempt"
assert_rc 0 "$?" 'origin: полная проекция позволяет ack'
assert_file_missing "$pending_dir/pending-transition.json" 'origin: receipt погашен после human record'
held_before=$(lifecycle_rows | sha256sum)
route_v2_recovered_stop_held "$task" "$attempt"
assert_rc 11 "$?" 'origin: повтор восстановленного human stop удержан'
assert_eq "$held_before" "$(lifecycle_rows | sha256sum)" 'origin: удержание не дописало историю'
runtime_lifecycle_session_finish_v2 succeeded normal '' >/dev/null

# Ошибка самого find-open-session должна остаться видна после успешного чтения ledger.
# Подмена только аналитического помощника отличает этот путь от отказа trusted reader.
(
  runtime_analytics_python_v2() {
    printf '%s\n' 'ошибка поиска открытой сессии в тестовой фикстуре' >&2
    return 78
  }

  runtime_lifecycle_previous_open_session_v2 "$task" "$attempt" "$open_session" \
    >/dev/null 2>"$session_stderr"
)
assert_rc 78 "$?" "ошибка find-open-session сохраняет свой код"
assert_contains "$(cat "$session_stderr")" 'ошибка поиска открытой сессии' \
  "диагностика ошибки find-open-session остаётся в stderr"

# Повреждение настоящего сегмента не должно превратиться в штатное отсутствие сессии.
# Последний отрицательный сценарий использует только ledger своей временной попытки.
lifecycle_dir="$(attempt_state_v2_task_root "$task")/attempts/$attempt/lifecycle"
active_segment=$(json_file_value "$lifecycle_dir/manifest.json" activeSegment)
printf '%s\n' '{bad-json}' >>"$lifecycle_dir/segments/$active_segment"
runtime_lifecycle_previous_open_session_v2 "$task" "$attempt" "$open_session" \
  >/dev/null 2>"$session_stderr"
corrupt_rc=$?
[[ "$corrupt_rc" -ne 0 && "$corrupt_rc" -ne 3 ]]
assert_rc 0 "$?" "повреждённый журнал возвращает ошибку, отличную от отсутствия сессии"
[[ -s "$session_stderr" ]]
assert_rc 0 "$?" "диагностика повреждённого журнала остаётся в stderr"

finish_tests
