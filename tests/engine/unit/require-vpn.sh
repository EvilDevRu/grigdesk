#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

gate="$FACTORY_HOME/../deploy/require-vpn.sh"
assert_file_exists "$gate" "VPN gate script exists"

sys_net="$TEST_ROOT/sys/class/net"
fake_ip="$TEST_ROOT/bin/ip"
calls="$TEST_ROOT/ip.calls"
mkdir -p "$sys_net" "$(dirname "$fake_ip")"

cat >"$fake_ip" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${FIXTURE_IP_CALLS:?}"
[[ "${1:-}" == route && "${2:-}" == get && -n "${3:-}" ]] || exit 2
case "${FIXTURE_ROUTE_MODE:-match}" in
  empty) exit 0 ;;
  fail) exit 2 ;;
  match) printf '%s via 192.0.2.1 dev vpn0 src 192.0.2.2\n' "$3" ;;
  other) printf '%s via 192.0.2.1 dev lan0 src 192.0.2.2\n' "$3" ;;
  badname) printf '%s via 192.0.2.1 dev ../vpn0 src 192.0.2.2\n' "$3" ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$fake_ip"

gate_rc() {
  env -i \
    PATH=/usr/bin:/bin \
    FACTORY_TESTING=1 \
    GRIGDESK_VPN_SYS_CLASS_NET="$sys_net" \
    GRIGDESK_IP_BIN="$fake_ip" \
    FIXTURE_IP_CALLS="$calls" \
    "$@" \
    bash "$gate" >"$TEST_ROOT/gate.out" 2>"$TEST_ROOT/gate.err"
  printf '%s\n' "$?"
}

rm -f "$calls"
assert_rc 1 "$(gate_rc)" "VPN gate fails closed by default without a TUN route"
assert_file_exists "$calls" "default gate probes the effective route"

rm -f "$calls"
assert_rc 0 "$(gate_rc GRIGDESK_REQUIRE_VPN=0 GRIGDESK_VPN_IFACE='bad iface')" \
  "explicitly disabled gate ignores unused VPN settings"
assert_file_missing "$calls" "explicitly disabled gate performs no route probe"
assert_rc 1 "$(gate_rc GRIGDESK_REQUIRE_VPN=maybe)" \
  "unknown gate mode fails closed"
assert_rc 1 "$(gate_rc FIXTURE_ROUTE_MODE=badname)" \
  "auto-detected interface cannot escape sysfs"
assert_rc 1 "$(gate_rc GRIGDESK_REQUIRE_VPN=1 \
  GRIGDESK_VPN_IFACE='bad iface' GRIGDESK_VPN_PROBE=203.0.113.10)" \
  "enabled gate rejects an invalid interface name"
assert_rc 1 "$(gate_rc GRIGDESK_REQUIRE_VPN=1 GRIGDESK_VPN_IFACE=vpn0 GRIGDESK_VPN_PROBE=203.0.113.10)" \
  "enabled gate rejects a missing interface"

mkdir -p "$sys_net/vpn0"
printf '0001\n' >"$sys_net/vpn0/tun_flags"
printf 'down\n' >"$sys_net/vpn0/operstate"
assert_rc 1 "$(gate_rc GRIGDESK_REQUIRE_VPN=1 GRIGDESK_VPN_IFACE=vpn0 GRIGDESK_VPN_PROBE=203.0.113.10)" \
  "enabled gate rejects a down interface"

printf 'up\n' >"$sys_net/vpn0/operstate"
assert_rc 1 "$(gate_rc GRIGDESK_REQUIRE_VPN=1 GRIGDESK_VPN_IFACE=vpn0 GRIGDESK_VPN_PROBE=203.0.113.10 FIXTURE_ROUTE_MODE=empty)" \
  "enabled gate rejects an absent route"
assert_rc 1 "$(gate_rc GRIGDESK_REQUIRE_VPN=1 GRIGDESK_VPN_IFACE=vpn0 GRIGDESK_VPN_PROBE=203.0.113.10 FIXTURE_ROUTE_MODE=other)" \
  "enabled gate rejects a route through another interface"
assert_rc 0 "$(gate_rc GRIGDESK_REQUIRE_VPN=1 GRIGDESK_VPN_IFACE=vpn0 GRIGDESK_VPN_PROBE=203.0.113.10 FIXTURE_ROUTE_MODE=match)" \
  "enabled gate accepts a route through the declared interface"

printf 'unknown\n' >"$sys_net/vpn0/operstate"
assert_rc 0 "$(gate_rc GRIGDESK_REQUIRE_VPN=1 GRIGDESK_VPN_IFACE=vpn0 GRIGDESK_VPN_PROBE=203.0.113.10 FIXTURE_ROUTE_MODE=match)" \
  "tun-style unknown operstate remains valid when the route matches"
assert_rc 0 "$(gate_rc FIXTURE_ROUTE_MODE=match)" \
  "default gate discovers the routed TUN without a host-specific interface name"

source_text=$(cat "$gate")
assert_contains "$source_text" '[[ "${FACTORY_TESTING:-0}" == 1 ]]' \
  "filesystem and ip overrides remain test-only"

finish_tests
