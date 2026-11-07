#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/run-state.sh"

# Предпроверка сдачи: хостовый evidence-хук отвечает после раннера, когда исправлять
# сдачу уже некому (t8702: manifest тестов с файлом, который VERIFY не исполняет, —
# узел встал, причину человек носил агенту сам). Та же проверка в руках агента должна
# отвечать ДО записи результата и не записывать его при отказе.

result_cmd="$FACTORY_HOME/lib/stage-result.sh"
task=61
stage=TESTS
token=result-secret
pipeline_store_route_init "$task" "TESTS TCRITIC" PROFILE fixture ROUTE feature
assert_rc 0 "$?" "fixture initializes an exact pinned route registry"
factory_control_init control-secret
run_state_begin "$task" "$stage" run-a 1 "$token"
token_file="$TEST_ROOT/token"
printf '%s\n' "$token" >"$token_file"
exec 7<"$token_file"

reject_check="$TEST_ROOT/reject-check.sh"
cat >"$reject_check" <<'EOF'
#!/usr/bin/env bash
printf 'args=%s|%s|%s\n' "$1" "$2" "$3" >>"${CHECK_CALLS:?}"
echo 'feature-verify check: manifest нельзя полностью выполнить: frontend:tests/unit/x.test.mjs' >&2
exit 65
EOF
accept_check="$TEST_ROOT/accept-check.sh"
cat >"$accept_check" <<'EOF'
#!/usr/bin/env bash
printf 'args=%s|%s|%s\n' "$1" "$2" "$3" >>"${CHECK_CALLS:?}"
echo 'feature tests manifest: ок, files=3'
exit 0
EOF
chmod +x "$reject_check" "$accept_check"
export CHECK_CALLS="$TEST_ROOT/check-calls.log"
: >"$CHECK_CALLS"

# --- отказ предпроверки: причина в выводе, результат не записан ---
output=$(FACTORY_STATUS_FD=7 FACTORY_STAGE_RESULT_CHECK="$reject_check" \
  bash "$result_cmd" --task "$task" --stage "$stage" --run-id run-a --epoch 1 done 'всё готово' 2>&1)
assert_rc 65 "$?" "rejected precheck fails stage-result with a data error"
assert_contains "$output" 'отклонена предпроверкой профиля' "agent is told the submission was refused"
assert_contains "$output" 'frontend:tests/unit/x.test.mjs' "the profile reason reaches the agent verbatim"
assert_contains "$output" 'результат НЕ записан' "agent is told nothing was recorded"
assert_eq "args=$task|$stage|done" "$(cat "$CHECK_CALLS")" \
  "precheck receives task, stage and the submitted result"
assert_eq running "$(pipeline_store_get "$task" "$stage")" "rejected submission leaves the node running"

# --- failed сдачу предпроверка не трогает: отказ агента доказательств не требует ---
: >"$CHECK_CALLS"
FACTORY_STATUS_FD=7 FACTORY_STAGE_RESULT_CHECK="$reject_check" \
  bash "$result_cmd" --task "$task" --stage "$stage" --run-id run-a --epoch 1 \
  failed 'не смог' >/dev/null 2>&1
failed_rc=$?
assert_eq "" "$(cat "$CHECK_CALLS")" "failed result skips the precheck entirely"
# Отказ записан штатно: тот же запуск дальше уже терминален, поэтому для следующих
# проверок открывается новая эпоха того же этапа.
assert_rc 0 "$failed_rc" "failed result is recorded without consulting the precheck"
assert_eq failed "$(pipeline_store_get "$task" "$stage")" "failed submission reaches the registry"

# --- недоступный файл предпроверки не блокирует сдачу: доверенная проверка впереди ---
run_state_begin "$task" "$stage" run-b 2 "$token"
output=$(FACTORY_STATUS_FD=7 FACTORY_STAGE_RESULT_CHECK="$TEST_ROOT/missing-check.sh" \
  bash "$result_cmd" --task "$task" --stage "$stage" --run-id run-b --epoch 2 done 'готово' 2>&1)
assert_rc 0 "$?" "missing precheck file does not block the submission"
assert_contains "$output" 'предпроверка профиля недоступна' "missing precheck is named, not silent"
assert_eq done "$(pipeline_store_get "$task" "$stage")" "submission without precheck is recorded"

# --- принятая предпроверка: результат записан, вывод проверки не мешает ---
: >"$CHECK_CALLS"
run_state_begin "$task" "$stage" run-c 3 "$token"
FACTORY_STATUS_FD=7 FACTORY_STAGE_RESULT_CHECK="$accept_check" \
  bash "$result_cmd" --task "$task" --stage "$stage" --run-id run-c --epoch 3 done 'готово' >/dev/null 2>&1
assert_rc 0 "$?" "accepted precheck lets the submission through"
assert_eq "args=$task|$stage|done" "$(cat "$CHECK_CALLS")" "accepted precheck was consulted"
assert_eq done "$(pipeline_store_get "$task" "$stage")" "accepted submission reaches the registry"

# --- без переменной поведение прежнее ---
run_state_begin "$task" "$stage" run-d 4 "$token"
FACTORY_STATUS_FD=7 FACTORY_STAGE_RESULT_CHECK= \
  bash "$result_cmd" --task "$task" --stage "$stage" --run-id run-d --epoch 4 done 'готово' >/dev/null 2>&1
assert_rc 0 "$?" "empty precheck variable keeps the legacy path"
exec 7<&-

# Противоречивый отказ нельзя превратить в зелёную сдачу по составу findings.
# Агент получает причину и может честно назвать недоступный обязательный критерий.
exec 7<"$token_file"
run_state_begin "$task" "$stage" run-e 5 "$token"
output=$(FACTORY_STATUS_FD=7 bash "$result_cmd" \
  --task "$task" --stage "$stage" --run-id run-e --epoch 5 \
  --failure-owner environment --finding-deferred 'browser=Обязательная проверка недоступна' \
  failed 'нет браузера' 2>&1)
assert_rc 2 "$?" "failed только с deferred отклонён без автоматического done"
assert_eq running "$(pipeline_store_get "$task" "$stage")" \
  "противоречивая сдача не записывает успешный результат"
FACTORY_STATUS_FD=7 bash "$result_cmd" \
  --task "$task" --stage "$stage" --run-id run-e --epoch 5 \
  --failure-owner environment --finding 'browser=Обязательная проверка недоступна' \
  failed 'нет браузера' >/dev/null 2>&1
assert_rc 0 "$?" "обязательная недоступная проверка сдаётся штатным failed/environment"
assert_eq failed "$(pipeline_store_get "$task" "$stage")" "критерий не выдаётся за выполненный"
exec 7<&-

source "$FACTORY_HOME/lib/route-runtime.sh"
command_result="$TEST_ROOT/command-result.json"
printf '%s\n' '{"schema":1,"outcome":"failed","comment":"Нет проверки",' \
  '"failureOwner":"environment","findings":[{"id":"browser","summary":"Нет браузера",' \
  '"severity":"deferred"}]}' >"$command_result"
_route_v2_command_result "$command_result" >/dev/null 2>&1
assert_rc 78 "$?" "доверенная команда тоже не повышает failed с deferred до done"

# --- путь предпроверки назначает движок из хука профиля, а не сам агент ---
export FACTORY_RUNNERS_DIR="$FACTORY_TESTS_HOME/fakes/runners"
export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
mkdir -p "$FACTORY_PROFILES_DIR/fixture" "$TEST_ROOT/work"
printf '%s\n' \
  'RUNNERS_SCHEMA=1' \
  'CONFIG_REVISION=1' \
  'PROJECT_RUNNER_PRIMARY=alpha' \
  'PROJECT_RUNNER_FAILOVER=beta' \
  'MODEL_TESTS_ALPHA_FAMILY=fixture' \
  'MODEL_TESTS_ALPHA_VERSION=latest' \
  'MODEL_TESTS_ALPHA_EFFORT=high' >"$FACTORY_PROFILES_DIR/fixture/runners.env"
PROFILE_NAME=fixture
PROFILE_CTX=fixture
PROFILE_AGENT_CWD="$TEST_ROOT/work"
source "$FACTORY_HOME/lib/core.sh"

multi_runner_run() {
  printf '%s' "${FACTORY_STAGE_RESULT_CHECK-нет}" >"$TEST_ROOT/seen-check"
  printf '%s' "$2" >"$TEST_ROOT/prompt"
  return 0
}

FACTORY_ROUTE_TIMEOUT_CLASS=test run_agent 41 'напиши тесты' TESTS >/dev/null 2>&1
assert_eq "" "$(cat "$TEST_ROOT/seen-check")" "without a profile hook the agent gets no precheck"

profile_stage_result_check() {
  [[ "$2" == TESTS ]] && printf '%s\n' "$accept_check"
  return 0
}
FACTORY_ROUTE_TIMEOUT_CLASS=test run_agent 41 'напиши тесты' TESTS >/dev/null 2>&1
assert_eq "$accept_check" "$(cat "$TEST_ROOT/seen-check")" \
  "profile hook resolves the precheck path for the stage it names"
FACTORY_ROUTE_TIMEOUT_CLASS=build run_agent 41 'собери' BUILD >/dev/null 2>&1
assert_eq "" "$(cat "$TEST_ROOT/seen-check")" "stages the hook does not name get no precheck"

profile_stage_result_check() { printf '%s\n' "$TEST_ROOT/not-executable.sh"; }
printf '#!/usr/bin/env bash\nexit 1\n' >"$TEST_ROOT/not-executable.sh"
FACTORY_ROUTE_TIMEOUT_CLASS=test run_agent 41 'напиши тесты' TESTS >/dev/null 2>&1
assert_eq "" "$(cat "$TEST_ROOT/seen-check")" "a non-executable hook answer is dropped on the host"

# --- повтор после отказа сторожа цитирует причину агенту ---
reason='feature-verify snapshot: manifest нельзя полностью выполнить: frontend:tests/unit/x.test.mjs'
FACTORY_ROUTE_TIMEOUT_CLASS=test FACTORY_STAGE_RETRY=2 \
  FACTORY_STAGE_RETRY_REASON=evidence-rejected FACTORY_STAGE_RETRY_NOTE="$reason" \
  run_agent 41 'напиши тесты' TESTS >/dev/null 2>&1
prompt=$(cat "$TEST_ROOT/prompt")
assert_contains "$prompt" 'Это повтор этапа (заход 2)' "evidence retry is announced as a retry"
assert_contains "$prompt" 'хост-сторож эту сдачу отверг' "retry names the host guard as the reason"
assert_contains "$prompt" "**Причина отказа сторожа:** $reason" "guard reason is quoted verbatim"
assert_contains "$prompt" 'сдай снова через `stage-result`' "retry is told to fix the submission, not redo the work"

FACTORY_ROUTE_TIMEOUT_CLASS=test FACTORY_STAGE_RETRY=2 \
  FACTORY_STAGE_RETRY_REASON=evidence-rejected FACTORY_STAGE_RETRY_NOTE= \
  run_agent 41 'напиши тесты' TESTS >/dev/null 2>&1
prompt=$(cat "$TEST_ROOT/prompt")
assert_contains "$prompt" 'сторож причину не назвал' "missing guard reason is stated, not invented"

FACTORY_ROUTE_TIMEOUT_CLASS=test FACTORY_STAGE_RETRY=2 \
  FACTORY_STAGE_RETRY_REASON=failed FACTORY_STAGE_RETRY_NOTE="$reason" \
  run_agent 41 'напиши тесты' TESTS >/dev/null 2>&1
prompt=$(cat "$TEST_ROOT/prompt")
case "$prompt" in
  *'Причина отказа сторожа'*) test_fail "product retry does not borrow the guard block" "guard block found" ;;
  *) test_ok "product retry does not borrow the guard block" ;;
esac

finish_tests
