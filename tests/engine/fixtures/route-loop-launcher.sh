#!/usr/bin/env bash
# Общий стенд проверок режима «цикл» через настоящий launcher: профиль с потолком кругов,
# поддельный исполнитель модели по сценарию, опубликованный каталог с маршрутом цикла и
# обычным маршрутом той же формы, помощники реестра, lifecycle и запуска. Подключается
# из tests/engine/integration/route-loop-*.sh после testlib.sh.
export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
export FACTORY_RUNNERS_DIR="$TEST_ROOT/runners"
export LOOP_SCRIPT="$TEST_ROOT/loop-script.txt"
export LOOP_CALLS="$TEST_ROOT/loop-calls.log"
export LOOP_FINDINGS="$TEST_ROOT/loop-findings.log"
profile_dir="$FACTORY_PROFILES_DIR/demo-profile"
repo="$TEST_ROOT/checkout"
mkdir -p "$profile_dir" "$FACTORY_RUNNERS_DIR" "$repo"

if [[ -z "${NODE_BIN:-}" || ! -x "$NODE_BIN" ]]; then
  test_fail "host node is available" "NODE_BIN is empty"
  finish_tests
  exit $?
fi

git -C "$repo" init -q
git -C "$repo" config user.name fixture
git -C "$repo" config user.email fixture@example.test
git -C "$repo" checkout -qb shared-main
printf 'baseline\n' >"$repo/tracked.txt"
git -C "$repo" add tracked.txt
git -C "$repo" commit -qm baseline

cat >"$profile_dir/runners.env" <<'ENV'
RUNNERS_SCHEMA=1
CONFIG_REVISION=1
RUNNERS_COVERAGE=required
PROJECT_RUNNER_PRIMARY=alpha
PROJECT_RUNNER_FAILOVER=
MODEL_DEFAULT_ALPHA_FAMILY=fixture
MODEL_DEFAULT_ALPHA_VERSION=latest
ENV
printf '%s\n' '{"capabilities":["route-v2"]}' >"$profile_dir/graph.json"

write_profile() {
  local max_rounds=$1
  cat >"$profile_dir/profile.sh" <<PROFILE
PROFILE_NAME=demo-profile
PROFILE_SERVICE_HOST=127.0.0.1
PROFILE_LOOP_MAX_ROUNDS=$max_rounds
profile_workspace_mode() { printf 'shared\\n'; }
profile_repositories() { printf 'app\\t%s\\t%s\\n' '$repo' '$repo'; }
profile_source_branch() { printf 'shared-main\\n'; }
profile_container() { printf 'fixture-stand\\n'; }
profile_stand_alive() { return 0; }
profile_project_context() { printf '%s\\n' '{"stack":["fixture"],"guardrails":[]}'; }
profile_service_ports() { printf '8830\\t8830\\n'; }
profile_exclusive_resources() {
  printf '%s\\n' 'stand:fixture-stand' 'workspace:$repo'
}
PROFILE
}

# Исполнитель модели по сценарию: строка «УЗЕЛ|исход|owner|id=текст;…|закрываемые-id,…».
# Исполнитель пишет отчёт своего круга по пути из typed context — так проверяется,
# что контекст действительно отдаёт отчёт круга и секцию evidence.loop. Исход
# `noresult` — заход без статуса: отчёт начат, результата нет.
cat >"$FACTORY_RUNNERS_DIR/alpha.sh" <<'RUNNER'
source "$FACTORY_TESTS_HOME/fakes/runners/alpha.sh"
runner_alpha_run() {
  local task=$1 prompt=$2 stage=$3 line expected result owner raw closes context item
  local -a args=() items=()
  line=$(head -n 1 "$LOOP_SCRIPT")
  sed -i '1d' "$LOOP_SCRIPT"
  IFS='|' read -r expected result owner raw closes <<<"$line"
  # Промпт — в stdin: аргументом он упёрся бы в тот же предел строки argv, что и история.
  context=$(python3 -c '
import json
import re
import sys

prompt = sys.stdin.read()
sections = {}
pattern = r"----- BEGIN CONTEXT (\w+) bytes=\d+ sha256=\w+ -----\n(.*?)\n----- END CONTEXT"
for name, body in re.findall(pattern, prompt, re.S):
    sections[name] = json.loads(body)
loop = sections["evidence"].get("loop") or {}
findings = sections["evidence"]["findings"]
fields = [
    loop.get("role") or "-", loop.get("round", "-"), sections["artifacts"]["report"],
    len(findings["open"]), len(findings["closed"]),
    (findings.get("omitted") or {}).get("closed", 0), len(prompt.encode()),
]
print(*fields, sep="\t")
' <<<"$prompt") || return 43
  local role round report open_count closed_count omitted_count prompt_bytes
  IFS=$'\t' read -r role round report open_count closed_count omitted_count prompt_bytes \
    <<<"$context"
  [[ "$role" != - ]] || role=""
  printf '%s:%s:%s:%s\n' "$stage" "${FACTORY_LOOP_ROLE:-}" "$role" "${report##*/}" >>"$LOOP_CALLS"
  printf '%s %s %s %s %s\n' "$stage" "$open_count" "$closed_count" "$omitted_count" \
    "$prompt_bytes" >>"$LOOP_FINDINGS"
  [[ "$stage" == "$expected" ]] || return 44
  if [[ "$stage" == BUILD ]]; then
    printf 'отчёт круга %s\n' "$round" >"$report" || return 45
  fi
  [[ "$result" != noresult ]] || return 0
  if [[ -n "$raw" ]]; then
    args+=(--failure-owner "$owner")
    IFS=';' read -r -a items <<<"$raw"
    for item in "${items[@]}"; do
      args+=(--finding "$item")
    done
    if [[ -n "$closes" ]]; then
      args+=(--next-stage --stage-summary 'этап проверен')
      IFS=',' read -r -a items <<<"$closes"
      for item in "${items[@]}"; do
        args+=(--stage-closed "$item")
      done
    fi
  fi
  FACTORY_STATUS_FD=7 bash "$FACTORY_HOME/lib/stage-result.sh" \
    --task "$FACTORY_RUN_TASK" --stage "$FACTORY_RUN_STAGE" \
    --run-id "$FACTORY_RUN_ID" --epoch "$FACTORY_RUN_EPOCH" "$result" "${args[@]}"
}
RUNNER

cat >"$TEST_ROOT/publish-loop.mjs" <<'JS'
import { pathToFileURL } from 'node:url';

const [root, baseDir] = process.argv.slice(2);
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
  retry: { noResult: 0, providerFailure: { attempts: 0, strategy: 'none' }, productFailure: 0 },
  on,
  onFailure,
});
const route = {
  schema: 2,
  kind: 'route',
  profile: fixtures.PROFILE_ID,
  id: 'loop',
  bootstrap: 'skip',
  loop: { lead: 'review', worker: 'build' },
  entry: 'review',
  sequence: { main: ['build', 'review', 'gate_accept'], tail: [] },
  nodes: [
    agent('build', 'workspace-write',
      { done: next('review'), skipped: next('review'), failed: next('review'), exhausted: stop() },
      { build: next('review'), tests: next('review'), plan: next('review'), human: next('review'),
        environment: stop() }),
    agent('review', 'state-only',
      { done: next('gate_accept'), skipped: stop(), failed: transfer, exhausted: stop() },
      { build: transfer, tests: transfer, environment: stop(), plan: stop(), human: stop() }),
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
const prompts = {
  'prompts/build.base.md': 'Исполни задание и запиши отчёт своего круга.',
  'prompts/review.base.md': 'Поставь задание, проверь круг, веди этапы.',
};
const bootstrap = structuredClone(fixtures.bootstrap);
bootstrap.nodes[0].on.done.escalate.routes = ['loop', 'plain'];
bootstrap.escalation[0].allowedRoutes = ['loop', 'plain'];
// Обычный маршрут той же формы без `loop`: режим цикла не должен до него дотягиваться.
const plain = structuredClone(route);
plain.id = 'plain';
delete plain.loop;
const store = new RoutesStore({ baseDir });
const published = await store.publishRoute(fixtures.PROFILE_ID, 'loop', { route, prompts });
const publishedPlain = await store.publishRoute(fixtures.PROFILE_ID, 'plain', {
  route: plain,
  prompts,
});
const result = await store.publishCatalog(fixtures.PROFILE_ID, {
  catalog: {
    schema: 2,
    profile: fixtures.PROFILE_ID,
    routes: { loop: published.routeHash, plain: publishedPlain.routeHash },
    bootstrap: { file: 'bootstrap/scout.json' },
  },
  bootstrap,
  prompts: fixtures.bootstrapPrompts,
}, { expectedCatalogHash: null });
process.stdout.write(result.catalogHash);
JS

routes="$TEST_ROOT/routes"
"$NODE_BIN" "$TEST_ROOT/publish-loop.mjs" "$FACTORY_HOME/.." "$routes" >/dev/null
assert_rc 0 "$?" "маршрут цикла публикуется для настоящего launcher"

task=7101
state="$TEST_ROOT/state"
control="$TEST_ROOT/control"
cat >"$TEST_ROOT/ticket.json" <<JSON
{"schema":1,"taskId":"$task","title":"Цикл через launcher","description":"fixture",
"acceptanceCriteria":["этапы идут без человека"],"sourceUrl":"https://example.test/$task"}
JSON
registry_value() {
  awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$state/t${task}.pipeline"
}
# Есть ли ключ в реестре вообще: снятый признак — пустое значение, отсутствующий — «нет».
registry_has() {
  grep -q "^$1=" "$state/t${task}.pipeline" && printf 'есть\n' || printf 'нет\n'
}
# Вмешательства человека в lifecycle-журнале: «открыто закрыто».
human_interventions() {
  printf '%s %s\n' \
    "$(grep -rho 'human_intervention_started' "$control" "$state" 2>/dev/null | wc -l)" \
    "$(grep -rho 'human_intervention_resolved' "$control" "$state" 2>/dev/null | wc -l)"
}
launch() {
  local log=$1
  shift
  FACTORY_FORBID_LIVE=0 timeout -k 5 "${LAUNCH_TIMEOUT:-300}" "$FACTORY_HOME/bin/factory" "$task" "$@" \
    --routes-dir "$routes" --state-dir "$state" --control-dir "$control" >"$log" 2>&1
}

