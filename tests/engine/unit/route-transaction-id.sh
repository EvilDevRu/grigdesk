#!/usr/bin/env bash
# Повтор без stage-result не сдвигает журнал. Закрытая транзакция остаётся
# историей, а новый заход должен получить собственный ID и согласованный контекст.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/route-runtime.sh"

task=4242
attempt=a_11111111111111111111111111111111
base="v2-${attempt#*_}-s7"
root=$(instrumentation_tx_root "$task")

assert_eq "$base" "$(_route_v2_transaction_id "$task" "$attempt" 7)" \
  "первый ID сохраняет прежний формат и позицию журнала"
assert_file_missing "$root/$base/state.env" \
  "подготовка контекста не создаёт транзакцию"

mkdir -p "$root/$base"
printf 'STATE=completed\n' >"$root/$base/state.env"
next="v2-${attempt#*_}-s8"
assert_eq "$next" "$(_route_v2_transaction_id "$task" "$attempt" 7)" \
  "повтор с прежней позицией журнала пропускает completed"
assert_eq "$next" "$(_route_v2_transaction_id "$task" "$attempt" 7)" \
  "контекст и begin выбирают одинаковый ID без побочных эффектов"
assert_eq completed "$(_instrumentation_tx_get "$root/$base/state.env" STATE)" \
  "выбор ID не переписывает историю предыдущего захода"

mkdir -p "$root/$next"
printf 'STATE=completed\n' >"$root/$next/state.env"
third="v2-${attempt#*_}-s9"
assert_eq "$third" "$(_route_v2_transaction_id "$task" "$attempt" 7)" \
  "новый процесс после двух cleanup не повторяет старые ID"
assert_eq "$next" "$(_route_v2_completed_instrumentation_for_attempt "$task" "$attempt")" \
  "восстановление находит последнюю завершённую транзакцию прежним reader"

printf 'TRANSACTION_ID=%s\n' "$next" >"$root/active.env"
assert_eq "$next" "$(_route_v2_transaction_id "$task" "$attempt" 7)" \
  "действующая транзакция instrument остаётся общей с proof"
rm -- "$root/active.env"

for state in active cleaning stalled; do
  printf 'STATE=%s\n' "$state" >"$root/$next/state.env"
  _route_v2_transaction_id "$task" "$attempt" 7 >/dev/null
  assert_rc 75 "$?" "транзакция $state без active pointer не обходится новым ID"
done

printf 'STATE=invalid\n' >"$root/$next/state.env"
_route_v2_transaction_id "$task" "$attempt" 7 >/dev/null
assert_rc 78 "$?" "повреждённое состояние не пропускается"
rm -- "$root/$next/state.env"
ln -s "$root/$base/state.env" "$root/$next/state.env"
_route_v2_transaction_id "$task" "$attempt" 7 >/dev/null
assert_rc 78 "$?" "ссылка вместо state.env не принимается"

finish_tests
