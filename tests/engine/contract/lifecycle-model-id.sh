#!/usr/bin/env bash
# Проверяет преобразование modelRef только при записи трёх lifecycle-событий.
# Настоящая строгая схема остаётся последней границей, в том числе для повреждённых ссылок.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/runner-launcher.sh"

raw_model='["zai","glm-5.3"]'
raw_resolved='["zai","glm-5.2"]'
event_file="$TEST_ROOT/event.json"

assert_eq zai/glm-5.3 "$(runtime_lifecycle_model_id_v2 "$raw_model")" \
  "JSON-пара представлена как маршрут/модель"
assert_eq zai/glm-5.3 "$(runtime_lifecycle_model_id_v2 ' [ "zai", "glm-5.3" ] ')" \
  "пробелы JSON не меняют идентификатор модели"

for model in gpt-5.3 opus zai/glm-5.3 '' '[broken' '["zai"]' \
  '["zai","glm-5.3","extra"]' '["zai",53]' '{"route":"zai"}' 'null'; do
  assert_eq "$model" "$(runtime_lifecycle_model_id_v2 "$model")" \
    "обычная строка или неподдерживаемая форма сохраняется: $model"
done

runtime_lifecycle_set_context_v2 42 a_0123456789abcdef0123456789abcdef fixture \
  route "$(printf 'a%.0s' {1..64})" os_11111111111111111111111111111111 >/dev/null
export FACTORY_LIFECYCLE_NODE_VISIT_ID=nv_22222222222222222222222222222222
export FACTORY_LIFECYCLE_NODE_EXECUTION_ID=ne_33333333333333333333333333333333
export FACTORY_LIFECYCLE_NODE_ID=implement
export FACTORY_LIFECYCLE_RUN_KEY=IMPLEMENT
export FACTORY_LIFECYCLE_DISPATCH_ID=d_44444444444444444444444444444444

# Перехватывает только запись: envelope собирает настоящий runtime helper, а event-hash
# проверяет полное событие. Долговечный ledger здесь не нужен и живое состояние недоступно.
runtime_lifecycle_emit_v2() {
  local draft="$TEST_ROOT/draft.json"

  runtime_analytics_python_v2 event "$@" >"$draft" || return
  jq '. + {sequence: 1, previousEventHash: null, eventHash: ("0" * 64)}' \
    "$draft" >"$event_file" || return
  attempt_lifecycle_event_hash_v2 "$event_file"
}

# Вызывает каждую производственную границу с одинаковыми входами modelRef.
# Launcher получает исходную модель; нормализованное значение остаётся внутри телеметрии.
emit_model_event() {
  local kind=$1 requested=$2 resolved=$3

  case "$kind" in
    dispatch_candidate_selected)
      runtime_lifecycle_dispatch_candidate_selected_v2 0 glm "$requested" "$resolved" \
        high exact task-stage closed available primary
      ;;
    dispatch_candidate_skipped)
      runtime_lifecycle_dispatch_candidate_skipped_v2 0 glm "$requested" "$resolved" \
        high exact task-stage open unknown breaker_open
      ;;
    runner_started)
      _runner_lifecycle_started_v2 glm run-1 1 "$requested" high exact \
        101 101 101 124 fresh '' '' '' ''
      ;;
  esac
}

for kind in dispatch_candidate_selected dispatch_candidate_skipped runner_started; do
  hash=$(emit_model_event "$kind" "$raw_model" "$raw_resolved")
  assert_rc 0 "$?" "$kind: полное событие принято строгой схемой"
  [[ "$hash" =~ ^[a-f0-9]{64}$ ]]
  assert_rc 0 "$?" "$kind: event-hash вернул SHA-256"
  assert_eq zai/glm-5.3 "$(jq -r '.details.requestedModel' "$event_file")" \
    "$kind: requestedModel преобразован"

  expected_resolved=zai/glm-5.2
  if [[ "$kind" == runner_started ]]; then
    expected_resolved=zai/glm-5.3
  fi

  assert_eq "$expected_resolved" "$(jq -r '.details.resolvedModel' "$event_file")" \
    "$kind: resolvedModel преобразован независимо"

  for field in requestedModel resolvedModel; do
    jq --arg field "$field" --arg raw "$raw_model" '.details[$field] = $raw' \
      "$event_file" >"$TEST_ROOT/invalid.json"
    attempt_lifecycle_event_hash_v2 "$TEST_ROOT/invalid.json" >"$TEST_ROOT/hash.out" \
      2>"$TEST_ROOT/hash.err"
    assert_rc 78 "$?" "$kind: сырой modelRef в $field по-прежнему запрещён"
    assert_contains "$(cat "$TEST_ROOT/hash.err")" \
      'lifecycle-schema-invalid: $: expected exactly one discriminated schema branch' \
      "$kind: отрицательный контроль повторяет исходную ошибку"
  done

  emit_model_event "$kind" gpt-5.3 gpt-5.3 >/dev/null
  assert_rc 0 "$?" "$kind: обычная модель проходит прежний контракт"
  assert_eq gpt-5.3 "$(jq -r '.details.requestedModel' "$event_file")" \
    "$kind: обычная модель не изменена"
done

for kind in dispatch_candidate_selected dispatch_candidate_skipped; do
  emit_model_event "$kind" "$raw_model" '' >/dev/null
  assert_rc 0 "$?" "$kind: отсутствие resolvedModel допустимо"
  assert_eq null "$(jq -r '.details.resolvedModel' "$event_file")" \
    "$kind: отсутствие resolvedModel сохраняет JSON null"
done

emit_model_event dispatch_candidate_selected '["zai","bad,model"]' '' \
  >"$TEST_ROOT/hash.out" 2>"$TEST_ROOT/hash.err"
assert_rc 78 "$?" "запрещённые символы внутри модели не скрываются нормализацией"

finish_tests
