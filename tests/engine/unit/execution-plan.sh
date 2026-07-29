#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

missing=0
for file in lib/adapters/index.sh lib/execution-plan.sh; do
  if [[ ! -f "$FACTORY_HOME/$file" ]]; then
    test_fail "$file exists" "missing $file"
    missing=1
  fi
done
if (( missing )); then
  finish_tests
  exit $?
fi
source "$FACTORY_HOME/lib/adapters/index.sh"
source "$FACTORY_HOME/lib/execution-plan.sh"

adapter_registry_reset
adapter_registry_add fanout "$FACTORY_TESTS_HOME/fakes/adapters/fanout.sh"

requirements="$TEST_ROOT/requirements.env"
cat >"$requirements" <<'EOF'
REQUIREMENTS_SCHEMA=1
REQUIRED_CAPS=status_fd,readonly,fanout
DEGRADABLE_CAPS=fanout
EOF

plan=$(execution_plan_build "$requirements" "status_fd,readonly,fanout" "")
assert_contains "$plan" "PLAN_LEVEL=native" "all native capabilities produce native plan"

plan=$(execution_plan_build "$requirements" "status_fd,readonly" "fanout")
assert_contains "$plan" "PLAN_LEVEL=adapted" "adapter fills missing capability"
assert_contains "$plan" "PLAN_ADAPTERS=fanout@1" "plan pins adapter version"

export FAKE_FANOUT_AVAILABLE=0
plan=$(execution_plan_build "$requirements" "status_fd,readonly" "fanout")
assert_contains "$plan" "PLAN_LEVEL=degraded" "declared degradation survives missing adapter"
assert_contains "$plan" "PLAN_DEGRADED=fanout" "degraded capability is explicit"

strict="$TEST_ROOT/strict.env"
cat >"$strict" <<'EOF'
REQUIREMENTS_SCHEMA=1
REQUIRED_CAPS=status_fd,browser
DEGRADABLE_CAPS=
EOF
plan=$(execution_plan_build "$strict" "status_fd" "fanout")
assert_contains "$plan" "PLAN_LEVEL=unavailable" "unsafe missing capability is unavailable"
assert_contains "$plan" "PLAN_MISSING=browser" "unavailable plan explains missing capability"

execution_plan_runtime_classify 1 denied
assert_eq denied "$EXECUTION_RUNTIME_CLASS" "runtime adapter denial stays post-start denial"
[[ "$EXECUTION_RUNTIME_CLASS" != route_unavailable ]] \
  && test_ok "runtime failure is never relabeled preflight" \
  || test_fail "runtime failure is never relabeled preflight" "$EXECUTION_RUNTIME_CLASS"

finish_tests
