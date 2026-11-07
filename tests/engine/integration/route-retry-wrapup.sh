#!/usr/bin/env bash
# Повтор узла после захода без результата — закрывающий, а не слепой.
#
# Живой случай (t7989, узел плана): три захода подряд по 30 минут, каждый начинался с
# полного промпта и требования поднять веер из трёх ролей, каждый был убит по лимиту
# времени перед stage-result — третий записал артефакт за 50 секунд до обрыва. Затем
# рантайм выработал exhausted с комментарием «раннер не зафиксировал результат», а строка
# остановки в журнале стадий ушла голой — и карточка показала «узел вернул решение
# человеку» с советом прочитать замечание, которого агент не писал.
#
# Здесь проверяется контракт целиком: (1) после таймаута повтор идёт без веера, если
# узел допускает одиночный режим, и знает класс исхода; (2) после упавшего процесса веер
# сохраняется — бюджет времени не тратился; (3) исчерпание называет число заходов и
# последний исход, и та же причина уезжает в суффикс строки остановки.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

export FACTORY_ROUTE_STATE_DIR="$STATE_DIR"
source "$FACTORY_HOME/lib/route-runtime.sh"

routes_dir="$TEST_ROOT/routes"
publisher="$FACTORY_TESTS_HOME/fixtures/routes-catalog-publish.mjs"
profile_id=demo-profile
timeout_task=9201
crash_task=9202
exhausted_task=9203
base_repo="$TEST_ROOT/source"
worktree="$TEST_ROOT/worktree-wrapup"
RUNS_LOG="$TEST_ROOT/runs.log"
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
git -C "$base_repo" add trace.txt
git -C "$base_repo" commit -qm baseline
git -C "$base_repo" worktree add -qb route-run "$worktree"

published=$("$NODE_BIN" "$publisher" "$routes_dir" null)
assert_rc 0 "$?" "каталог маршрутов публикуется в изолированный store"

route_v2_workspace_roots() {
  printf '%s\n' "$worktree"
}

write_context() {
  local task=$1 attempt=$2 route=$3
  cat >"$FIXTURE_CONTEXT" <<JSON
{
  "task": {"id": $task, "title": "wrap-up"},
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

# Фейковый раннер: пишет в журнал то, что заход увидел бы в промпте (режим веера, номер
# захода, причина и класс повтора), молчит SILENT_LEFT раз на узле PREPARE и оставляет
# в глобале диспетчера класс запуска — как настоящий dispatcher_run_chain.
FAKE_RESULT=done
FAKE_COMMENT=""
FAKE_EPOCH=0
SILENT_LEFT=0
SILENT_CLASS=timeout
SILENT_DETAIL=""
# Typed verdict сценария (base64 JSON); пустое значение — обычная сдача без вердикта.
FAKE_VERDICT=""
run_agent() {
  local task=$1 prompt=$2 stage=$3 run_id token=fake-token
  printf '%s\t%s\t%s\t%s\t%s\n' "$stage" "${FACTORY_ROUTE_FANOUT_MODE:-}" \
    "${FACTORY_STAGE_RETRY:-}" "${FACTORY_STAGE_RETRY_REASON:-}" \
    "${FACTORY_STAGE_RETRY_NOTE:-}" >>"$RUNS_LOG"
  FAKE_EPOCH=$((FAKE_EPOCH + 1))
  run_id="fake-${stage}-${FAKE_EPOCH}"
  MULTI_LAST_RUN_ID=$run_id
  MULTI_LAST_RUN_EPOCH=$FAKE_EPOCH
  run_state_begin "$task" "$stage" "$run_id" "$FAKE_EPOCH" "$token" || return
  if [[ "$stage" == PREPARE ]] && (( SILENT_LEFT > 0 )); then
    SILENT_LEFT=$((SILENT_LEFT - 1))
    DISPATCH_RESULT_KIND=$SILENT_CLASS
    DISPATCH_RESULT_DETAIL=$SILENT_DETAIL
    return 0
  fi
  run_state_apply_result "$task" "$stage" "$run_id" "$FAKE_EPOCH" "$token" \
    "$FAKE_RESULT" "$FAKE_COMMENT" "${FAKE_VERDICT:-}"
}

# Попытка на маршруте command: его узел prepare объявляет веер parallel/3 с
# degrade=allow-single и бюджет 1 + noResult(1) + providerFailure(1) = 3 захода.
begin_attempt() {
  local task=$1 override=$2 attempt rc
  ATTEMPT_STATE_ID_OVERRIDE=$override
  attempt=$(attempt_state_begin_v2 "$task" "$profile_id" "$routes_dir")
  rc=$?
  unset ATTEMPT_STATE_ID_OVERRIDE
  (( rc == 0 )) || return "$rc"
  write_context "$task" "$attempt" command
  attempt_state_select_route_v2 "$task" "$attempt" command >/dev/null || return
  route_v2_dispatch_bootstrap "$task" "$attempt" >/dev/null || return
  attempt_stage_state_init_v2 "$task" "$attempt" command >/dev/null || return
  printf '%s\n' "$attempt"
}

# --- число заходов словами: комментарий читает человек ---
assert_eq '1 заход' "$(_route_v2_runs_phrase 1)" "один заход"
assert_eq '3 захода' "$(_route_v2_runs_phrase 3)" "три захода"
assert_eq '5 заходов' "$(_route_v2_runs_phrase 5)" "пять заходов"
assert_eq '11 заходов' "$(_route_v2_runs_phrase 11)" "одиннадцать заходов"
assert_eq '21 заход' "$(_route_v2_runs_phrase 21)" "двадцать один заход"
assert_eq 'убит по лимиту времени этапа' "$(_route_v2_no_result_label timeout)" \
  "класс timeout назван человеку"
assert_eq 'результат не зафиксирован' "$(_route_v2_no_result_label '')" \
  "пустой класс не выдумывает причину"
assert_eq 'context_overflow' "$(_route_v2_no_result_label context_overflow)" \
  "незнакомый класс показывается как есть"

# --- таймаут: повтор идёт без веера и знает, что прошлый заход убит по времени ---
timeout_attempt=$(begin_attempt "$timeout_task" a_92019201920192019201920192019201)
assert_rc 0 "$?" "попытка сценария таймаута начинается"
SILENT_LEFT=1
SILENT_CLASS=timeout
: >"$RUNS_LOG"
advanced=$(route_v2_dispatch_next "$timeout_task" "$timeout_attempt")
assert_rc 0 "$?" "заход без результата повторяется в пределах бюджета"
assert_eq 2 "$(wc -l <"$RUNS_LOG")" "после таймаута ровно один повтор до результата"
assert_eq $'PREPARE\tparallel\t1\t\t' "$(sed -n '1p' "$RUNS_LOG")" \
  "первый заход идёт с веером, объявленным узлом"
assert_eq $'PREPARE\tsingle\t2\tno-result\ttimeout' "$(sed -n '2p' "$RUNS_LOG")" \
  "повтор после таймаута идёт без веера и с классом исхода прошлого захода"
assert_eq verify "$(json_field "$advanced" currentNode)" \
  "закрывающий заход коммитит done, и маршрут идёт дальше"
assert_eq '' "$(route_v2_stop_line_suffix "$timeout_task" "$timeout_attempt")" \
  "у идущей попытки суффикса остановки нет"

# --- упавший процесс: бюджет времени не тратился, веер остаётся ---
crash_attempt=$(begin_attempt "$crash_task" a_92029202920292029202920292029202)
assert_rc 0 "$?" "попытка сценария падения начинается"
SILENT_LEFT=1
SILENT_CLASS=crashed
: >"$RUNS_LOG"
route_v2_dispatch_next "$crash_task" "$crash_attempt" >/dev/null
assert_rc 0 "$?" "заход после падения повторяется"
assert_eq $'PREPARE\tparallel\t2\tno-result\tcrashed' "$(sed -n '2p' "$RUNS_LOG")" \
  "после падения процесса повтор сохраняет веер и называет класс исхода"

# --- исчерпание: причина с цифрами в комментарии узла и в строке остановки ---
exhausted_attempt=$(begin_attempt "$exhausted_task" a_92039203920392039203920392039203)
assert_rc 0 "$?" "попытка сценария исчерпания начинается"
SILENT_LEFT=99
SILENT_CLASS=timeout
: >"$RUNS_LOG"
stopped=$(route_v2_dispatch_next "$exhausted_task" "$exhausted_attempt")
assert_rc 0 "$?" "сожжённый бюджет коммитит синтетический exhausted"
assert_eq 3 "$(wc -l <"$RUNS_LOG")" "исчерпание наступает после полного бюджета"
assert_eq $'PREPARE\tsingle\t3\tno-result\ttimeout' "$(sed -n '3p' "$RUNS_LOG")" \
  "третий заход тоже закрывающий"
assert_eq stopped "$(json_field "$stopped" state)" "исчерпание останавливает маршрут"
assert_eq human "$(json_field "$stopped" stop)" "маршрут отдаёт исчерпание человеку"
exhausted_reason='исчерпан бюджет повторов: 3 захода без результата, последний — убит по лимиту времени этапа'
assert_eq "$exhausted_reason" "$(pipeline_store_get "$exhausted_task" PREPARE_COMMENT)" \
  "комментарий узла называет число заходов и последний исход"
assert_eq " — $exhausted_reason" "$(route_v2_stop_line_suffix "$exhausted_task" "$exhausted_attempt")" \
  "строка остановки несёт ту же причину суффиксом"

# Конкретное пояснение сохраняется и при unknown; оно не меняет бюджет повторов.
detail_task=9204
detail_attempt=$(begin_attempt "$detail_task" a_92049204920492049204920492049204)
assert_rc 0 "$?" "попытка с пояснением ошибки начинается"
SILENT_LEFT=99
SILENT_CLASS=unknown
SILENT_DETAIL='ошибка провайдера: Provider E_NEW'
: >"$RUNS_LOG"
stopped=$(route_v2_dispatch_next "$detail_task" "$detail_attempt")
assert_rc 0 "$?" "unknown с текстом коммитит обычный exhausted"
assert_eq 3 "$(wc -l <"$RUNS_LOG")" "пояснение не меняет число повторов"
assert_contains "$(pipeline_store_get "$detail_task" PREPARE_COMMENT)" "$SILENT_DETAIL" \
  "конкретная ошибка передана в комментарий остановки"
assert_contains "$(route_v2_stop_line_suffix "$detail_task" "$detail_attempt")" "$SILENT_DETAIL" \
  "та же ошибка передана в журнал остановки"

# Skipped передаёт комментарий из terminal record в immutable commit.
skipped_task=9205
skipped_attempt=$(begin_attempt "$skipped_task" a_92059205920592059205920592059205)
assert_rc 0 "$?" "попытка skipped начинается"
SILENT_LEFT=0
FAKE_RESULT=skipped
FAKE_COMMENT='Браузер недоступен: access_revoked; отчёт сохранён'
stopped=$(route_v2_dispatch_next "$skipped_task" "$skipped_attempt")
assert_rc 0 "$?" "skipped с комментарием коммитится"
skipped_event=$(find "$(factory_control_root)/protocol-v2/tasks/t${skipped_task}" -name 'event.*.json' -print | sort | tail -1)
assert_eq "$FAKE_COMMENT" "$(json_field "$(cat "$skipped_event")" reason)" \
  "причина skipped сохранена в журнале маршрута"

# --- отказ среды: failed/environment не повторяется и сразу решается человеком ---
# Живой замер (t100000000010, SHIP с codex): песочница не пишет git-метаданные linked
# worktree, и агент пять заходов подряд честно отдавал failed/environment — каждый
# повтор сжигал xhigh-заход о детерминированную стену. Движок обязан остановиться
# после первого такого вердикта и назвать человеку, что делать дальше.
environment_task=9206
FAKE_RESULT=done
FAKE_COMMENT=""
FAKE_VERDICT=""
environment_attempt=$(begin_attempt "$environment_task" a_92069206920692069206920692069206)
assert_rc 0 "$?" "попытка сценария отказа среды начинается"
environment_comment='Публикация не выполнена: git add отказал — index.lock linked worktree в read-only .git основного checkout'
environment_verdict=$(run_state_verdict_encode failed environment \
  'publication-git-readonly=Запись в git-метаданные worktree запрещена песочницей')
FAKE_RESULT=failed
FAKE_COMMENT="$environment_comment"
FAKE_VERDICT="$environment_verdict"
: >"$RUNS_LOG"
stopped=$(route_v2_dispatch_next "$environment_task" "$environment_attempt")
assert_rc 0 "$?" "вердикт отказа среды коммитится доверенным рантаймом"
assert_eq 1 "$(wc -l <"$RUNS_LOG")" \
  "отказ среды не повторяется: один заход вместо полного бюджета"
assert_eq stopped "$(json_field "$stopped" state)" "отказ среды останавливает маршрут"
assert_eq human "$(json_field "$stopped" stop)" "отказ среды отдаёт решение человеку"
assert_eq failed "$(json_field "$stopped" lastCommit outcome)" \
  "исход узла остаётся продуктовым failed с владельцем среды"
assert_contains "$(pipeline_store_get "$environment_task" PREPARE_COMMENT)" "отчёт агента: $environment_comment" \
  "комментарий узла несёт дословный отчёт агента"
assert_contains "$(pipeline_store_get "$environment_task" PREPARE_COMMENT)" "повтор с тем же исполнителем обречён" \
  "комментарий узла объясняет, почему повторов не будет"
environment_suffix=$(route_v2_stop_line_suffix "$environment_task" "$environment_attempt")
assert_contains "$environment_suffix" "отказ среды: повтор с тем же исполнителем обречён" \
  "строка остановки несёт машинную причину суффиксом"
assert_contains "$environment_suffix" "перейти сюда" \
  "суффикс говорит человеку, как продолжить"
[[ "$environment_suffix" == *"отчёт агента"* ]]
assert_rc 1 "$?" "в строке остановки нет дословного отчёта агента"
owner=$(run_state_verdict_owner failed "$environment_verdict")
assert_eq environment "$owner" "владелец отказа среды доезжает до вердикта попытки"

finish_tests
