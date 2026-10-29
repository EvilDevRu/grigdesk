#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

if [[ ! -f "$FACTORY_HOME/lib/coverage.sh" ]]; then
  test_fail "coverage module exists" "missing lib/coverage.sh"
  finish_tests
  exit $?
fi
source "$FACTORY_HOME/lib/coverage.sh"

inputs="$TEST_ROOT/coverage-inputs"
mkdir -p "$inputs"
printf 'PROJECT_RUNNER_PRIMARY=claude\nPROJECT_RUNNER_FAILOVER=codex\n' >"$inputs/profile"
printf 'feature:PLAN,BUILD\nquick:BUILD\n' >"$inputs/routes"
printf 'PLAN=status_fd,fanout\nBUILD=status_fd,workspace_write\n' >"$inputs/requirements"
printf 'claude@1:status_fd,fanout\ncodex@1:status_fd\n' >"$inputs/runners"
printf 'fanout@1:fanout\n' >"$inputs/adapters"
printf 'claude=r1\ncodex=r2\n' >"$inputs/catalog"
printf 'feature\tPLAN\tcodex\tadapted\nfeature\tBUILD\tcodex\tnative\nquick\tBUILD\tcodex\tnative\n' \
  >"$inputs/plans"

hash1=$(coverage_structural_hash "$inputs/profile" "$inputs/routes" "$inputs/requirements" \
  "$inputs/runners" "$inputs/adapters" "$inputs/catalog" "$inputs/plans")
[[ "$hash1" =~ ^[0-9a-f]{64}$ ]] \
  && test_ok "structural hash is produced" \
  || test_fail "structural hash is produced" "$hash1"

sort -r "$inputs/plans" >"$inputs/plans.reordered"
hash2=$(coverage_structural_hash "$inputs/profile" "$inputs/routes" "$inputs/requirements" \
  "$inputs/runners" "$inputs/adapters" "$inputs/catalog" "$inputs/plans.reordered")
assert_eq "$hash1" "$hash2" "canonical hash ignores input row order"

printf 'fanout@2:fanout\n' >"$inputs/adapters"
hash3=$(coverage_structural_hash "$inputs/profile" "$inputs/routes" "$inputs/requirements" \
  "$inputs/runners" "$inputs/adapters" "$inputs/catalog" "$inputs/plans")
[[ "$hash3" != "$hash1" ]] \
  && test_ok "adapter version changes structural hash" \
  || test_fail "adapter version changes structural hash" "$hash3"

printf 'fanout@1:fanout\n' >"$inputs/adapters"
structural="$TEST_ROOT/structural.env"
coverage_structural_write "$structural" "$hash1" r1+r2 "$inputs/plans"
assert_rc 0 "$?" "structural artifact is written"
assert_eq 0 "$(coverage_artifact_get "$structural" UNAVAILABLE)" "covered plan has no unavailable rows"
assert_eq adapted "$(coverage_artifact_get "$structural" PROVIDER_codex)" \
  "именной уровень сводит планы провайдера к худшему покрытию"

printf 'feature\tPLAN\tcodex\tunavailable\n' >>"$inputs/plans"
coverage_structural_write "$TEST_ROOT/structural-bad.env" bad r1+r2 "$inputs/plans"
assert_eq 1 "$(coverage_artifact_get "$TEST_ROOT/structural-bad.env" UNAVAILABLE)" \
  "unavailable row is counted"
assert_eq unavailable "$(coverage_artifact_get "$TEST_ROOT/structural-bad.env" PROVIDER_codex)" \
  "недоступный план закрывает покрытие только своего провайдера"

finish_tests
