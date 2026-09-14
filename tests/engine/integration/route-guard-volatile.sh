#!/usr/bin/env bash
# Сторож state-only и runtime-артефакты проверочного инструментария.
#
# Живой случай: Playwright-сетап проекта переписывал untracked storage state
# (`e2e/.auth/user.json`) при каждом прогоне e2e, а `.gitignore` проекта этот путь не
# закрывал. Проверяющие узлы (verify, критик тестов) честно гоняли e2e — и сторож ронял
# попытку кодом 75, не называя причины: три задачи подряд разбирались руками по base64.
#
# Здесь проверяется контракт целиком: (1) без объявления расхождение по-прежнему
# fail-closed, но с причиной и путём в журнале; (2) объявленный профилем runtime-путь
# сторож терпит и узел коммитится; (3) объявление вне рабочих деревьев отвергается.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

export FACTORY_ROUTE_STATE_DIR="$STATE_DIR"
source "$FACTORY_HOME/lib/route-runtime.sh"

routes_dir="$TEST_ROOT/routes"
publisher="$FACTORY_TESTS_HOME/fixtures/routes-catalog-publish.mjs"
profile_id=demo-profile
command_task=9107
agent_task=9108
base_repo="$TEST_ROOT/source"
worktree="$TEST_ROOT/worktree-guard"
artifact="$worktree/e2e/.auth/user.json"
STAGES_LOG="$TEST_ROOT/stages.log"
FIXTURE_CONTEXT="$TEST_ROOT/context.json"

json_field() {
  "$NODE_BIN" -e '
    const value = JSON.parse(process.argv[1]);
    let cursor = value;
    for (const key of process.argv.slice(2)) cursor = cursor[key];
    process.stdout.write(cursor == null ? "" : String(cursor));
  ' "$@"
}

git init -q "$base_repo"
git -C "$base_repo" config user.email tests@example.invalid
git -C "$base_repo" config user.name Tests
printf 'baseline\n' >"$base_repo/trace.txt"
# .gitignore проекта закрывает «правильный» каталог, а инструментарий пишет в соседний —
# ровно то расхождение, которое встретилось в живом проекте.
printf 'tests/e2e/.auth/\n' >"$base_repo/.gitignore"
git -C "$base_repo" add trace.txt .gitignore
git -C "$base_repo" commit -qm baseline
git -C "$base_repo" worktree add -qb route-run "$worktree"

published=$("$NODE_BIN" "$publisher" "$routes_dir" null)
assert_rc 0 "$?" "каталог маршрутов публикуется в изолированный store"

route_v2_workspace_roots() {
  printf '%s\n' "$worktree"
}

# Журнал оркестратора: в бою это flog в stages.log, здесь — файл, по которому
# проверяется, что причина остановки названа.
v2_log() {
  printf '%s\n' "$*" >>"$STAGES_LOG"
}

write_context() {
  local task=$1 attempt=$2 route=$3
  cat >"$FIXTURE_CONTEXT" <<JSON
{
  "task": {"id": $task, "title": "guard"},
  "attempt": {"id": "$attempt"},
  "project": {"profile": "$profile_id"},
  "workspace": {"service": {"path": "$worktree"}, "client": {"path": "$worktree"}},
  "services": {"apiUrl": "unavailable"},
  "artifacts": {"root": "$STATE_DIR"},
  "diagnosis": {"kind": "functional"},
  "instrumentation": {"allowedFiles": [], "marker": "FACTORY-TRACE:t$task", "scopeFile": ""},
  "evidence": {"eventCount": 0},
  "decisions": {
    "cause": {"status": "approved", "comment": ""},
    "review": {"status": "approved", "comment": ""},
    "acceptance": {"status": "PENDING", "comment": ""}
  },
  "delivery": {
    "mode": "disabled",
    "actions": [],
    "targetBranches": {},
    "sourceBranch": "fixture-$task"
  },
  "routeCatalog": {"$route": "$(json_field "$published" routeHashes "$route")"},
  "stage": {"id": "placeholder", "runKey": "PLACEHOLDER"}
}
JSON
}

route_v2_context_for_node() {
  cp -- "$FIXTURE_CONTEXT" "$5"
}

# Артефакт прогона: каждый вызов — новый «токен», как у логина Playwright.
rewrite_artifact() {
  mkdir -p -- "$(dirname "$artifact")"
  printf 'token-%s-%s\n' "$RANDOM" "$(date +%s%N)" >"$artifact"
}

FAKE_EPOCH=0
AGENT_WRITES=0
run_agent() {
  local task=$1 prompt=$2 stage=$3 file
  FAKE_EPOCH=$((FAKE_EPOCH + 1))
  if [[ "$stage" == REPRO ]] && (( AGENT_WRITES )); then
    rewrite_artifact
  fi
  file=$(run_state_active_file "$task" "$stage") || return
  _run_state_write \
    "$file" "fake-${stage}-${FAKE_EPOCH}" "$FAKE_EPOCH" \
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    committed done
}

# Доверенная команда профиля прогоняет «e2e» и оставляет после себя storage state.
profile_route_command() {
  rewrite_artifact
  printf '%s\n' \
    '{"schema":1,"outcome":"done","comment":"fixture verify passed","failureOwner":null,"findings":[]}'
}

# --- command-узел (verify): расхождение названо, а не спрятано в код 75 ---
ATTEMPT_STATE_ID_OVERRIDE=a_91079107910791079107910791079107
command_attempt=$(attempt_state_begin_v2 "$command_task" "$profile_id" "$routes_dir")
begin_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
assert_rc 0 "$begin_rc" "попытка command-сценария начинается"
write_context "$command_task" "$command_attempt" command
attempt_state_select_route_v2 "$command_task" "$command_attempt" command >/dev/null
route_v2_dispatch_bootstrap "$command_task" "$command_attempt" >/dev/null
assert_rc 0 "$?" "bootstrap command-сценария коммитится"
attempt_stage_state_init_v2 "$command_task" "$command_attempt" command >/dev/null
route_v2_dispatch_next "$command_task" "$command_attempt" >/dev/null
assert_rc 0 "$?" "подготовительный агент доходит до command-узла"

: >"$STAGES_LOG"
route_v2_dispatch_next "$command_task" "$command_attempt" >/dev/null
assert_rc 75 "$?" "без объявления переписанный runtime-файл останавливает узел fail-closed"
assert_contains "$(cat "$STAGES_LOG")" \
  "VERIFY: сторож state-only: узел verify изменил рабочее дерево — UNTRACKED $worktree/e2e/.auth (1)" \
  "журнал называет узел, вид записи и каталог расхождения"
assert_contains "$(cat "$STAGES_LOG")" "profile_route_volatile_paths" \
  "журнал подсказывает, как объявить runtime-путь"
if [[ "$(cat "$STAGES_LOG")" == *token-* ]]; then
  test_fail "журнал не раскрывает содержимое файла"
else
  test_ok "журнал не раскрывает содержимое файла"
fi
guard_dir="$(factory_control_root)/guards-v2/t${command_task}/${command_attempt}/verify"
assert_file_exists "$guard_dir/sequence-1.after.diff" "диф снимков сохранён для разбора"
cursor=$(attempt_stage_state_read_v2 "$command_task" "$command_attempt")
assert_eq verify "$(json_field "$cursor" currentNode)" "курсор остаётся на узле verify"
assert_eq ready "$(json_field "$cursor" state)" "узел не закоммичен и ждёт resume"

# Объявление вне рабочих деревьев задачи — ошибка профиля, fail-closed без послаблений.
route_v2_volatile_paths() {
  printf '%s\n' "$TEST_ROOT/elsewhere/.auth"
}
: >"$STAGES_LOG"
route_v2_dispatch_next "$command_task" "$command_attempt" >/dev/null
assert_rc 78 "$?" "runtime-путь вне рабочих деревьев отвергается"

# Объявленный профилем путь: тот же переписанный файл больше не останавливает маршрут.
route_v2_volatile_paths() {
  printf '%s\n' "$worktree/e2e/.auth"
}
: >"$STAGES_LOG"
advanced=$(route_v2_dispatch_next "$command_task" "$command_attempt")
assert_rc 0 "$?" "объявленный runtime-путь: command-узел коммитится"
assert_eq retro "$(json_field "$advanced" currentNode)" "маршрут идёт дальше"
if [[ "$(cat "$STAGES_LOG")" == *сторож* ]]; then
  test_fail "сторож молчит, когда расхождения нет" "$(cat "$STAGES_LOG")"
else
  test_ok "сторож молчит, когда расхождения нет"
fi
assert_contains "$(cat "$guard_dir/sequence-1.volatile.list")" "$worktree/e2e/.auth" \
  "объявление записано рядом со снимком"
unset -f route_v2_volatile_paths

# --- агентный узел (repro): тот же контракт на другом пути исполнения ---
ATTEMPT_STATE_ID_OVERRIDE=a_91089108910891089108910891089108
agent_attempt=$(attempt_state_begin_v2 "$agent_task" "$profile_id" "$routes_dir")
begin_rc=$?
unset ATTEMPT_STATE_ID_OVERRIDE
assert_rc 0 "$begin_rc" "попытка агентного сценария начинается"
write_context "$agent_task" "$agent_attempt" debug
attempt_state_select_route_v2 "$agent_task" "$agent_attempt" debug >/dev/null
route_v2_dispatch_bootstrap "$agent_task" "$agent_attempt" >/dev/null
assert_rc 0 "$?" "bootstrap агентного сценария коммитится"
attempt_stage_state_init_v2 "$agent_task" "$agent_attempt" debug >/dev/null

AGENT_WRITES=1
: >"$STAGES_LOG"
route_v2_dispatch_next "$agent_task" "$agent_attempt" >/dev/null
assert_rc 75 "$?" "агентный state-only узел с переписанным runtime-файлом останавливается"
assert_contains "$(cat "$STAGES_LOG")" \
  "REPRO: сторож state-only: узел repro изменил рабочее дерево — UNTRACKED $worktree/e2e/.auth (1)" \
  "журнал агентного узла называет причину"

route_v2_volatile_paths() {
  printf '%s\n' "$worktree/e2e/.auth"
}
: >"$STAGES_LOG"
advanced=$(route_v2_dispatch_next "$agent_task" "$agent_attempt")
assert_rc 0 "$?" "объявленный runtime-путь: агентный узел коммитится"
assert_eq instrument "$(json_field "$advanced" currentNode)" "агентный маршрут идёт дальше"

finish_tests
