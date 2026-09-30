#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

export FACTORY_ROUTE_STATE_DIR="$STATE_DIR"
source "$FACTORY_HOME/lib/route-runtime.sh"

routes="$TEST_ROOT/routes"
profile=demo-profile
published=$("$NODE_BIN" "$FACTORY_TESTS_HOME/fixtures/routes-catalog-publish.mjs" "$routes" null)
assert_rc 0 "$?" "опубликован изолированный каталог"
workspace="$TEST_ROOT/workspace"
git init -q "$workspace"
git -C "$workspace" config user.email tests@example.invalid
git -C "$workspace" config user.name Tests
printf 'baseline\n' >"$workspace/source.txt"
git -C "$workspace" add source.txt
git -C "$workspace" commit -qm baseline

# Контекст содержит реальные workspace/pin, но запуск модели заменён фикстурой.
# Доверенный результат всё равно публикует настоящая команда stage-result.
route_v2_context_for_node() {
  cat >"$5" <<JSON
{"task":{"id":"$1"},"attempt":{"id":"$2"},"project":{"profile":"$profile"},
"workspace":{"service":{"path":"$workspace"}},"services":{},"artifacts":{"root":"$STATE_DIR"},
"diagnosis":{},"instrumentation":{},"evidence":{},"decisions":{},
"delivery":{"mode":"disabled","actions":[],"targetBranches":{}},
"routeCatalog":{"debug":"$(jq -r .routeHashes.debug <<<"$published")"},
"stage":{"id":"$3","runKey":"$4"}}
JSON
}

route_v2_workspace_roots() {
  printf '%s\n' "$workspace"
}

v2_log() {
  printf '%s\n' "$*" >>"$TEST_ROOT/bootstrap.log"
}

# Непустой вердикт и run identity проходят тот же FD/CAS, что у рабочего раннера.
# Счётчик на диске обнаруживает лишнее исполнение после долговечного checkpoint.
run_agent() {
  local task=$1 stage=$3 epoch=1 token=fixture-capability file previous
  local outcome=${FIXTURE_OUTCOME:-done}
  : >"$TEST_ROOT/human-note"
  if [[ -n "${FACTORY_STAGE_BOOTSTRAP_DECISION_FILE:-}" ]]; then
    bash -c 'source "$1/lib/core.sh"; _stage_bootstrap_decision_block "$2"' \
      -- "$FACTORY_HOME" "$FACTORY_STAGE_BOOTSTRAP_DECISION_FILE" >"$TEST_ROOT/human-note" || return
    cp "$_r2_context_file" "$TEST_ROOT/bootstrap-context.json"
  fi
  file=$(run_state_active_file "$task" "$stage") || return
  previous=$(_run_state_get "$file" EPOCH 2>/dev/null || true)
  [[ ! "$previous" =~ ^[0-9]+$ ]] || epoch=$((previous + 1))
  MULTI_LAST_RUN_ID="fixture-$task-$epoch"
  MULTI_LAST_RUN_EPOCH=$epoch
  printf '%s\n' "$MULTI_LAST_RUN_ID" >>"$TEST_ROOT/calls"
  run_state_begin "$task" "$stage" "$MULTI_LAST_RUN_ID" "$epoch" "$token" || return
  if [[ "$outcome" == wrong-identity ]]; then
    MULTI_LAST_RUN_ID=foreign-run
    outcome=done
  fi
  if [[ "$outcome" == guard-no-result || "$outcome" == guard-done ]]; then
    printf 'изменение агента\n' >>"$workspace/source.txt"
    [[ "$outcome" == guard-no-result ]] || outcome=done
  fi
  if [[ "$outcome" == no-result || "$outcome" == guard-no-result ]]; then
    return 0
  fi
  if [[ "$outcome" == failed ]]; then
    FACTORY_STATUS_FD=7 bash "$FACTORY_HOME/lib/stage-result.sh" \
      --task "$task" --stage "$stage" --run-id "fixture-$task-$epoch" --epoch "$epoch" \
      --failure-owner human --finding 'owner-choice=Какой вариант выбрать?' \
      failed 'Нужен выбор владельца' 7<<<"$token"
    return $?
  fi
  if [[ "$outcome" == skipped ]]; then
    FACTORY_STATUS_FD=7 bash "$FACTORY_HOME/lib/stage-result.sh" \
      --task "$task" --stage "$stage" --run-id "fixture-$task-$epoch" --epoch "$epoch" \
      skipped 'Доступ отсутствует' 7<<<"$token"
    return $?
  fi
  FACTORY_STATUS_FD=7 bash "$FACTORY_HOME/lib/stage-result.sh" \
    --task "$task" --stage "$stage" --run-id "$MULTI_LAST_RUN_ID" --epoch "$epoch" \
    --finding-deferred 'external-check=Проверить в отдельной среде' \
    done 'Разведка завершена' 7<<<"$token"
}

task=9081
attempt=$(attempt_state_begin_v2 "$task" "$profile" "$routes")
attempt_state_select_route_v2 "$task" "$attempt" debug >/dev/null
bootstrap=$(route_v2_dispatch_bootstrap "$task" "$attempt")
rc=$?
assert_rc 0 "$rc" "bootstrap принимает done с отложенной находкой"
if (( rc == 0 )); then
  assert_eq 2 "$(jq -r .schema <<<"$bootstrap")" "checkpoint хранит новую версию"
  assert_eq external-check "$(jq -r .verdict.findings[0].id <<<"$bootstrap")" \
    "checkpoint сохраняет принятый вердикт"
  attempt_stage_state_init_v2 "$task" "$attempt" debug >/dev/null
  findings=$(attempt_stage_state_findings_v2 "$task" "$attempt")
  assert_rc 0 "$?" "findings reader проверяет оба источника"
  assert_eq 2 "$(jq -r .schema <<<"$findings")" "bootstrap provenance имеет свою schema"
  assert_eq external-check "$(jq -r .deferred[0].id <<<"$findings")" "находка не потеряна"
  assert_eq bootstrap "$(jq -r .deferred[0].source.phase <<<"$findings")" "источник отличим от main"
  assert_eq null "$(jq -r .deferred[0].openedSequence <<<"$findings")" "sequence основного ledger не выдуман"
  checkpoint=$(attempt_state_v2_task_root "$task")/attempts/$attempt/artifacts/bootstrap.json
  before=$(sha256sum "$checkpoint")
  route_v2_dispatch_bootstrap "$task" "$attempt" >/dev/null
  assert_rc 0 "$?" "повтор читает sealed checkpoint"
  assert_eq "$before" "$(sha256sum "$checkpoint")" "повтор не переписывает свидетельство"
  assert_eq 1 "$(wc -l <"$TEST_ROOT/calls" | tr -d ' ')" "повтор не запускает модель"

  source "$FACTORY_HOME/lib/findings-export.sh"
  exported=$(attempt_findings_export_v2 "$task" "$attempt" "$profile" json)
  assert_rc 0 "$?" "полный exporter читает оба immutable источника"
  assert_eq "$attempt" "$(jq -r .attemptId <<<"$exported")" "экспорт несёт exact attempt"
  assert_eq external-check "$(jq -r .findings.deferred[0].id <<<"$exported")" "экспорт содержит находку"
  target="$STATE_DIR/t${task}.deferred.md"
  count=$(attempt_findings_export_v2 "$task" "$attempt" "$profile" write "$target")
  assert_rc 0 "$?" "отдельный поток JSON создаёт Markdown"
  assert_eq 1 "$count" "writer сообщает число находок"
  assert_contains "$(cat "$target")" 'Проверить в отдельной среде' "UTF-8 замечание не теряется"
  attempt_findings_export_v2 "$task" "$attempt" wrong-profile json >/dev/null 2>&1
  assert_rc 75 "$?" "экспорт другого profile отклонён"

  # Инъекция crash между checkpoint и completed: authority уже опубликована.
  # Повтор восстанавливает только производное завершение визита, без новой модели.
  attempt_dir=$(dirname "$(dirname "$checkpoint")")
  completed_file=$(find "$attempt_dir/bootstrap-results" -name 'event.00000000000000000002.*.json')
  rm -- "$completed_file"
  route_v2_dispatch_bootstrap "$task" "$attempt" >/dev/null
  assert_rc 0 "$?" "crash после checkpoint восстанавливает completed"
  assert_eq "$before" "$(sha256sum "$checkpoint")" "восстановление не меняет sealed checkpoint"
  assert_eq 1 "$(wc -l <"$TEST_ROOT/calls" | tr -d ' ')" "crash после checkpoint не запускает модель"

  # Закрытие попытки удаляет active pointer; историческое чтение всё равно разрешено.
  # Экспорт после terminal не создаёт новый run и не возрождает основной cursor.
  attempt_state_abandon_v2 "$task" "$attempt" 'изолированная проверка' >/dev/null
  assert_rc 0 "$?" "попытка штатно закрыта"
  exported=$(attempt_findings_export_v2 "$task" "$attempt" "$profile" json)
  assert_rc 0 "$?" "exporter читает terminal attempt"
  assert_eq external-check "$(jq -r .findings.deferred[0].id <<<"$exported")" "terminal не скрывает замечание"
  cli_export=$("$FACTORY_HOME/bin/factory" "$task" findings-export --profile "$profile" \
    --attempt "$attempt" --routes-dir "$routes" --state-dir "$STATE_DIR" \
    --control-dir "$(factory_control_root)" --format json)
  assert_rc 0 "$?" "короткий CLI после terminal работает без profile.sh и модели"
  assert_eq external-check "$(jq -r .findings.deferred[0].id <<<"$cli_export")" "CLI и writer читают один источник"
  assert_eq 1 "$(wc -l <"$TEST_ROOT/calls" | tr -d ' ')" "экспорт после terminal не запускает модель"
fi

run_state_verdict_encode done build 'blocking-check=Блокирующая находка' >/dev/null 2>&1
assert_rc 2 "$?" "общий валидатор сохраняет запрет blocking при done"
# Фикстуры сохранены до правки CLI: done не получает failureOwner:null,
# а schema 1 не переписывается в новый checkpoint и не требует нового запуска.
legacy_task=9082
ATTEMPT_STATE_ID_OVERRIDE=a_90829082908290829082908290829082
legacy_attempt=$(attempt_state_begin_v2 "$legacy_task" "$profile" "$routes")
unset ATTEMPT_STATE_ID_OVERRIDE
attempt_state_select_route_v2 "$legacy_task" "$legacy_attempt" debug >/dev/null
legacy_dir=$(attempt_state_v2_task_root "$legacy_task")/attempts/$legacy_attempt
cp "$FACTORY_TESTS_HOME/fixtures/bootstrap-legacy-checkpoint.json" "$legacy_dir/artifacts/bootstrap.json"
chmod 400 "$legacy_dir/artifacts/bootstrap.json"
legacy_before=$(sha256sum "$legacy_dir/artifacts/bootstrap.json")
route_v2_dispatch_bootstrap "$legacy_task" "$legacy_attempt" >/dev/null
assert_rc 0 "$?" "historical schema 1 checkpoint остаётся допустимым"
assert_eq "$legacy_before" "$(sha256sum "$legacy_dir/artifacts/bootstrap.json")" "старые байты checkpoint не меняются"
"$FACTORY_HOME/bin/factory-route" --routes-dir "$routes" --profile "$profile" transition-bootstrap \
  --catalog-hash "$(jq -r .catalogHash <<<"$published")" --node scout --outcome done >"$TEST_ROOT/done-transition"
cmp -s "$TEST_ROOT/done-transition" "$FACTORY_TESTS_HOME/fixtures/bootstrap-legacy-transition.json"
assert_rc 0 "$?" "успешный envelope сохраняет historical байты"
: >"$STATE_DIR/stale.deferred.md"
source "$FACTORY_HOME/lib/findings-export.sh"
attempt_findings_export_v2 "$legacy_task" "$legacy_attempt" "$profile" write \
  "$STATE_DIR/stale.deferred.md" >/dev/null
assert_rc 9 "$?" "пустой проверенный хвост отличается от ошибки"
assert_file_missing "$STATE_DIR/stale.deferred.md" "пустой хвост удаляет устаревшую проекцию"
attempt_findings_export_v2 "$task" "$attempt" "$profile" write \
  "$STATE_DIR/missing-parent/tail.md" >/dev/null 2>&1
assert_rc 1 "$?" "ошибка записи не выдаётся за пустой хвост"


# Допустимый вопрос появляется до cursor и повторно читается без новой модели.
# Ответ адресует stop hash, а отдельный следующий визит потребляет его полностью.
human_task=9083
human_attempt=$(attempt_state_begin_v2 "$human_task" "$profile" "$routes")
attempt_state_select_route_v2 "$human_task" "$human_attempt" debug >/dev/null
FIXTURE_OUTCOME=failed
human_stop=$(route_v2_dispatch_bootstrap "$human_task" "$human_attempt")
assert_rc 22 "$?" "typed failed с owner human создаёт штатную bootstrap паузу"
assert_eq human "$(jq -r .verdict.owner <<<"$human_stop")" "вопрос сохраняет typed owner"
human_dir=$(attempt_state_v2_task_root "$human_task")/attempts/$human_attempt
assert_file_missing "$human_dir/stage-results/runtime.json" "вопрос не создаёт основной cursor"
assert_file_missing "$human_dir/artifacts/bootstrap.json" "human stop не становится успешным checkpoint"
calls_before=$(wc -l <"$TEST_ROOT/calls")
held=$(route_v2_dispatch_bootstrap "$human_task" "$human_attempt")
assert_rc 22 "$?" "повтор без ответа возвращает ту же паузу"
assert_eq "$calls_before" "$(wc -l <"$TEST_ROOT/calls")" "повтор без решения не запускает SCOUT"
visit=$(jq -r .visitId <<<"$human_stop")
stop_hash=$(jq -r .recordHash <<<"$human_stop")
# jq добавляет newline, которого нет в authority: сохраняем точную причину файлом.
# Повторная запись должна вернуть исходный hash, а не расширить цепочку.
jq -j .reason <<<"$human_stop" >"$TEST_ROOT/reason"
jq .runs <<<"$human_stop" >"$TEST_ROOT/runs"
stop_verdict=$(jq -c .verdict <<<"$human_stop" | base64 -w0)
repeated_stop=$(attempt_bootstrap_journal_v2 stop "$human_task" "$human_attempt" "$profile" \
  "$visit" failed "$TEST_ROOT/reason" "$stop_verdict" "$TEST_ROOT/runs")
assert_rc 0 "$?" "повторная публикация stop идемпотентна"
assert_eq "$stop_hash" "$(jq -r .recordHash <<<"$repeated_stop")" "повтор stop сохраняет hash"
python3 - "$TEST_ROOT/answer" <<'ANSWER'
import sys
from pathlib import Path
Path(sys.argv[1]).write_text('Выбери первый вариант.\nПолный ответ второй строкой.\t' + '🚀' * 19000)
ANSWER
answer_lock_dir="$(factory_control_root)/protocol-v2/orchestrators"
mkdir -p "$answer_lock_dir"
exec {held_lock}>"$answer_lock_dir/t${human_task}.lock"
flock -n "$held_lock"
attempt_bootstrap_answer_v2 "$human_task" "$human_attempt" "$profile" \
  "$visit" "$stop_hash" "$TEST_ROOT/answer" >/dev/null 2>&1
assert_rc 73 "$?" "живой оркестратор удерживает ответ до CAS"
eval "exec ${held_lock}>&-"
answer=$("$FACTORY_HOME/bin/factory" "$human_task" bootstrap-answer --profile "$profile" \
  --attempt "$human_attempt" --node scout --visit "$visit" --stop-hash "$stop_hash" \
  --answer-file "$TEST_ROOT/answer" --routes-dir "$routes" --state-dir "$STATE_DIR" \
  --control-dir "$(factory_control_root)")
assert_rc 0 "$?" "короткий CLI фиксирует ответ без профиля и подготовки среды"
assert_eq decision "$(jq -r .kind <<<"$answer")" "ответ долговечно связан с вопросом"
repeated=$(attempt_bootstrap_answer_v2 "$human_task" "$human_attempt" "$profile" \
  "$visit" "$stop_hash" "$TEST_ROOT/answer")
assert_rc 0 "$?" "повтор того же ответа идемпотентен"
assert_eq "$(jq -r .recordHash <<<"$answer")" "$(jq -r .recordHash <<<"$repeated")" "идемпотентный CAS не создаёт событие"
printf 'Другое решение' >"$TEST_ROOT/conflict-answer"
attempt_bootstrap_answer_v2 "$human_task" "$human_attempt" "$profile" \
  "$visit" "$stop_hash" "$TEST_ROOT/conflict-answer" >/dev/null 2>&1
assert_rc 75 "$?" "иной ответ на уже решённый визит отклонён"
printf ' ' >"$TEST_ROOT/empty-answer"
attempt_bootstrap_answer_v2 "$human_task" "$human_attempt" "$profile" \
  "$visit" "$stop_hash" "$TEST_ROOT/empty-answer" >/dev/null 2>&1
assert_rc 75 "$?" "пустой ответ отклонён до запуска"
assert_eq "$calls_before" "$(wc -l <"$TEST_ROOT/calls")" "запись ответа не запускает модель"
attempt_bootstrap_answer_v2 "$human_task" "$human_attempt" "$profile" \
  "b_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "$stop_hash" "$TEST_ROOT/answer" >/dev/null 2>&1
assert_rc 75 "$?" "чужой visitId отвергнут"
FIXTURE_OUTCOME=done
route_v2_dispatch_bootstrap "$human_task" "$human_attempt" >/dev/null
assert_rc 0 "$?" "отдельное продолжение после ответа получает новый успешный run"
assert_contains "$(cat "$TEST_ROOT/human-note")" 'Полный ответ второй строкой.' "ответ целиком включён в служебный блок"
assert_eq "$(cat "$TEST_ROOT/answer")" \
  "$(jq -r .evidence.bootstrapDecision.decision.answer "$TEST_ROOT/bootstrap-context.json")" \
  "Unicode-ответ предельной длины проходит файлом без обрезки"
assert_eq "$visit" "$(jq -r .evidence.bootstrapDecision.question.visitId "$TEST_ROOT/bootstrap-context.json")" \
  "typed context адресует вопрос предыдущего визита"
journal=$(attempt_bootstrap_journal_v2 read "$human_task" "$human_attempt" "$profile")
assert_eq completed "$(jq -r .state <<<"$journal")" "визит завершён ссылкой на successful checkpoint"
assert_eq "$(jq -r .recordHash <<<"$answer")" \
  "$(jq -r .decision.recordHash <<<"$journal")" "продолжение не потеряло принятое решение"
completed_visit=$(jq -r .visit.visitId <<<"$journal")
repeated_completed=$(attempt_bootstrap_journal_v2 completed \
  "$human_task" "$human_attempt" "$profile" "$completed_visit")
assert_rc 0 "$?" "повторная публикация completed идемпотентна"
assert_eq "$(jq -r .visit.recordHash <<<"$journal")" "$(jq -r .recordHash <<<"$repeated_completed")" \
  "повтор completed сохраняет hash"

# Host exhaustion хранит все реальные исполнения, а guard проверяется и при молчании.
# Нарушение workspace остаётся policy failure; его нельзя выдавать за вопрос человека.
for mode in skipped no-result wrong-identity guard-done guard-no-result; do
  case "$mode" in
    skipped) case_task=9084; expected_rc=22 ;;
    no-result) case_task=9085; expected_rc=22 ;;
    wrong-identity) case_task=9086; expected_rc=78 ;;
    guard-done) case_task=9087; expected_rc=75 ;;
    guard-no-result) case_task=9088; expected_rc=75 ;;
  esac
  case_attempt=$(attempt_state_begin_v2 "$case_task" "$profile" "$routes")
  attempt_state_select_route_v2 "$case_task" "$case_attempt" debug >/dev/null
  FIXTURE_OUTCOME=$mode
  case_stop=$(route_v2_dispatch_bootstrap "$case_task" "$case_attempt")
  assert_rc "$expected_rc" "$?" "bootstrap исход $mode соблюдает свой контракт"
  case_dir=$(attempt_state_v2_task_root "$case_task")/attempts/$case_attempt
  assert_file_missing "$case_dir/artifacts/bootstrap.json" "$mode не публикует successful checkpoint"
  if [[ "$mode" == no-result ]]; then
    assert_eq exhausted "$(jq -r .outcome <<<"$case_stop")" "бюджет создаёт host exhausted"
    assert_eq 3 "$(jq -r '.runs | length' <<<"$case_stop")" "сохранены все исполнения исчерпанного бюджета"
    assert_eq null "$(jq -r .runs[2].result <<<"$case_stop")" "молчавший run не объявлен committed"
  fi
  if [[ "$mode" == guard-* ]]; then
    journal=$(attempt_bootstrap_journal_v2 read "$case_task" "$case_attempt" "$profile")
    assert_eq null "$(jq -r .stop <<<"$journal")" "policy failure не создаёт human record"
    git -C "$workspace" restore source.txt
  fi
done
finish_tests
