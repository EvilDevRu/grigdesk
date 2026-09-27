#!/usr/bin/env bash
# Режим «цикл»: ведущий ставит задание и проверяет, исполнитель делает. Проверяется
# то, ради чего режим введён: этапы идут без человека, отказ исполнителя уходит
# ведущему, застревание и потолок кругов останавливают честно, продолжение после
# поднятого потолка списывает круг, а пара без loop-режима ведёт себя по-старому.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

export FACTORY_ROUTE_STATE_DIR="$STATE_DIR"
source "$FACTORY_HOME/lib/route-runtime.sh"

routes_dir="$TEST_ROOT/loop-routes"
publisher="$TEST_ROOT/publish-loop.mjs"
profile_id=demo-profile

json_field() {
  "$NODE_BIN" -e \
    'const v=JSON.parse(process.argv[1]); let x=v; for(const k of process.argv.slice(2)) x=x[k]; process.stdout.write(x == null ? "" : String(x));' \
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
  if [[ -n "$raw" ]]; then
    IFS=';' read -r -a args <<<"$raw"
    if [[ -n "$closes" ]]; then
      local closed
      args+=("stage:next" "stage-summary:прежний этап проверен")
      IFS=',' read -r -a closed <<<"$closes"
      for item in "${closed[@]}"; do
        args+=("stage-closed:$item")
      done
    fi
    verdict=$(run_state_verdict_encode "$result" "$owner" "${args[@]}") || return 96
  fi
  if [[ "$stage" == BUILD ]]; then
    local state round
    state=$(attempt_stage_state_loop_state_v2 "$task" "$LOOP_ATTEMPT") || return 95
    round=$(json_field "$state" loop rounds)
    printf 'отчёт круга %s\n' "$round" >"$STATE_DIR/t${task}.report.r${round}.md"
  fi
  file=$(run_state_active_file "$task" "$stage") || return
  _run_state_write "$file" "loop-${stage}-${epoch}" "$epoch" \
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    committed "$result" '' "$verdict"
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
assert_rc 20 "$?" "цикл дошёл до ворот приёмки без единой остановки"
assert_eq '' "$(cat "$SCRIPT")" "сценарий пройден целиком"
assert_eq "$(printf 'REVIEW:lead\nBUILD:worker\nREVIEW:lead\nBUILD:worker\nREVIEW:lead\nBUILD:worker\nREVIEW:lead\nBUILD:worker\nREVIEW:lead\nBUILD:worker\nREVIEW:lead')" \
  "$(cat "$CALLS")" "роль цикла доходит до агента: ведущий и исполнитель"
cursor=$(attempt_stage_state_read_v2 "$task" "$LOOP_ATTEMPT")
assert_eq gate_accept "$(json_field "$cursor" currentNode)" "курсор стоит на воротах приёмки"
state=$(attempt_stage_state_loop_state_v2 "$task" "$LOOP_ATTEMPT")
assert_eq 5 "$(json_field "$state" loop rounds)" "исполнено пять передач"
assert_eq 4 "$(json_field "$state" loop stage)" "признаны три границы этапа"
findings=$(attempt_stage_state_findings_v2 "$task" "$LOOP_ATTEMPT")
assert_eq 0 "$(json_field "$findings" open length)" "на приёмке нет открытых находок"
closed_ids=$("$NODE_BIN" -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(v.closed.map((f)=>f.sourceNode+":"+f.id).sort().join(","))' "$findings")
assert_contains "$closed_ids" 'build:w1' "находка исполнителя закрыта решением ведущего"
report_mode=$(stat -c %a "$STATE_DIR/t${task}.report.r1.md")
assert_eq '' "$(find "$STATE_DIR" -maxdepth 1 -name "t${task}.report.md")" \
  "общего отчёта без круга нет — у каждого круга свой файл"
[[ -f "$STATE_DIR/t${task}.report.r5.md" && -n "$report_mode" ]]
assert_rc 0 "$?" "отчёт последнего круга записан по пути своего круга"

# --- 2. Застревание внутри этапа — честная остановка no-progress ----------------------
task=9102
: >"$CALLS"
LOOP_ATTEMPT=$(begin_loop "$task")
assert_rc 0 "$?" "попытка для застревания создана"
cat >"$SCRIPT" <<'TXT'
REVIEW|failed|build|x=Критерий не закрыт|
BUILD|done|||
REVIEW|failed|build|x=Критерий не закрыт|
TXT
route_v2_dispatch_until_pause "$task" "$LOOP_ATTEMPT" 64 >/dev/null
assert_rc 21 "$?" "повтор того же набора после ремонта останавливает цикл"
cursor=$(attempt_stage_state_read_v2 "$task" "$LOOP_ATTEMPT")
assert_eq no-progress "$(json_field "$cursor" stop)" "остановка названа no-progress"
event=$(latest_event "$task" "$LOOP_ATTEMPT")
assert_eq 1 "$(json_field "$event" loop roundsBefore)" "снимок хранит число исполненных кругов"
assert_eq 1 "$(json_field "$event" loop roundsAfter)" "остановленный кандидат круг не списывает"

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
PROFILE_LOOP_MAX_ROUNDS=101
route_v2_dispatch_next "$task" "$LOOP_ATTEMPT" >/dev/null 2>&1
assert_rc 78 "$?" "потолок выше 100 отклоняется"
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

finish_tests
