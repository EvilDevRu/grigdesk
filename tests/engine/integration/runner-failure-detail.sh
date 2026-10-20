#!/usr/bin/env bash
# Настоящий launcher запечатывает ошибку из stdout фиктивного Codex через retained FD.
# Внешний CLI и модели не вызываются; классификатор и публикация meta остаются настоящими.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/runners/index.sh"
source "$FACTORY_HOME/lib/runner-launcher.sh"

module="$TEST_ROOT/codex-fixture.sh"
cat >"$module" <<'BASH'
source "$FACTORY_HOME/lib/runners/codex.sh"

runner_codex_run() {
  case "$2" in
    capacity|timeout)
      cat "$FACTORY_TESTS_HOME/fixtures/classifiers/codex-capacity/events.jsonl"
      ;;
    unknown)
      printf '%s\n' '{"type":"turn.failed","error":{"message":"Provider E_NEW"}}'
      ;;
  esac
  [[ "$2" != timeout ]] || return 124
  return 1
}
BASH

runner_registry_add codex "$module"
export FACTORY_RUNNER_VERSION=0.159.2
epoch=0

for scenario in capacity unknown timeout; do
  epoch=$((epoch + 1))
  run_dir="$STATE_DIR/logs/runs/t42/BUILD/run-$scenario"
  runner_launch codex 42 "$scenario" BUILD example-sol high 5 \
    "$run_dir" "run-$scenario" "$epoch" fixture-token >/dev/null 2>&1
  rc=$?
  expected_rc=1
  [[ "$scenario" != timeout ]] || expected_rc=124
  assert_rc "$expected_rc" "$rc" "$scenario сохраняет код процесса"
  assert_file_exists "$run_dir/meta.env" "$scenario публикует metadata"

  case "$scenario" in
    capacity)
      assert_eq transient "$(_run_state_get "$run_dir/meta.env" RESULT_CLASS)" \
        "перегрузка классифицирована временным отказом"
      assert_eq capacity "$(_run_state_get "$run_dir/meta.env" FAILURE_CODE)" \
        "машинная причина сохранена"
      assert_eq 'модель «example-sol» перегружена' "$(_run_state_get "$run_dir/meta.env" FAILURE_DETAIL)" \
        "русское пояснение и actual model сохранены"
      assert_contains "$(_run_state_get "$run_dir/meta.env" FAILURE_MESSAGE)" 'Selected model is at capacity' \
        "оригинальное сообщение сохранено отдельно от класса"
      ;;
    unknown)
      assert_eq unknown "$(_run_state_get "$run_dir/meta.env" RESULT_CLASS)" \
        "новая сигнатура остаётся unknown"
      assert_contains "$(_run_state_get "$run_dir/meta.env" FAILURE_DETAIL)" 'Provider E_NEW' \
        "unknown сохраняет конкретный текст человеку"
      ;;
    timeout)
      assert_eq timeout "$(_run_state_get "$run_dir/meta.env" RESULT_CLASS)" \
        "timeout имеет приоритет над старой ошибкой"
      assert_eq '' "$(_run_state_get "$run_dir/meta.env" FAILURE_DETAIL)" \
        "timeout не получает ошибочное пояснение про перегрузку"
      ;;
  esac
done

# GLM: отказ wrapper-а виден человеку из того же retained-потока, класс остаётся unknown.
glm_module="$TEST_ROOT/glm-fixture.sh"
cat >"$glm_module" <<'BASH'
source "$FACTORY_HOME/lib/runners/glm.sh"

runner_glm_run() {
  printf '%s\n' '{"event":"glm_start","mode":"read-only","model":"[\"zai\",\"glm-5.3\"]"}'
  case "$2" in
    key-missing)
      printf '%s%s\n' '{"event":"wrapper_error","code":"glm_key_missing",' \
        '"message":"GLM: нет ключа Обычного API"}'
      ;;
    hostile-code)
      printf '%s\n' '{"event":"wrapper_error","code":"bad\ncode","message":"GLM: api_key=leaked-value"}'
      ;;
    timeout)
      printf '%s\n' '{"event":"wrapper_error","code":"glm_turn_failed","message":"GLM: прервано"}'
      return 124
      ;;
  esac
  return 1
}
BASH

runner_registry_add glm "$glm_module"
export FACTORY_RUNNER_VERSION=9.2.0-grigdesk.fixture
for scenario in key-missing hostile-code timeout; do
  epoch=$((epoch + 1))
  run_dir="$STATE_DIR/logs/runs/t43/CHECK/run-glm-$scenario"
  runner_launch glm 43 "$scenario" CHECK '["zai","glm-5.3"]' high 5 \
    "$run_dir" "run-glm-$scenario" "$epoch" fixture-token >/dev/null 2>&1
  assert_file_exists "$run_dir/meta.env" "GLM $scenario публикует metadata"
  case "$scenario" in
    key-missing)
      assert_eq unknown "$(_run_state_get "$run_dir/meta.env" RESULT_CLASS)" \
        "отказ wrapper-а GLM не открывает переключение"
      assert_eq glm_key_missing "$(_run_state_get "$run_dir/meta.env" FAILURE_CODE)" \
        "машинная причина GLM сохранена"
      assert_contains "$(_run_state_get "$run_dir/meta.env" FAILURE_DETAIL)" 'нет ключа Обычного API' \
        "пояснение GLM доходит до карточки остановки"
      ;;
    hostile-code)
      assert_eq unknown "$(_run_state_get "$run_dir/meta.env" FAILURE_CODE)" \
        "код с переводом строки не становится полем meta.env"
      if grep -Fq leaked-value "$run_dir/meta.env"; then
        test_fail "секрет из сообщения wrapper-а не попадает в meta.env" "leaked"
      else
        test_ok "секрет из сообщения wrapper-а не попадает в meta.env"
      fi
      ;;
    timeout)
      assert_eq timeout "$(_run_state_get "$run_dir/meta.env" RESULT_CLASS)" \
        "timeout GLM имеет приоритет над ошибкой wrapper-а"
      assert_eq '' "$(_run_state_get "$run_dir/meta.env" FAILURE_DETAIL)" \
        "timeout GLM не получает пояснение ошибки"
      ;;
  esac
done

finish_tests
