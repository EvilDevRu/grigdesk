#!/usr/bin/env bash
# Возврат курсора в зону instrument→proof при закрытой транзакции инструментации
# оставляет proof неисполнимым: транзакцию открывает только instrument, а он в reset
# промежуточного узла не попадает. Раньше это выяснялось спустя минуты работы —
# диспетчер доходил до proof и валился кодом 78 молча. Гард обязан отказать сразу.
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/route-runtime.sh"

# Заглушка каталога маршрута: описываем ту же топологию, что у consilium-debug —
# instrument открывает транзакцию, между ним и proof идёт консилиум, дальше хвост.
stub_home="$TEST_ROOT/stub-home"
mkdir -p "$stub_home/bin"
cat >"$stub_home/bin/factory-route" <<'STUB'
#!/usr/bin/env bash
cat <<'JSON'
{"machine":{"sequence":{
  "main":["repro","instrument","council_a","chairman","hyposkeptic","proof","translator"],
  "tail":["tests","ship"]
}}}
JSON
STUB
chmod +x "$stub_home/bin/factory-route"

_attempt_stage_state_node_id() { printf '%s\n' "$1"; }

ROUTE_V2_ROUTES_DIR="$TEST_ROOT/routes"
ROUTE_V2_PROFILE=stub
ROUTE_V2_CATALOG=stub
ROUTE_V2_ROUTE=consilium-debug
FACTORY_HOME_REAL="$FACTORY_HOME"
FACTORY_HOME="$stub_home"

# --- транзакция закрыта: зона между instrument и proof недоступна ---
_route_v2_transaction_active_id() { return 3; }

for node in council_a chairman hyposkeptic proof; do
  message=""
  _route_v2_goto_transaction_guard 4242 "$node" message
  assert_rc 1 "$?" "closed transaction blocks a rewind to $node"
done

message=""
_route_v2_goto_transaction_guard 4242 chairman message
case "$message" in
  *instrument*translator*)
    test_ok "refusal names both ways out: replay from instrument or rewind past proof" ;;
  *)
    test_fail "refusal names both ways out" "$message" ;;
esac

# instrument открывает транзакцию сам, поэтому возврат на него допустим.
_route_v2_goto_transaction_guard 4242 instrument
assert_rc 0 "$?" "rewind to instrument stays allowed: it opens the transaction itself"

# repro стоит до зоны, translator и хвост — за proof: их транзакция не касается.
for node in repro translator tests ship; do
  _route_v2_goto_transaction_guard 4242 "$node"
  assert_rc 0 "$?" "rewind to $node stays allowed outside the transaction zone"
done

# --- транзакция открыта: proof её унаследует, ограничивать нечего ---
_route_v2_transaction_active_id() { printf 'v2-stub-s1\n'; return 0; }
for node in chairman proof; do
  _route_v2_goto_transaction_guard 4242 "$node"
  assert_rc 0 "$?" "open transaction allows a rewind to $node"
done

# --- маршрут без транзакционной пары: гард не вмешивается ---
_route_v2_transaction_active_id() { return 3; }
cat >"$stub_home/bin/factory-route" <<'STUB'
#!/usr/bin/env bash
cat <<'JSON'
{"machine":{"sequence":{"main":["plan","build"],"tail":["ship"]}}}
JSON
STUB
_route_v2_goto_transaction_guard 4242 build
assert_rc 0 "$?" "a route without instrument/proof is never restricted"

# --- каталог недоступен: гард не блокирует человека из-за своей поломки ---
cat >"$stub_home/bin/factory-route" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
_route_v2_goto_transaction_guard 4242 chairman
assert_rc 0 "$?" "an unreadable route catalog does not turn into a false refusal"

FACTORY_HOME="$FACTORY_HOME_REAL"
finish_tests
