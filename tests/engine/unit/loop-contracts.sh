#!/usr/bin/env bash
# Контракты режима «цикл» вне диспетчера: проверка пары в движковой схеме, структурная
# симуляция редактора с потолком кругов, контекст узла цикла и отображение остановки
# по потолку в закрытый словарь lifecycle-аналитики.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

route_tool="$FACTORY_HOME/bin/factory-route"
context_tool="$FACTORY_HOME/bin/factory-context"

# Значение по пути a.b.c из JSON на stdin; отсутствующий путь — ненулевой код.
json_value() {
  python3 -c '
import json, sys
value = json.load(sys.stdin)
for key in sys.argv[1].split("."):
    value = value[int(key)] if isinstance(value, list) else value[key]
print(value)
' "$1"
}
fixture_file="$FACTORY_TESTS_HOME/../fixtures/routes-editor.mjs"

# --- Схема движка: пара цикла и её нарушения ----------------------------------------
schema_out=$(python3 - "$FACTORY_HOME/lib" <<'PY'
import copy
import sys

sys.path.insert(0, sys.argv[1])
import route_model


def agent(node_id, filesystem, on, on_failure):
    return {
        "id": node_id, "executor": "agent", "phase": "main", "runKey": node_id.upper(),
        "emits": [],
        "prompt": {"blocks": [{"file": f"prompts/{node_id}.base.md"}],
                   "requiredContext": ["task"]},
        "policy": {"filesystem": filesystem, "timeoutClass": "browser",
                   "budgetClass": "large"},
        "fanout": {"mode": "single", "maxExecutors": 1, "degrade": "forbid"},
        "retry": {"noResult": 1, "productFailure": 0,
                  "providerFailure": {"attempts": 0, "strategy": "none"}},
        "on": on, "onFailure": on_failure,
    }


transfer = {"rewind": "build", "reset": ["build", "review"]}
machine = {
    "schema": 2, "kind": "route", "profile": "sample", "id": "loop",
    "bootstrap": "skip", "loop": {"lead": "review", "worker": "build"}, "entry": "review",
    "sequence": {"main": ["build", "review", "gate_accept"], "tail": []},
    "nodes": [
        agent("build", "workspace-write",
              {"done": {"next": "review"}, "skipped": {"next": "review"},
               "failed": {"next": "review"}, "exhausted": {"stop": "human"}},
              {"build": {"next": "review"}, "tests": {"next": "review"},
               "plan": {"next": "review"}, "human": {"next": "review"},
               "environment": {"stop": "human"}}),
        agent("review", "state-only",
              {"done": {"next": "gate_accept"}, "skipped": {"stop": "human"},
               "failed": transfer, "exhausted": {"stop": "human"}},
              {"build": transfer, "tests": transfer, "plan": {"stop": "human"},
               "human": {"stop": "human"}, "environment": {"stop": "human"}}),
        {"id": "gate_accept", "executor": "gate", "phase": "main", "runKey": "GATE_ACCEPT",
         "emits": [], "on": {"approved": {"stop": "done"},
                              "rejected": {"rewind": "review",
                                           "reset": ["review", "gate_accept"]}}},
    ],
    "escalation": [],
}
prompts = {"prompts/build.base.md", "prompts/review.base.md"}


def verdict(candidate):
    try:
        route_model.validate_machine(candidate, "sample", "loop", "route", prompts)
    except route_model.RouteV2Error as error:
        return "reject:" + str(error)
    return "ok"


print("valid", verdict(machine))
def without_worker_failures(m, failed):
    del m["nodes"][0]["onFailure"]
    m["nodes"][0]["on"]["failed"] = failed


variants = {
    "retry": lambda m: m["nodes"][0]["retry"].update(productFailure=1),
    "entry": lambda m: m.update(entry="build"),
    "bypass": lambda m: m["nodes"][0]["on"].update(done={"next": "gate_accept"}),
    "tests-stop": lambda m: m["nodes"][1]["onFailure"].update(tests={"stop": "human"}),
    "same": lambda m: m["loop"].update(worker="review"),
    "extra": lambda m: m["loop"].update(extra="x"),
    # Продуктовый отказ исполнителя — только ведущему: ни человеку, ни на приёмку.
    "worker-build-human": lambda m: m["nodes"][0]["onFailure"].update(build={"stop": "human"}),
    "worker-build-gate": lambda m: m["nodes"][0]["onFailure"].update(
        build={"next": "gate_accept"}),
    "worker-plan-human": lambda m: m["nodes"][0]["onFailure"].update(plan={"stop": "human"}),
    "worker-failed-human": lambda m: m["nodes"][0]["on"].update(failed={"stop": "human"}),
    "worker-skipped-gate": lambda m: m["nodes"][0]["on"].update(
        skipped={"next": "gate_accept"}),
    "worker-fallback-human": lambda m: without_worker_failures(m, {"stop": "human"}),
}
for name, mutate in variants.items():
    candidate = copy.deepcopy(machine)
    mutate(candidate)
    print(name, verdict(candidate))
plain = copy.deepcopy(machine)
del plain["loop"]
print("plain", verdict(plain))
# Исключение — окружение: его ведущий не починит, куда вести — решает маршрут.
environment = copy.deepcopy(machine)
environment["nodes"][0]["onFailure"]["environment"] = {"next": "review"}
print("environment-free", verdict(environment))
# Без onFailure действует on.failed — ведущему, значит годится.
fallback = copy.deepcopy(machine)
without_worker_failures(fallback, {"next": "review"})
print("fallback-lead", verdict(fallback))
# Реальный переход движка тем же выбором, что у CLI и у пробного шага редактора.
for owner in ("build", "tests", "plan", "human", "environment"):
    action, _, _ = route_model.select_node_transition(machine, "build", "failed", owner)
    print("transition", owner, route_model.canonical_json(action).replace("\n", " "))
PY
)
assert_rc 0 "$?" "движковая схема проверена без исключений"
assert_contains "$schema_out" 'valid ok' "корректная пара цикла принимается движком"
assert_contains "$schema_out" 'plain ok' "тот же маршрут без loop остаётся обычным"
for variant in retry entry bypass tests-stop same extra worker-build-human worker-build-gate \
  worker-plan-human worker-failed-human worker-skipped-gate worker-fallback-human; do
  line=$(printf '%s\n' "$schema_out" | awk -v name="$variant" '$1 == name')
  assert_contains "$line" 'reject:' "движок отвергает нарушение «$variant»"
  assert_contains "$line" 'machine.loop' "отказ «$variant» называет контракт цикла"
done
assert_contains "$schema_out" 'environment-free ok' \
  "отказ исполнителя по окружению маршрут ведёт по своему решению"
assert_contains "$schema_out" 'fallback-lead ok' \
  "без onFailure отказ исполнителя через on.failed уходит ведущему"
for owner in build tests plan human; do
  line=$(printf '%s\n' "$schema_out" | awk -v owner="$owner" '$1 == "transition" && $2 == owner')
  assert_contains "$line" '"next": "review"' "отказ исполнителя с owner $owner уходит ведущему"
done
line=$(printf '%s\n' "$schema_out" | awk '$1 == "transition" && $2 == "environment"')
assert_contains "$line" '"stop": "human"' "отказ исполнителя по окружению останавливает маршрут"

# --- Структурная симуляция редактора: потолок кругов вместо общего бюджета 10 --------
make_step() {
  local rounds_used=$1 loop_max=$2 step_index=${3:-1} shape=${4:-loop}
  "$NODE_BIN" --input-type=module -e '
import { pathToFileURL } from "node:url";
const { makeCatalogInput, makeAgentNode } = await import(pathToFileURL(process.argv[1]));
const catalogInput = makeCatalogInput();
const transfer = { rewind: "build", reset: ["build", "review"] };
const build = makeAgentNode({ id: "build", on: {
  done: { next: "review" }, skipped: { next: "review" },
  failed: { next: "review" }, exhausted: { stop: "human" } } });
const review = makeAgentNode({ id: "review", on: {
  done: { next: "gate_accept" }, skipped: { stop: "human" },
  failed: transfer, exhausted: { stop: "human" } } });
const quick = catalogInput.routes.quick;
const gate = quick.route.nodes.find((node) => node.id === "gate_accept");
gate.on = { approved: { stop: "done" }, rejected: { rewind: "review", reset: ["review", "gate_accept"] } };
quick.route = { ...quick.route, entry: "review", loop: { lead: "review", worker: "build" },
  sequence: { main: ["build", "review", "gate_accept"], tail: [] },
  nodes: [build, review, gate] };
quick.prompts = { "prompts/build.base.md": "Исполни.", "prompts/review.base.md": "Проверь." };
const request = {
  catalogInput,
  cursor: { scope: "route", routeId: "quick", nodeId: "review", terminal: false },
  counters: { noResult: {}, productFailure: {},
    rewinds: { "target:quick/build": Number(process.argv[2]) } },
  outcome: "failed", failureOwner: "build", selectedRouteId: null,
  pinned: false, stepIndex: Number(process.argv[4]),
};
if (process.argv[3] !== "default") request.loopMaxRounds = Number(process.argv[3]);
if (process.argv[5] === "plain") delete quick.route.loop;
process.stdout.write(JSON.stringify(request));
' "$fixture_file" "$rounds_used" "$loop_max" "$step_index" "$shape"
}

step=$(make_step 12 default | "$route_tool" --profile sample editor-step)
assert_rc 0 "$?" "симуляция цикла выполняет шаг"
assert_contains "$step" '"rewind": "build"' \
  "после 12 кругов при потолке 20 цикл продолжается, общий бюджет 10 его не режет"
step=$(make_step 20 default | "$route_tool" --profile sample editor-step)
assert_contains "$step" '"stop": "loop-ceiling"' "двадцатый круг упирается в потолок по умолчанию"
step=$(make_step 2 2 | "$route_tool" --profile sample editor-step)
assert_contains "$step" '"stop": "loop-ceiling"' "потолок из запроса симуляции соблюдается"
step=$(make_step 1 301 | "$route_tool" --profile sample editor-step)
assert_contains "$step" 'loopMaxRounds' "потолок выше 300 в симуляции отклоняется с причиной"
# Потолок 300 — это 601 шаг до остановки: предел шагов цикла его вмещает, у обычного
# маршрута предел прежний — 200.
step=$(make_step 300 300 601 | "$route_tool" --profile sample editor-step)
assert_contains "$step" '"stop": "loop-ceiling"' \
  "шестьсот первый шаг сценария доводит потолок 300 до остановки"
step=$(make_step 299 300 600 | "$route_tool" --profile sample editor-step)
assert_contains "$step" '"rewind": "build"' "трёхсотая передача при потолке 300 исполняется"
step=$(make_step 0 default 201 plain | "$route_tool" --profile sample editor-step)
assert_contains "$step" 'stepIndex' "обычный маршрут по-прежнему ограничен 200 шагами"
step=$(make_step 0 default 1201 | "$route_tool" --profile sample editor-step)
assert_contains "$step" 'stepIndex' "у цикла предел шагов тоже есть — 1200"

# --- Контекст узла цикла -------------------------------------------------------------
root="$TEST_ROOT/loop-context"
state="$root/state"
repo="$root/repo"
mkdir -p "$state" "$repo"
cat >"$root/ticket.json" <<'JSON'
{"schema": 1, "taskId": "77", "title": "Цикл", "description": "Проверить контекст цикла.",
 "acceptanceCriteria": ["Контекст называет круг"], "sourceUrl": "https://portal.example.test/tasks/77"}
JSON
context_args=(
  --task 77 --profile demo-profile --attempt a_22222222222222222222222222222222
  --catalog-hash "$(printf 'a%.0s' {1..64})" --route loop
  --route-hash "$(printf 'b%.0s' {1..64})" --ticket-json "$root/ticket.json"
  --project-context-json '{"stack":["Python"],"guardrails":["Без auto-fix."]}'
  --repo "app:$repo:$repo:main" --state-dir "$state"
  --workspace-mode shared --container-name loop-stand --source-branch main
  --delivery-mode disabled
)
# Третий круг: исполнитель ещё не сдал — пишет report.r3.md, последний сданный — r2.
loop_state='{"schema":1,"loop":{"lead":"review","worker":"build","rounds":3,"stage":2,"maxRounds":20,'
loop_state+='"workerReport":"report.r3.md","lastReport":"report.r2.md"}}'
# Тот же круг после сдачи: ведущий читает r3, повторный визит исполнителя пишет r3.v2.
delivered_state='{"schema":1,"loop":{"lead":"review","worker":"build","rounds":3,"stage":2,'
delivered_state+='"maxRounds":20,"workerReport":"report.r3.v2.md","lastReport":"report.r3.md"}}'

worker=$("$context_tool" "${context_args[@]}" --node build --run-key BUILD \
  --loop-state-json "$loop_state" --loop-max-rounds 5)
assert_rc 0 "$?" "контекст исполнителя цикла собирается"
assert_eq "$state/t77.report.r3.md" "$(json_value artifacts.report <<<"$worker")" \
  "исполнитель пишет отчёт своего круга"
assert_eq "$state/t77.baseline.md" "$(json_value artifacts.baseline <<<"$worker")" \
  "исходный замер — отдельный артефакт задачи"
assert_eq worker "$(json_value evidence.loop.role <<<"$worker")" "роль исполнителя названа"
assert_eq 2 "$(json_value evidence.loop.roundsLeft <<<"$worker")" \
  "остаток кругов считается по потолку профиля"
lead=$("$context_tool" "${context_args[@]}" --node review --run-key REVIEW \
  --loop-state-json "$delivered_state" --loop-max-rounds 5)
assert_eq lead "$(json_value evidence.loop.role <<<"$lead")" "роль ведущего названа"
assert_eq "$state/t77.report.r3.md" "$(json_value artifacts.report <<<"$lead")" \
  "ведущий читает отчёт последнего круга"
revisit=$("$context_tool" "${context_args[@]}" --node build --run-key BUILD \
  --loop-state-json "$delivered_state" --loop-max-rounds 5)
assert_eq "$state/t77.report.r3.v2.md" "$(json_value artifacts.report <<<"$revisit")" \
  "повторный визит исполнителя в том же круге пишет новый отчёт, а не сданный"
gate=$("$context_tool" "${context_args[@]}" --node gate_accept --run-key GATE_ACCEPT \
  --loop-state-json "$delivered_state" --loop-max-rounds 5)
assert_eq "$state/t77.report.r3.md" "$(json_value artifacts.report <<<"$gate")" \
  "прочие узлы цикла видят последний сданный отчёт"
"$context_tool" "${context_args[@]}" --node build --run-key BUILD \
  --loop-state-json "${loop_state/report.r3.md/..\/t78.report.md}" --loop-max-rounds 5 \
  >/dev/null 2>&1
assert_rc 78 "$?" "имя отчёта визита вне контракта отвергается"
plain=$("$context_tool" "${context_args[@]}" --node review --run-key REVIEW)
assert_eq "$state/t77.report.md" "$(json_value artifacts.report <<<"$plain")" \
  "без цикла путь отчёта прежний"
assert_eq 'missing' "$(json_value evidence.loop <<<"$plain" 2>/dev/null || printf missing)" \
  "без цикла в evidence нет секции loop"
"$context_tool" "${context_args[@]}" --node build --run-key BUILD \
  --loop-state-json "$loop_state" --loop-max-rounds 0 >/dev/null 2>&1
assert_rc 78 "$?" "нулевой потолок в контексте отвергается"
"$context_tool" "${context_args[@]}" --node build --run-key BUILD \
  --loop-state-json "$loop_state" --loop-max-rounds 301 >/dev/null 2>&1
assert_rc 78 "$?" "потолок выше 300 в контексте отвергается"

# --- История результатов этапов: свежий хвост в контексте, опущенные — счётчиком ------
# Промпт узла уходит раннеру одной строкой argv (128 КиБ), поэтому сотни кругов истории
# в контекст целиком не идут; короткая история остаётся побайтно прежней.
stage_args=()
for sequence in $(seq 1 130); do
  stage_args+=(--stage-result "review:failed:$sequence")
done
trimmed=$("$context_tool" "${context_args[@]}" --node review --run-key REVIEW \
  --loop-state-json "$delivered_state" --loop-max-rounds 300 "${stage_args[@]}")
assert_rc 0 "$?" "контекст с длинной историей этапов собирается при потолке 300"
assert_eq 10 "$(json_value evidence.stageResultsOmitted <<<"$trimmed")" \
  "опущенные записи истории посчитаны"
assert_eq 11 "$(json_value evidence.stageResults.0.sequence <<<"$trimmed")" \
  "в контексте остаётся свежий хвост истории"
assert_eq 130 "$(json_value evidence.stageResults.119.sequence <<<"$trimmed")" \
  "последняя запись истории не теряется"
short=$("$context_tool" "${context_args[@]}" --node review --run-key REVIEW \
  "${stage_args[@]:0:20}")
assert_eq missing \
  "$(json_value evidence.stageResultsOmitted <<<"$short" 2>/dev/null || printf missing)" \
  "у короткой истории счётчика нет — контекст прежний"
assert_eq 10 "$(json_value evidence.stageResults.9.sequence <<<"$short")" \
  "короткая история идёт в контекст целиком"
overflow=()
for sequence in $(seq 1 1001); do
  overflow+=(--stage-result "build:done:$sequence")
done
"$context_tool" "${context_args[@]}" --node review --run-key REVIEW "${overflow[@]}" \
  >/dev/null 2>&1
assert_rc 78 "$?" "история длиннее предела входа отвергается"

# --- История находок длинного цикла: файлом и в ограниченном контексте ---------------
# Двенадцать этапов по 16 находок ведущего с текстом в 300 кириллических символов:
# 176 закрытых и 16 открытых. Одной строкой argv такая проекция уже не проходит
# (MAX_ARG_STRLEN — 128 КиБ), поэтому launcher отдаёт её файлом.
history="$root/findings-history.json"
python3 - "$history" <<'PY'
import json
import sys

text = "Ж" * 300
closed, opened = [], []
for stage in range(1, 13):
    for index in range(1, 17):
        record = {
            "id": f"s{stage}-f{index}", "sourceNode": "review", "owner": "build",
            "summary": f"{text} {stage}.{index}", "openedSequence": stage * 2,
            "lastSeenSequence": stage * 2, "status": "open", "closedSequence": None,
        }
        if stage < 12:
            record.update(status="closed", closedSequence=stage * 2 + 2)
            closed.append(record)
        else:
            opened.append(record)
with open(sys.argv[1], "w", encoding="utf-8") as target:
    json.dump({"schema": 1, "open": opened, "closed": closed, "deferred": []}, target,
              ensure_ascii=False, sort_keys=True, indent=2)
PY
history_bytes=$(stat -c %s "$history")
(( history_bytes > 131072 ))
assert_rc 0 "$?" "проекция истории больше предела одной строки argv ($history_bytes байт)"
bounded=$("$context_tool" "${context_args[@]}" --node review --run-key REVIEW \
  --loop-state-json "$delivered_state" --loop-max-rounds 20 --findings-ledger-file "$history")
assert_rc 0 "$?" "контекст ведущего собирается из файла истории"
summary=$(python3 -c '
import json, sys
findings = json.loads(sys.stdin.read())["evidence"]["findings"]
size = len(json.dumps(findings, ensure_ascii=False).encode())
newest = min(int(item["id"].split("-")[0][1:]) for item in findings["closed"])
print(len(findings["open"]), len(findings["closed"]), findings["omitted"]["closed"], size, newest)
' <<<"$bounded")
read -r open_count closed_count omitted_count findings_size oldest_stage <<<"$summary"
assert_eq 16 "$open_count" "открытые находки текущего этапа идут в контекст все"
assert_eq 176 "$(( closed_count + omitted_count ))" "опущенные закрытые названы числом"
(( closed_count > 0 && omitted_count > 0 && findings_size < 48 * 1024 ))
assert_rc 0 "$?" "история закрытых ограничена бюджетом ($closed_count в контексте, $findings_size байт)"
(( oldest_stage >= 10 ))
assert_rc 0 "$?" "в контексте остаются самые свежие закрытые (старейший этап $oldest_stage)"
small='{"schema":1,"open":[],"closed":[],"deferred":[]}'
printf '%s\n' "$small" >"$root/small-findings.json"
by_file=$("$context_tool" "${context_args[@]}" --node review --run-key REVIEW \
  --findings-ledger-file "$root/small-findings.json")
by_json=$("$context_tool" "${context_args[@]}" --node review --run-key REVIEW \
  --findings-ledger-json "$small")
assert_eq "$by_json" "$by_file" "у обычного маршрута файл и аргумент дают тот же контекст"
"$context_tool" "${context_args[@]}" --node review --run-key REVIEW \
  --findings-ledger-file "$root/small-findings.json" --findings-ledger-json "$small" \
  >/dev/null 2>&1
assert_rc 78 "$?" "два источника проекции находок сразу — отказ"
plain_history=$("$context_tool" "${context_args[@]}" --node review --run-key REVIEW \
  --findings-ledger-file "$history")
assert_rc 0 "$?" "обычный маршрут читает ту же проекцию из файла"
assert_eq '176 missing' "$(python3 -c '
import json, sys
findings = json.loads(sys.stdin.read())["evidence"]["findings"]
print(len(findings["closed"]), findings.get("omitted", "missing"))
' <<<"$plain_history")" "у обычного маршрута история не усекается — контекст прежний"

# --- Остановка по потолку в закрытом словаре аналитики ------------------------------
mapping=$(sed -n '/^v2_lifecycle_begin_human_for_stop() {/,/^}/p' "$FACTORY_HOME/bin/factory")
assert_contains "$mapping" 'rewind-limit|loop-ceiling) reason=rewind_limit' \
  "потолок кругов пишется существующей причиной rewind_limit, а не operator_requested"

finish_tests
