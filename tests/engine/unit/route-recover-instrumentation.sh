#!/usr/bin/env bash
# Восстановление после обрыва прогона внутри транзакции инструментации.
#
# Топология: instrument открывает транзакцию и намеренно не закрывает её, proof работает
# внутри и закрывает за собой. Обрыв прогона (TERM при выключении машины) снимает
# инструментацию и закрывает транзакцию — правильно, иначе временные правки остались бы
# в рабочем дереве. Но переоткрыть её может только instrument, поэтому продолжение с
# любого узла ЗОНЫ обязано сначала вернуть курсор туда.
#
# Живой отказ, ради которого тест написан: зона перечислялась именами
# `diagnose|hyposkeptic|proof` — слепком топологии маршрута `debug`. Консилиум поставил в
# ту же зону ещё пять узлов, обрыв поймал председателя, восстановление его не узнало, и
# прогон через час работы упал на proof кодом 78 без единого слова о причине.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/route-runtime.sh"

stub_home="$TEST_ROOT/stub-home"
mkdir -p "$stub_home/bin" "$TEST_ROOT/control"

route_consilium() {
  cat >"$stub_home/bin/factory-route" <<'STUB'
#!/usr/bin/env bash
cat <<'JSON'
{"machine":{"sequence":{
  "main":["repro","instrument","council_a","council_b","council_agg","chairman",
          "hyposkeptic","proof","translator"],
  "tail":["tests","ship"]
}}}
JSON
STUB
  chmod +x "$stub_home/bin/factory-route"
}

route_plain_debug() {
  cat >"$stub_home/bin/factory-route" <<'STUB'
#!/usr/bin/env bash
cat <<'JSON'
{"machine":{"sequence":{
  "main":["repro","instrument","diagnose","hyposkeptic","proof","translator"],
  "tail":["tests"]
}}}
JSON
STUB
  chmod +x "$stub_home/bin/factory-route"
}

route_without_zone() {
  cat >"$stub_home/bin/factory-route" <<'STUB'
#!/usr/bin/env bash
cat <<'JSON'
{"machine":{"sequence":{"main":["plan","build"],"tail":["ship"]}}}
JSON
STUB
  chmod +x "$stub_home/bin/factory-route"
}

FACTORY_HOME_REAL="$FACTORY_HOME"
FACTORY_HOME="$stub_home"
ROUTE_V2_ROUTES_DIR="$TEST_ROOT/routes"
ROUTE_V2_PROFILE=stub
ROUTE_V2_CATALOG=stub
ROUTE_V2_ROUTE=consilium-debug

# --- Обвязка: всё, что не относится к решению «куда девать курсор», заглушено. ---
CURSOR_STATE=ready
CURSOR_NODE=chairman
CLEANUP_RC=3
COMPLETED_TX='v2-abcdef-s8'
REWIND_TARGET=""
REWIND_RESET=""
REWIND_ACTOR=""
COMMITTED=""

_route_v2_require_isolation() { return 0; }
_attempt_state_task_id() { printf '%s\n' "${1:-}"; }
_attempt_state_attempt_id() { printf '%s\n' "${1:-}"; }
_attempt_stage_state_node_id() { printf '%s\n' "${1:-}"; }
_route_v2_load_attempt() { return 0; }
_route_v2_quiesce_runner_before_recovery() { return 0; }
factory_control_root() { printf '%s\n' "$TEST_ROOT/control"; }
route_v2_cleanup_active_instrumentation() { return "$CLEANUP_RC"; }
attempt_stage_state_read_v2() { printf 'cursor\n'; }
_route_v2_json() { printf '%s\t%s\t%s\n' "$CURSOR_STATE" "$CURSOR_NODE" 14; }
_route_v2_completed_instrumentation_for_attempt() { printf '%s\n' "$COMPLETED_TX"; }
_route_v2_reset_chain() { printf 'instrument,council_a,proof\n'; }
v2_log() { :; }
# Коммит узла восстановлению больше не нужен: указание человека снимается ПЕРВЫМ
# коммитом узла, а тут узел никто не открывал.
_route_v2_commit_and_project() { COMMITTED="$3:$4"; return 0; }
attempt_stage_state_human_rewind_v2() {
  REWIND_TARGET=$3
  REWIND_RESET=$4
  REWIND_ACTOR=${6:-}
  return 0
}

run_recovery() {
  CURSOR_NODE=$1
  REWIND_TARGET=""
  REWIND_ACTOR=""
  COMMITTED=""
  route_v2_recover_instrumentation 4242 a_abcdef
}

# --- Узлы зоны консилиума: курсор возвращается на instrument ---
route_consilium
for node in council_a council_b council_agg chairman hyposkeptic proof; do
  run_recovery "$node"
  assert_rc 0 "$?" "recovery succeeds with the cursor on $node"
  assert_eq instrument "$REWIND_TARGET" "cursor returns to instrument from $node"
done

# Именно этот узел убил живой прогон: он лежит в зоне, но в прежний список имён не входил.
run_recovery chairman
assert_eq engine "$REWIND_ACTOR" "the engine owns this rewind and says so in the ledger"
assert_eq "" "$COMMITTED" "the node is not committed, so a human note survives to the real run"

# --- Прежняя топология `debug` ведёт себя ровно как раньше ---
route_plain_debug
for node in diagnose hyposkeptic proof; do
  run_recovery "$node"
  assert_eq instrument "$REWIND_TARGET" "plain debug route still recovers from $node"
done

# --- Вне зоны курсор не трогаем ---
route_consilium
for node in repro instrument translator tests ship; do
  run_recovery "$node"
  assert_rc 0 "$?" "recovery is a no-op with the cursor on $node"
  assert_eq "" "$REWIND_TARGET" "cursor on $node is left alone"
done

# --- Маршрут без пары instrument/proof зоны не имеет ---
route_without_zone
run_recovery build
assert_eq "" "$REWIND_TARGET" "a route without instrument/proof is never rewound"

# --- Курсор не в состоянии ready: разбирать нечего ---
route_consilium
CURSOR_STATE=stopped
run_recovery chairman
assert_eq "" "$REWIND_TARGET" "a stopped cursor is not rewound by recovery"
CURSOR_STATE=ready

# --- Транзакция закрыта, но завершённой транзакции этой попытки нет: это порча ---
COMPLETED_TX='v2-другая-s1'
run_recovery chairman
assert_rc 78 "$?" "a foreign completed transaction is a fail-closed refusal"
COMPLETED_TX='v2-abcdef-s8'

# --- Транзакция ещё активна (cleanup её только что снял): доказательство не требуется ---
CLEANUP_RC=0
run_recovery chairman
assert_eq instrument "$REWIND_TARGET" "a just-closed active transaction also returns to instrument"

FACTORY_HOME="$FACTORY_HOME_REAL"
finish_tests
