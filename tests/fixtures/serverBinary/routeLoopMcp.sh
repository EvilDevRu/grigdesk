#!/usr/bin/env bash
# Режим «цикл» через настоящий собранный status MCP и stage-result/progress. Проверяется
# то, ради чего режим введён: этапы идут без человека, отказ исполнителя уходит
# ведущему, повторные замечания доходят до исполнителя в пределах потолка кругов,
# продолжение после поднятого потолка списывает круг; обычные маршруты не меняются.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

export FACTORY_ROUTE_STATE_DIR="$STATE_DIR"
source "$FACTORY_HOME/lib/route-runtime.sh"
source "$FACTORY_HOME/lib/status-request.sh"

routes_dir="$TEST_ROOT/loop-routes"
publisher="$TEST_ROOT/publish-loop.mjs"
profile_id=demo-profile

json_field() {
  "$NODE_BIN" -e \
    '
const value = JSON.parse(process.argv[1]);
let selected = value;
for (const key of process.argv.slice(2)) {
  selected = selected[key];
}
process.stdout.write(selected == null ? "" : String(selected));
' \
    "$@"
}

if [[ -z "${NODE_BIN:-}" || ! -x "$NODE_BIN" ]]; then
  test_fail "host node is available" "NODE_BIN is empty"
  finish_tests
  exit $?
fi

cat >"$publisher" <<'JS'
import { pathToFileURL } from 'node:url';

const [root, baseDir, variant = 'valid'] = process.argv.slice(2);
const { RoutesStore } = await import(pathToFileURL(`${root}/server/src/modules/routes/store.ts`));
const fixtures = await import(pathToFileURL(`${root}/tests/engine/fixtures/routes-catalog-definitions.mjs`));
const stop = (target = 'human') => ({ stop: target });
const next = (target) => ({ next: target });
const transfer = { rewind: 'build', reset: ['build', 'review'] };
const agent = (id, filesystem, on, onFailure) => ({
  id,
  executor: 'agent',
  phase: 'main',
  runKey: id.toUpperCase(),
  emits: [],
  prompt: {
    blocks: [{ file: `prompts/${id}.base.md` }],
    requiredContext: ['task', 'artifacts', 'evidence'],
  },
  policy: { filesystem, timeoutClass: 'browser', budgetClass: 'large' },
  fanout: { mode: 'single', maxExecutors: 1, degrade: 'forbid' },
  retry: { noResult: 1, providerFailure: { attempts: 0, strategy: 'none' }, productFailure: 0 },
  on,
  ...(onFailure ? { onFailure } : {}),
});
const route = {
  schema: 2,
  kind: 'route',
  profile: fixtures.PROFILE_ID,
  id: 'loop',
  title: 'Цикл ведущего и исполнителя',
  bootstrap: 'skip',
  loop: { lead: 'review', worker: 'build' },
  entry: 'review',
  sequence: { main: ['build', 'review', 'gate_accept'], tail: [] },
  nodes: [
    agent(
      'build',
      'workspace-write',
      { done: next('review'), skipped: next('review'), failed: next('review'), exhausted: stop() },
      {
        build: next('review'),
        tests: next('review'),
        plan: next('review'),
        human: next('review'),
        environment: stop(),
      },
    ),
    agent(
      'review',
      'state-only',
      { done: next('gate_accept'), skipped: stop(), failed: transfer, exhausted: stop() },
      { build: transfer, tests: transfer, environment: stop(), plan: stop(), human: stop() },
    ),
    {
      id: 'gate_accept',
      executor: 'gate',
      phase: 'main',
      runKey: 'GATE_ACCEPT',
      emits: [],
      on: { approved: stop('done'), rejected: { rewind: 'review', reset: ['review', 'gate_accept'] } },
    },
  ],
  escalation: [],
};
if (variant === 'retry') route.nodes[0].retry.productFailure = 1;
if (variant === 'bypass') route.nodes[0].on.done = next('gate_accept');
if (variant === 'entry') route.entry = 'build';
if (variant === 'plain') delete route.loop;
const prompts = {
  'prompts/build.base.md': 'Исполни задание ведущего и запиши отчёт своего круга.',
  'prompts/review.base.md': 'Поставь задание, проверь отчёт круга, веди этапы.',
};
const bootstrap = structuredClone(fixtures.bootstrap);
bootstrap.nodes[0].on.done.escalate.routes = ['loop'];
bootstrap.escalation[0].allowedRoutes = ['loop'];
const store = new RoutesStore({ baseDir });
const previous = await store.readCurrent(fixtures.PROFILE_ID);
const published = await store.publishRoute(fixtures.PROFILE_ID, route.id, { route, prompts });
const result = await store.publishCatalog(fixtures.PROFILE_ID, {
  catalog: {
    schema: 2,
    profile: fixtures.PROFILE_ID,
    routes: { loop: published.routeHash },
    bootstrap: { file: 'bootstrap/scout.json' },
  },
  bootstrap,
  prompts: fixtures.bootstrapPrompts,
}, { expectedCatalogHash: previous?.catalogHash ?? null });
process.stdout.write(result.catalogHash);
JS

# Неверная пара не публикуется: схема сервера держит тот же контракт, что движок.
for variant in retry bypass entry; do
  "$NODE_BIN" "$publisher" "$FACTORY_HOME/.." "$TEST_ROOT/rejected-$variant" "$variant" \
    >/dev/null 2>"$TEST_ROOT/rejected-$variant.err"
  assert_rc 1 "$?" "цикл с нарушением «$variant» не публикуется"
  assert_contains "$(cat "$TEST_ROOT/rejected-$variant.err")" 'machine.loop' \
    "отказ «$variant» называет контракт цикла"
done

loop_catalog=$("$NODE_BIN" "$publisher" "$FACTORY_HOME/.." "$routes_dir" valid)
assert_rc 0 "$?" "маршрут цикла публикуется в изолированный каталог"
[[ "$loop_catalog" =~ ^[a-f0-9]{64}$ ]]
assert_rc 0 "$?" "каталог цикла получил хеш"

CALLS="$TEST_ROOT/loop-calls.log"
SCRIPT="$TEST_ROOT/loop-script.txt"
: >"$CALLS"

# Сторож рабочего дерева принимает только git-репозиторий: исполнитель цикла пишет
# в checkout, проверяющий — только артефакты.
loop_repo="$TEST_ROOT/loop-repo"
git init -q "$loop_repo"
git -C "$loop_repo" config user.email tests@example.invalid
git -C "$loop_repo" config user.name Tests
printf 'исходное состояние\n' >"$loop_repo/readme.txt"
git -C "$loop_repo" add readme.txt
git -C "$loop_repo" commit -qm baseline

route_v2_workspace_roots() {
  printf '%s\n' "$loop_repo"
}

route_v2_context_for_node() {
  local findings loop_state
  findings=$(attempt_stage_state_findings_v2 "$1" "$2") || return
  loop_state=$(attempt_stage_state_loop_state_v2 "$1" "$2") || return
  "$NODE_BIN" - "$5" "$STATE_DIR" "$1" "$findings" "$loop_state" <<'JS'
const fs = require('node:fs');
const [output, state, task, findings, loopState] = process.argv.slice(2);
const loop = JSON.parse(loopState).loop;
fs.writeFileSync(output, JSON.stringify({
  task: { id: Number(task), title: 'loop' },
  artifacts: { plan: `${state}/t${task}.plan.md`, report: `${state}/t${task}.report.r${loop.rounds}.md` },
  evidence: { eventCount: 0, findings: JSON.parse(findings), loop },
  delivery: { mode: 'disabled', actions: [], targetBranches: {}, sourceBranch: 'fixture' },
}));
JS
}

# Поддельный исполнитель: берёт очередную строку сценария и сдаёт её вердикт.
# Формат строки: УЗЕЛ|исход|owner|id=текст;id=текст|закрываемые-id-через-запятую
run_agent() {
  local task=$1 stage=$3 line expected result owner raw closes epoch file verdict=''
  local -a args=()
  line=$(head -n 1 "$SCRIPT")
  sed -i '1d' "$SCRIPT"
  IFS='|' read -r expected result owner raw closes <<<"$line"
  printf '%s:%s\n' "$stage" "${FACTORY_LOOP_ROLE:-}" >>"$CALLS"
  epoch=$(wc -l <"$CALLS")
  [[ "$stage" == "$expected" ]] || return 97
  if [[ "$stage" == BUILD ]]; then
    local state round
    state=$(attempt_stage_state_loop_state_v2 "$task" "$LOOP_ATTEMPT") || return 95
    round=$(json_field "$state" loop rounds)
    printf 'отчёт круга %s\n' "$round" >"$STATE_DIR/t${task}.report.r${round}.md"
  fi
  local run_id="loop-${stage}-${epoch}" token="fixture-${stage}-${epoch}" request_dir input output
  request_dir="$STATE_DIR/logs/runs/t${task}/${stage}/${run_id}/control-requests"
  mkdir -p "$request_dir"
  run_state_begin "$task" "$stage" "$run_id" "$epoch" "$token" || return
  input="$TEST_ROOT/mcp-input.jsonl"
  output="$TEST_ROOT/mcp-output.jsonl"
  "$NODE_BIN" - "$result" "$owner" "$raw" "$closes" >"$input" <<'JS'
const [result, owner, raw, closes] = process.argv.slice(2);
const args = { result };
if (raw) {
  args.failureOwner = owner;
  args.findings = raw.split(';');
}
if (closes) {
  args.nextStage = true;
  args.stageClosed = closes.split(',');
  args.stageSummary = 'прежний этап проверен';
}
console.log(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: { name: 'stage_result', arguments: args } }));
JS
  FACTORY_RUN_TASK="$task" FACTORY_RUN_STAGE="$stage" FACTORY_RUN_ID="$run_id" \
    FACTORY_RUN_EPOCH="$epoch" FACTORY_STATUS_MODE=request \
    FACTORY_STATUS_REQUEST_DIR="$request_dir" FACTORY_LOOP_ROLE="${FACTORY_LOOP_ROLE:-}" \
    "$NODE_BIN" "$SERVER_BINARY_STATUS_MCP" <"$input" >"$output" || return
  "$NODE_BIN" - "$output" <<'JS'
const fs = require('node:fs');
const reply = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!reply.result?.structuredContent?.ok || reply.result?.isError) {
  console.error(JSON.stringify(reply));
  process.exit(48);
}
JS
  local mcp_rc=$?
  [[ "$mcp_rc" == 0 ]] || return "$mcp_rc"
  status_request_consume_all "$task" "$stage" "$run_id" "$epoch" "$token" "$request_dir"

}

begin_loop() {
  local task=$1 attempt
  attempt=$(attempt_state_begin_v2 "$task" "$profile_id" "$routes_dir") || return
  attempt_state_select_route_v2 "$task" "$attempt" loop >/dev/null || return
  route_v2_dispatch_bootstrap "$task" "$attempt" >/dev/null || return
  attempt_stage_state_init_v2 "$task" "$attempt" loop >/dev/null || return
  printf '%s\n' "$attempt"
}

latest_event() {
  attempt_stage_state_latest_event_v2 "$1" "$2"
}

# --- 1. Пять этапов без человека, отказ исполнителя уходит ведущему ------------------
unset PROFILE_LOOP_MAX_ROUNDS
task=9101
LOOP_ATTEMPT=$(begin_loop "$task")
assert_rc 0 "$?" "попытка цикла создана без разведки"
cat >"$SCRIPT" <<'TXT'
REVIEW|failed|build|s1-a=Первый критерий;s1-b=Второй критерий|
BUILD|failed|build|w1=Не успел второй критерий|
REVIEW|failed|build|s1-b=Второй критерий|
BUILD|done|||
REVIEW|failed|build|s2-a=Этап два|s1-b
BUILD|done|||
REVIEW|failed|tests|s3-a=Этап три|s2-a
BUILD|done|||
REVIEW|failed|build|s4-a=Этап четыре|s3-a
BUILD|done|||
REVIEW|done|||
TXT
route_v2_dispatch_until_pause "$task" "$LOOP_ATTEMPT" 64 >/dev/null
dispatch_rc=$?
assert_rc 20 "$dispatch_rc" "цикл дошёл до ворот приёмки без единой остановки"
if [[ "$dispatch_rc" != 20 ]]; then
  finish_tests
  exit 1
fi
assert_eq '' "$(cat "$SCRIPT")" "сценарий пройден целиком"
expected_calls=$(printf '%s\n' REVIEW:lead BUILD:worker REVIEW:lead BUILD:worker REVIEW:lead \
  BUILD:worker REVIEW:lead BUILD:worker REVIEW:lead BUILD:worker REVIEW:lead)
assert_eq "$expected_calls" \
  "$(cat "$CALLS")" "роль цикла доходит до агента: ведущий и исполнитель"
cursor=$(attempt_stage_state_read_v2 "$task" "$LOOP_ATTEMPT")
assert_eq gate_accept "$(json_field "$cursor" currentNode)" "курсор стоит на воротах приёмки"
state=$(attempt_stage_state_loop_state_v2 "$task" "$LOOP_ATTEMPT")
assert_eq 5 "$(json_field "$state" loop rounds)" "исполнено пять передач"
assert_eq 4 "$(json_field "$state" loop stage)" "признаны три границы этапа"
findings=$(attempt_stage_state_findings_v2 "$task" "$LOOP_ATTEMPT")
assert_eq 0 "$(json_field "$findings" open length)" "на приёмке нет открытых находок"
closed_ids=$("$NODE_BIN" -e '
const value = JSON.parse(process.argv[1]);
const ids = value.closed.map((finding) => finding.sourceNode + ":" + finding.id);
process.stdout.write(ids.sort().join(","));
' "$findings")
assert_contains "$closed_ids" 'build:w1' "находка исполнителя закрыта решением ведущего"
report_mode=$(stat -c %a "$STATE_DIR/t${task}.report.r1.md")
assert_eq '' "$(find "$STATE_DIR" -maxdepth 1 -name "t${task}.report.md")" \
  "общего отчёта без круга нет — у каждого круга свой файл"
[[ -f "$STATE_DIR/t${task}.report.r5.md" && -n "$report_mode" ]]
assert_rc 0 "$?" "отчёт последнего круга записан по пути своего круга"

# Быстрые ворота сохраняют целиком первый настоящий цикл с тремя границами стадий.
# Дополнительные случаи проверяют authority CAS и форму MCP без повторения длинного потолка.
if [[ "${SERVER_BINARY_STATUS_QUICK:-}" == 1 ]]; then
  FACTORY_LOOP_ROLE='' "$FACTORY_HOME/lib/stage-result.sh" --task 1 --stage REVIEW \
    --run-id r --epoch 1 failed --failure-owner build --finding 'a=b' --next-stage \
    --stage-closed x --stage-summary y >/dev/null 2>"$TEST_ROOT/stage-flag.err"
  assert_rc 2 "$?" "stage-result запрещает границу обычному узлу"

  "$NODE_BIN" "$SERVER_BINARY_STATUS_MCP" >"$TEST_ROOT/tools.jsonl" <<'JSON'
{"jsonrpc":"2.0","id":1,"method":"initialize"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
JSON
  "$NODE_BIN" - "$TEST_ROOT/tools.jsonl" <<'JS'
const fs = require('node:fs');
const replies = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
const shape = replies[1].result.tools.find((tool) => tool.name === 'stage_result').inputSchema;
if (shape.additionalProperties !== false || shape.properties.nextStage.type !== 'boolean'
  || shape.properties.stageClosed.type !== 'array' || shape.properties.stageSummary.type !== 'string') {
  process.exit(1);
}
JS
  assert_rc 0 "$?" "MCP объявляет точную схему границы стадии"

  # Запрос не знает capability: только отдельный host consumer владеет token для CAS.
  # Неверный token, epoch или run-id не меняют active record следующего запуска.
  mcp_call() {
    local task=$1 run_id=$2 epoch=$3 role=$4 args=$5 directory
    directory="$STATE_DIR/logs/runs/t${task}/CHECK/${run_id}/control-requests"
    mkdir -p "$directory"
    local prefix='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":'
    prefix+='{"name":"stage_result","arguments":'
    printf '%s%s}}\n' "$prefix" "$args" \
      | FACTORY_RUN_TASK="$task" FACTORY_RUN_STAGE=CHECK FACTORY_RUN_ID="$run_id" \
        FACTORY_RUN_EPOCH="$epoch" FACTORY_STATUS_MODE=request FACTORY_LOOP_ROLE="$role" \
        FACTORY_STATUS_REQUEST_DIR="$directory" "$NODE_BIN" "$SERVER_BINARY_STATUS_MCP" \
        >"$TEST_ROOT/capability-response.jsonl"
  }

  capability_task=9199
  pipeline_store_route_init "$capability_task" CHECK
  run_state_begin "$capability_task" CHECK first 1 fixture-correct-token
  active=$(run_state_active_file "$capability_task" CHECK)
  before=$(cat "$active")
  mcp_call "$capability_task" first 1 '' '{"result":"done"}'
  request_dir="$STATE_DIR/logs/runs/t${capability_task}/CHECK/first/control-requests"
  status_request_consume_all "$capability_task" CHECK first 1 wrong-token "$request_dir"
  assert_rc 74 "$?" "неверный token не проходит host CAS"
  assert_eq "$before" "$(cat "$active")" "неверный token сохраняет ledger"
  status_request_consume_all "$capability_task" CHECK first 1 fixture-correct-token "$request_dir"
  assert_rc 0 "$?" "верный token принимает terminal result"
  assert_eq done "$(_run_state_get "$active" RESULT)" "terminal result записан настоящим writer"

  run_state_begin "$capability_task" CHECK second 2 fixture-second-token
  before=$(cat "$active")
  mcp_call "$capability_task" first 1 '' '{"result":"done"}'
  status_request_consume_all "$capability_task" CHECK first 1 fixture-correct-token "$request_dir"
  assert_rc 73 "$?" "прежний epoch отклоняется"
  assert_eq "$before" "$(cat "$active")" "прежний epoch сохраняет новый ledger"
  mcp_call "$capability_task" foreign 2 '' '{"result":"done"}'
  foreign_dir="$STATE_DIR/logs/runs/t${capability_task}/CHECK/foreign/control-requests"
  status_request_consume_all "$capability_task" CHECK second 2 fixture-second-token "$foreign_dir"
  assert_rc 74 "$?" "чужой run-id отклоняется"
  assert_eq "$before" "$(cat "$active")" "чужой run-id сохраняет ledger"

  finish_tests
  exit $?
fi

# --- 2. Прежнее замечание ремонтируется до потолка, включая пределы 6 и 10 -----------
task=9102
: >"$CALLS"
PROFILE_LOOP_MAX_ROUNDS=11
LOOP_ATTEMPT=$(begin_loop "$task")
assert_rc 0 "$?" "попытка для повторных замечаний создана"
{
  for round in {1..11}; do
    printf 'REVIEW|failed|build|x=Остаток того же требования, проверка %s|\n' "$round"
    printf 'BUILD|done|||\n'
  done
  printf 'REVIEW|failed|build|x=Требование всё ещё не принято|\n'
} >"$SCRIPT"
route_v2_dispatch_until_pause "$task" "$LOOP_ATTEMPT" 64 >/dev/null
assert_rc 21 "$?" "повторные замечания доходят до потолка цикла"
cursor=$(attempt_stage_state_read_v2 "$task" "$LOOP_ATTEMPT")
assert_eq loop-ceiling "$(json_field "$cursor" stop)" "останавливает потолок, а не совпадение id"
event=$(latest_event "$task" "$LOOP_ATTEMPT")
assert_eq 11 "$(json_field "$event" loop roundsBefore)" "исполнены все одиннадцать кругов"
assert_eq 11 "$(json_field "$event" loop roundsAfter)" "остановленный кандидат круг не списывает"
assert_eq 1 "$(json_field "$event" loop stage)" "незакрытое требование остаётся в прежнем этапе"
assert_eq '' "$(cat "$SCRIPT")" "ведущий проверил результат каждого круга"
assert_eq 23 "$(wc -l <"$CALLS")" "нет лишних запусков после исчерпания потолка"
findings=$(attempt_stage_state_findings_v2 "$task" "$LOOP_ATTEMPT")
assert_eq x "$(json_field "$findings" open 0 id)" "потолок не закрывает нерешённое замечание"
assert_eq 'Требование всё ещё не принято' "$(json_field "$findings" open 0 summary)" \
  "находка хранит последний результат проверки"
unset PROFILE_LOOP_MAX_ROUNDS

# --- 3. Потолок кругов и продолжение после его подъёма -------------------------------
task=9103
: >"$CALLS"
PROFILE_LOOP_MAX_ROUNDS=2
LOOP_ATTEMPT=$(begin_loop "$task")
assert_rc 0 "$?" "попытка для потолка создана"
cat >"$SCRIPT" <<'TXT'
REVIEW|failed|build|c1=Этап один|
BUILD|done|||
REVIEW|failed|build|c2=Этап два|c1
BUILD|done|||
REVIEW|failed|build|c3=Этап три|c2
TXT
route_v2_dispatch_until_pause "$task" "$LOOP_ATTEMPT" 64 >/dev/null
assert_rc 21 "$?" "третья передача при потолке 2 останавливает цикл"
cursor=$(attempt_stage_state_read_v2 "$task" "$LOOP_ATTEMPT")
assert_eq loop-ceiling "$(json_field "$cursor" stop)" "остановка названа loop-ceiling"
event=$(latest_event "$task" "$LOOP_ATTEMPT")
assert_contains "$(json_field "$event" reason)" 'PROFILE_LOOP_MAX_ROUNDS' \
  "причина называет настройку профиля"
assert_eq true "$(json_field "$event" loop stageAccepted)" "граница этапа кандидата признана до потолка"
events_before=$(find "$(attempt_state_v2_task_root "$task")/attempts/$LOOP_ATTEMPT/stage-results" \
  -name 'event.*.json' | wc -l)
continued=$(route_v2_continue_loop_ceiling "$task" "$LOOP_ATTEMPT")
assert_rc 11 "$?" "без подъёма потолка продолжение отвечает своим кодом"
assert_eq '' "$continued" "без подъёма потолка цикл не продолжается"
events_after=$(find "$(attempt_state_v2_task_root "$task")/attempts/$LOOP_ATTEMPT/stage-results" \
  -name 'event.*.json' | wc -l)
assert_eq "$events_before" "$events_after" "без подъёма потолка событие не пишется"
PROFILE_LOOP_MAX_ROUNDS=3
continued=$(route_v2_continue_loop_ceiling "$task" "$LOOP_ATTEMPT")
assert_rc 0 "$?" "поднятый потолок продолжает цикл"
assert_eq build "$continued" "продолжение отдаёт работу исполнителю"
event=$(latest_event "$task" "$LOOP_ATTEMPT")
assert_eq loop-continue "$(json_field "$event" kind)" "продолжение записано своим событием"
assert_eq 3 "$(json_field "$event" loop roundsAfter)" "продолжение списывает ровно один круг"
assert_eq 3 "$(json_field "$event" loop stage)" "этап кандидата сохранён"
again=$(route_v2_continue_loop_ceiling "$task" "$LOOP_ATTEMPT")
assert_eq '' "$again" "повторное продолжение не добавляет круг"
cat >"$SCRIPT" <<'TXT'
BUILD|done|||
REVIEW|failed|build|c4=Этап четыре|c3
TXT
route_v2_dispatch_until_pause "$task" "$LOOP_ATTEMPT" 64 >/dev/null
assert_rc 21 "$?" "после продолжения потолок снова ограничивает цикл"
cursor=$(attempt_stage_state_read_v2 "$task" "$LOOP_ATTEMPT")
assert_eq loop-ceiling "$(json_field "$cursor" stop)" "новый потолок снова даёт loop-ceiling"
state=$(attempt_stage_state_loop_state_v2 "$task" "$LOOP_ATTEMPT")
assert_eq 3 "$(json_field "$state" loop rounds)" "исполнено ровно три передачи"

# --- 4. Неверный потолок — отказ до запуска модели ----------------------------------
task=9104
: >"$CALLS"
PROFILE_LOOP_MAX_ROUNDS=abc
LOOP_ATTEMPT=$(begin_loop "$task")
assert_rc 0 "$?" "попытка для неверного потолка создана"
route_v2_dispatch_next "$task" "$LOOP_ATTEMPT" >/dev/null 2>&1
assert_rc 78 "$?" "мусор в PROFILE_LOOP_MAX_ROUNDS — fail-closed"
assert_eq '' "$(cat "$CALLS")" "модель при неверном потолке не запускалась"
PROFILE_LOOP_MAX_ROUNDS=''
route_v2_dispatch_next "$task" "$LOOP_ATTEMPT" >/dev/null 2>&1
assert_rc 78 "$?" "пустой PROFILE_LOOP_MAX_ROUNDS — тоже отказ, а не значение по умолчанию"
PROFILE_LOOP_MAX_ROUNDS=301
route_v2_dispatch_next "$task" "$LOOP_ATTEMPT" >/dev/null 2>&1
assert_rc 78 "$?" "потолок выше 300 отклоняется"
unset PROFILE_LOOP_MAX_ROUNDS

# --- 5. Граница этапа на первом входе не признаётся ---------------------------------
task=9105
: >"$CALLS"
LOOP_ATTEMPT=$(begin_loop "$task")
assert_rc 0 "$?" "попытка для ложной границы создана"
cat >"$SCRIPT" <<'TXT'
REVIEW|failed|build|f1=Первый этап|ghost
TXT
route_v2_dispatch_next "$task" "$LOOP_ATTEMPT" >/dev/null
assert_rc 0 "$?" "ложная граница не роняет передачу"
event=$(latest_event "$task" "$LOOP_ATTEMPT")
assert_eq false "$(json_field "$event" loop stageAccepted)" "граница без передачи не признана"
assert_eq no-transfer "$(json_field "$event" loop stageRejected)" "причина непризнания записана"
assert_eq 1 "$(json_field "$event" loop stage)" "первая передача открывает этап 1"

# --- 6. Человек на воротах: отказ уходит ведущему -----------------------------------
task=9106
: >"$CALLS"
LOOP_ATTEMPT=$(begin_loop "$task")
cat >"$SCRIPT" <<'TXT'
REVIEW|done|||
TXT
route_v2_dispatch_until_pause "$task" "$LOOP_ATTEMPT" 64 >/dev/null
assert_rc 20 "$?" "принятая ведущим работа ждёт человека на воротах"
route_v2_gate_decide "$task" "$LOOP_ATTEMPT" gate_accept rejected 'Нужен ещё сценарий' >/dev/null
assert_rc 0 "$?" "отказ на воротах принят"
cursor=$(attempt_stage_state_read_v2 "$task" "$LOOP_ATTEMPT")
assert_eq review "$(json_field "$cursor" currentNode)" "отказ ворот возвращает работу ведущему"
note=$(attempt_stage_state_human_note_v2 "$task" "$LOOP_ATTEMPT" review)
assert_eq 'Нужен ещё сценарий' "$note" "текст отказа доезжает до ведущего"

# --- 7. Смена build → tests внутри этапа — не «смена владельца» -----------------------
task=9107
: >"$CALLS"
LOOP_ATTEMPT=$(begin_loop "$task")
assert_rc 0 "$?" "попытка для смены владельца создана"
cat >"$SCRIPT" <<'TXT'
REVIEW|failed|build|o1=Реализация;o2=Тест сценария|
BUILD|done|||
REVIEW|failed|tests|o2=Тест сценария|
TXT
route_v2_dispatch_until_pause "$task" "$LOOP_ATTEMPT" 3 >/dev/null 2>&1
cursor=$(attempt_stage_state_read_v2 "$task" "$LOOP_ATTEMPT")
assert_eq build "$(json_field "$cursor" currentNode)" \
  "build и tests на дуге цикла — один класс, работа снова у исполнителя"
assert_eq '' "$(json_field "$cursor" stop)" "цикл не остановлен сменой слова владельца"

# --- 8. Метка границы этапа вне цикла отклоняется ------------------------------------
FACTORY_LOOP_ROLE='' "$FACTORY_HOME/lib/stage-result.sh" --task 1 --stage REVIEW \
  --run-id r --epoch 1 failed --failure-owner build --finding 'a=b' --next-stage \
  --stage-closed x --stage-summary y >/dev/null 2>"$TEST_ROOT/stage-flag.err"
assert_rc 2 "$?" "stage-result не принимает границу этапа не у ведущего"
assert_contains "$(cat "$TEST_ROOT/stage-flag.err")" 'ведущему' "отказ объясняет, кому доступна граница"

# --- 9. Уточнение набора и возврат прежнего дефекта не подменяют решение ведущего ----
task=9108
: >"$CALLS"
LOOP_ATTEMPT=$(begin_loop "$task")
cat >"$SCRIPT" <<'TXT'
REVIEW|failed|build|a=Первое требование|
BUILD|done|||
REVIEW|failed|build|a=Остаток;b=Первое уточнение|
BUILD|failed|build|a=Частичный ремонт|
REVIEW|failed|tests|a=Остаток;b=Первое уточнение;c=Второе уточнение|
BUILD|done|||
REVIEW|failed|build|a=Повторная проверка A|
BUILD|done|||
REVIEW|failed|build|b=Повторная проверка B|
BUILD|done|||
REVIEW|failed|build|a=Повторная проверка A|
BUILD|done|||
REVIEW|failed|build|b=Повторная проверка B|
BUILD|done|||
REVIEW|failed|build|a=Повторная проверка A|
BUILD|done|||
REVIEW|done|||
TXT
route_v2_dispatch_until_pause "$task" "$LOOP_ATTEMPT" 64 >/dev/null
assert_rc 20 "$?" "ведущий довёл уточняемый ремонт до ворот приёмки"
assert_eq '' "$(cat "$SCRIPT")" "все решения ведущего переданы исполнителю"
state=$(attempt_stage_state_loop_state_v2 "$task" "$LOOP_ATTEMPT")
assert_eq 8 "$(json_field "$state" loop rounds)" "каждая передача расходует круг"
assert_eq 1 "$(json_field "$state" loop stage)" "уточнение id само по себе не принимает этап"
findings=$(attempt_stage_state_findings_v2 "$task" "$LOOP_ATTEMPT")
assert_eq 0 "$(json_field "$findings" open length)" "замечания закрыты только решением ведущего"

finish_tests
