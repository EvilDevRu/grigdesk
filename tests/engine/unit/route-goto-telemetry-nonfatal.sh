#!/usr/bin/env bash
# Пост-шаги goto не имеют права отменить уже записанное решение человека.
#
# Случай 28.08.2026: `attempt_stage_state_human_rewind_v2` записал возврат в
# immutable журнал попытки, курсор перешёл stopped→ready, а следом телеметрия визита
# узла вернула ненулевой код двумя молчаливыми `|| return`. Движок вышел с ошибкой,
# кокпит превратил её в 409 и не выполнил resume, проекция реестра осталась старой —
# человек видел прежний затык и считал, что его указание не отправилось. При этом в
# журнале этапов не было НИ ОДНОЙ строки: оба отказа молчали.
#
# Сторож статический: правка живёт внутри большой `v2_admin_main`, изолированно её не
# вызвать, а регресс возвращается одной строкой.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

factory_bin="$FACTORY_HOME/bin/factory"
assert_file_exists "$factory_bin" "движок на месте"

# Участок между записью возврата и проекцией реестра: всё, что здесь падает, падает
# ПОСЛЕ принятого решения.
tail_block=$(awk '
  /attempt_stage_state_human_rewind_v2 \\$/ { inside = 1 }
  inside { print }
  inside && /route_v2_project_latest_reset "\$TASK" "\$EXPECTED_ATTEMPT"/ { exit }
' "$factory_bin")

if [[ -z "$tail_block" ]]; then
  test_fail "участок goto найден" "не нашёлся блок между human_rewind и project_latest_reset"
  finish_tests
fi
test_ok "участок goto найден"

# Телеметрия визита узла обязана быть незавершающей.
visit_block=$(printf '%s\n' "$tail_block" | awk '
  /FACTORY_LIFECYCLE_NODE_VISIT_ID/ { inside = 1 }
  inside { print }
  inside && /^    fi$/ { exit }
')

assert_contains "$visit_block" "v2_lifecycle_latest_stage_hash" "блок телеметрии визита на месте"

case "$visit_block" in
  *"|| return"*)
    test_fail "телеметрия визита не роняет goto" \
      "в блоке остался молчаливый '|| return' после записанного возврата"
    ;;
  *)
    test_ok "телеметрия визита не роняет goto"
    ;;
esac

# Отказ телеметрии обязан быть назван: молчание здесь стоило полной потери диагноза.
case "$visit_block" in
  *"v2_log"*) test_ok "отказ телеметрии называется в журнале" ;;
  *) test_fail "отказ телеметрии называется в журнале" "в блоке нет ни одного v2_log" ;;
esac

# Проекция реестра остаётся завершающей: без неё UI показывает прежний затык, и это
# настоящий отказ, а не потерянная строка телеметрии. Она стоит уже ЗА разобранным
# участком, поэтому ищется по всему движку.
assert_contains "$(cat "$factory_bin")" 'goto $GATE_NODE записан, но reset-проекция не завершена' \
  "провал проекции реестра остаётся отказом с объяснением"

finish_tests
