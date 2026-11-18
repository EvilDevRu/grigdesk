#!/usr/bin/env bash
set -euo pipefail

available_kib=$(df --output=avail -k . | tail -n 1 | tr -d ' ')
if (( available_kib < 16777216 )); then
  printf '%s\n' "Для полного native-набора нужно 16 GiB; доступно $available_kib KiB" >&2
  exit 1
fi

export SHELL=/bin/bash
export GRIGDESK_QWEN_BIN="$PWD/tests/fixtures/qwen-cli/node_modules/@qwen-code/qwen-code/cli-entry.js"
test -r "$GRIGDESK_QWEN_BIN"

# Qwen Host привязывает свои временные units к отдельному владельцу тестов.
# Общий набор сохраняет свой адрес D-Bus, адрес host-manager получает только фикстура Qwen.
user_bus="unix:path=/run/user/$(id -u)/bus"
test_scope="app-grigdesk-tests-$(cat /proc/sys/kernel/random/uuid).scope"
exec env DBUS_SESSION_BUS_ADDRESS="$user_bus" systemd-run --user --scope --collect --quiet \
  --expand-environment=no --unit="$test_scope" -- env \
  DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS-}" GRIGDESK_TEST_QWEN_SESSION_BUS="$user_bus" \
  npm --prefix server test
