#!/usr/bin/env bash
# Запуск этапа GLM: argv host-wrapper-а, private prompt, отказы до запуска и разбор
# retained-потока. Модель и ключи не участвуют; wrapper перехватывается на factory_exec.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

runner="$FACTORY_HOME/lib/runners/glm.sh"
if [[ ! -f "$runner" ]]; then
  test_fail "GLM launch contract has a runner" "missing $runner"
  finish_tests
  exit $?
fi
source "$runner"

package_a=$(printf 'a%.0s' {1..64})
package_b=$(printf 'b%.0s' {1..64})
mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/run" "$TEST_ROOT/additional" "$TEST_ROOT/project"
fake_bin="$TEST_ROOT/bin/dsh glm"
printf '#!/usr/bin/env bash\nexec "%s" "%s" "$@"\n' \
  "$NODE_BIN" "$FACTORY_HOME/../tests/fixtures/deepseek-harness/fakeGlmBinary.mts" >"$fake_bin"
chmod +x "$fake_bin"
export GRIGDESK_DEEPSEEK_BIN="$fake_bin"
export GRIGDESK_DEEPSEEK_CACHE_DIR="$TEST_ROOT/dsh cache"
export GRIGDESK_GLM_API_MODE=api
export ZAI_API_KEY=synthetic-glm-factory-key
export ZAI_CODING_API_KEY=synthetic-coding-plan-key
export FACTORY_FORBID_LIVE=0
cd "$TEST_ROOT/project" || exit 1

capture="$TEST_ROOT/argv"
info_calls="$TEST_ROOT/info-calls"
: >"$capture"
: >"$info_calls"
factory_exec() {
  # Metadata исполняется настоящим helper-ом на synthetic ELF; захват относится к wrapper.
  if [[ "$1" == local ]] \
    || [[ "$1" == provider && "${3:-}" == "$FACTORY_HOME/../server/scripts/glmRuntimeInfo.mts" ]]; then
    [[ "$1" == local ]] || printf 'info\n' >>"$info_calls"
    shift
    "$@"
    return
  fi
  : >"$capture"
  printf '%s\n' "$@" >"$capture"
}

argv_value() {
  awk -v wanted="$1" 'previous == wanted { print; exit } { previous=$0 }' "$capture"
}

model='["zai","glm-5.3"]'
prompt='PROMPT_CANARY must travel only through a private file'
export FACTORY_ROUTE_FILESYSTEM_POLICY=state-only
runner_glm_run 42 "$prompt" CHECK "$model" high 17 "$TEST_ROOT/run"
assert_rc 0 "$?" "state-only запуск доходит до wrapper"
mapfile -t argv <"$capture"
argv+=('' '' '' '' '' '' '')
assert_eq provider "${argv[0]}" "wrapper классифицирован как запуск провайдера"
assert_eq timeout "${argv[1]}" "провайдер ограничен GNU timeout"
assert_eq -k "${argv[2]}" "timeout имеет явный срок KILL"
assert_eq 30 "${argv[3]}" "срок KILL после TERM — тридцать секунд"
assert_eq 17 "${argv[4]}" "срок маршрута сохранён"
assert_eq "$NODE_BIN" "${argv[5]}" "wrapper запускает host Node поставки DSH"
assert_eq "$FACTORY_HOME/../server/scripts/glmRunner.mts" "${argv[6]}" \
  "раннер вызывает отдельный wrapper GLM, не DeepSeek"
assert_eq state-only "$(argv_value --mode)" "wrapper получает файловую политику state-only"
assert_eq "$fake_bin" "$(argv_value --bin)" "wrapper получает тот же ELF, что прошёл descriptor"
assert_eq "$model" "$(argv_value --model)" "непрозрачный id модели передаётся как есть"
assert_eq high "$(argv_value --effort)" "уровень передаётся wrapper-у"
assert_eq "deepseek-package:$package_a" "$(argv_value --runtime-identity)" \
  "wrapper сверяет identity поставки из preflight"
assert_eq '9.2.0.grigdesk.bbbbbbbbbbbbbbbbb' "$(argv_value --runtime-version)" \
  "wrapper сверяет runtimeVersion из preflight"
assert_eq "$TEST_ROOT/dsh cache" "$(argv_value --cache-dir)" "кэш DSH с пробелом передаётся целым"
assert_eq "$(realpath "$STATE_DIR")" "$(argv_value --cwd)" \
  "cwd и writable root проверяющего узла — STATE_DIR"
assert_eq "$TEST_ROOT/run/glm/runtime" "$(argv_value --runtime-home)" \
  "home этапа живёт в RUN_DIR, не в доме чата"
for secret in "$prompt" synthetic-glm-factory-key synthetic-coding-plan-key; do
  if grep -Fq "$secret" "$capture"; then
    test_fail "argv не содержит prompt и ключи ($secret)" "leaked into $capture"
  else
    test_ok "argv не содержит prompt и ключи ($secret)"
  fi
done
prompt_file=$(argv_value --prompt-file)
assert_file_exists "$prompt_file" "private prompt существует до запуска wrapper"
assert_eq "$prompt" "$(cat "$prompt_file")" "prompt-файл сохраняет байты"
assert_eq 600 "$(stat -c '%a' "$prompt_file")" "prompt-файл приватный"
assert_eq 700 "$(stat -c '%a' "$TEST_ROOT/run/glm")" "каталог prompt приватный"

export FACTORY_ROUTE_FILESYSTEM_POLICY=workspace-write
runner_glm_run 42 write BUILD '["zai","glm-5.2"]' off 19 "$TEST_ROOT/run"
assert_rc 0 "$?" "workspace-write запуск доходит до wrapper"
assert_eq workspace-write "$(argv_value --mode)" "workspace-write сохраняет запись в проект"
assert_eq "$TEST_ROOT/project" "$(argv_value --cwd)" "workspace-write сохраняет cwd проекта"
assert_eq off "$(argv_value --effort)" "уровень off допустим только у модели с ним"
runner_glm_run 42 write BUILD '["zai","glm-4.7"]' '' 19 "$TEST_ROOT/run"
assert_rc 0 "$?" "пустой уровень оставляет выбор штатному high wrapper-а"
assert_eq '' "$(argv_value --effort)" "пустой уровень не передаётся аргументом"

reject_before_wrapper() {
  local name=$1 model=$2 effort=$3
  : >"$capture"
  runner_glm_run 42 reject CHECK "$model" "$effort" 5 "$TEST_ROOT/run" >/dev/null 2>&1
  assert_rc 4 "$?" "$name: отказ до prompt"
  assert_eq '' "$(cat "$capture")" "$name: wrapper не запускается"
}

export FACTORY_ROUTE_FILESYSTEM_POLICY=state-only
for invalid_state in '' relative "$TEST_ROOT/no-state" "$capture"; do
  STATE_DIR="$invalid_state" reject_before_wrapper "неверный STATE_DIR '$invalid_state'" "$model" high
done

for unsupported in transactional-write ''; do
  export FACTORY_ROUTE_FILESYSTEM_POLICY="$unsupported"
  reject_before_wrapper "режим ФС '$unsupported'" "$model" high
done
export FACTORY_ROUTE_FILESYSTEM_POLICY=workspace-write
reject_before_wrapper "модель DeepSeek" '["deepseek-official","deepseek-v4-flash"]' high
reject_before_wrapper "неизвестная модель zai" '["zai","not-real"]' high
reject_before_wrapper "уровень вне списка модели" '["zai","glm-4.7"]' max
reject_before_wrapper "неизвестный уровень" "$model" impossible
: >"$info_calls"
: >"$capture"
# Coding Plan допущен с factory-policy-v2 (29.10.2026): шлюз режима проходится, этап
# упирается в сверку поставки — старая версия раннера ловится тем же runtime_changed.
GRIGDESK_GLM_API_MODE=coding-plan FACTORY_RUNNER_VERSION=old-runner-version \
  runner_glm_run 42 reject CHECK "$model" high 5 "$TEST_ROOT/run" \
  2>"$TEST_ROOT/coding-plan.err"
assert_rc 4 "$?" "Coding Plan проходит шлюз режима и ловится на смене поставки"
assert_contains "$(cat "$TEST_ROOT/coding-plan.err")" 'FACTORY_ERROR=runtime_changed RUNNERS=glm' \
  "Coding Plan допущен до сверки версии раннера"
if [[ -n "$(cat "$info_calls")" ]]; then
  test_ok "Coding Plan доходит до metadata helper"
else
  test_fail "Coding Plan доходит до metadata helper" "info-calls пуст"
fi

: >"$capture"
FACTORY_RUNNER_VERSION=old-runner-version runner_glm_run 42 reject CHECK "$model" high 5 \
  "$TEST_ROOT/run" 2>"$TEST_ROOT/changed.err"
assert_rc 4 "$?" "смена версии раннера после preflight отвергается"
assert_contains "$(cat "$TEST_ROOT/changed.err")" 'FACTORY_ERROR=runtime_changed RUNNERS=glm' \
  "смена поставки видна типизированным маркером"
assert_eq '' "$(cat "$capture")" "смена поставки не запускает wrapper"

replaced_bin="$TEST_ROOT/bin/dsh-glm-replaced"
printf '#!/usr/bin/env bash\nexec "%s" "%s" --fixture-package-id "%s" "$@"\n' \
  "$NODE_BIN" "$FACTORY_HOME/../tests/fixtures/deepseek-harness/fakeGlmBinary.mts" "$package_b" \
  >"$replaced_bin"
chmod +x "$replaced_bin"
expected_version=$(runner_glm_probe)
: >"$capture"
GRIGDESK_DEEPSEEK_BIN=$replaced_bin FACTORY_RUNNER_VERSION=$expected_version \
  runner_glm_run 42 reject CHECK "$model" high 5 "$TEST_ROOT/run" 2>/dev/null
assert_rc 4 "$?" "другой ELF под прежней версией покрытия не запускается"
assert_eq '' "$(cat "$capture")" "подменённый ELF не получает prompt"

export RUNNER_GLM_ADD_DIRS="$TEST_ROOT/additional"
runner_glm_run 42 context CHECK "$model" low 5 "$TEST_ROOT/run"
if grep -Fq "$TEST_ROOT/additional" "$capture"; then
  test_fail "дополнительные каталоги не становятся writable root DSH" "path leaked into wrapper argv"
else
  test_ok "дополнительные каталоги не становятся writable root DSH"
fi

# Классификатор: без live-доказанной сигнатуры переключение запрещено.
classify_dir="$TEST_ROOT/classify"
mkdir -p "$classify_dir"
: >"$classify_dir/events.jsonl"
assert_eq ok "$(runner_glm_classify "$classify_dir" 0)" "rc 0 — ok"
assert_eq timeout "$(runner_glm_classify "$classify_dir" 124)" "rc 124 — timeout"
for rc in 1 2 4 126 137 143; do
  assert_eq unknown "$(runner_glm_classify "$classify_dir" "$rc")" "rc $rc без сигнатуры — unknown"
done

# Делегирование считается разбором retained JSON, а не константой.
events="$TEST_ROOT/events"
mkdir -p "$events"
printf '%s\n' '{"event":"glm_start","mode":"read-only","model":"[\"zai\",\"glm-5.3\"]"}' \
  '{"event":"tool_call","name":"bash"}' '{"event":"tool_call","name":"write"}' \
  '{"event":"result","stopReason":"end_turn"}' >"$events/events.jsonl"
assert_eq 0 "$(runner_glm_fanout_count "$events")" "обычные инструменты не считаются делегированием"
printf '%s\n' '{"event":"tool_call","name":"subagent"}' \
  '{"event":"tool_call","name":"tool-workflow"}' >>"$events/events.jsonl"
assert_eq 2 "$(runner_glm_fanout_count "$events")" "делегирующие вызовы считаются по имени события"
printf '%s\n' '{"event":"tool_call","name":"subagent"' >>"$events/events.jsonl"
count=$(runner_glm_fanout_count "$events" 2>/dev/null)
assert_rc 1 "$?" "повреждённый поток не превращается в ноль делегирований"
assert_eq '' "$count" "повреждённый поток не печатает число"
assert_eq 0 "$(runner_glm_fanout_count "$TEST_ROOT/no-such-run")" \
  "отсутствующий поток — наблюдённый ноль, а не отказ"

assert_contains "$(runner_glm_dialect)" 'billing usage unavailable' \
  "диалект честно объявляет отсутствие billing counters"
runner_glm_interrupt
assert_rc 0 "$?" "interrupt оставляет дерево setsid-сессии launcher-у"

# OFFLINE_GUARD ловит glm даже при ложной метке local.
unset -f factory_exec
source "$FACTORY_HOME/lib/executor.sh"
export FACTORY_FORBID_LIVE=1
glm_alias="$TEST_ROOT/bin/glm"
printf '#!/usr/bin/env bash\nexit 0\n' >"$glm_alias"
chmod +x "$glm_alias"
factory_exec local "$glm_alias" >/dev/null 2>&1
assert_rc 126 "$?" "basename glm блокируется даже с меткой local"

finish_tests
