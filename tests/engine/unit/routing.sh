#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

missing=0
for file in lib/profile-config.sh lib/routing.sh; do
  if [[ ! -f "$FACTORY_HOME/$file" ]]; then
    test_fail "$file exists" "missing $file"
    missing=1
  fi
done
if (( missing )); then
  finish_tests
  exit $?
fi
source "$FACTORY_HOME/lib/profile-config.sh"
source "$FACTORY_HOME/lib/routing.sh"

ars="$TEST_ROOT/arsenkin.runners.env"
rd="$TEST_ROOT/rdesigner.runners.env"
profile_config_create "$ars" claude codex
profile_config_create "$rd" codex claude
ars_task="$TEST_ROOT/ars.pipeline"
rd_task="$TEST_ROOT/rd.pipeline"
: >"$ars_task"; : >"$rd_task"

route=$(routing_resolve "$ars" "$ars_task" PLAN)
assert_contains "$route" "PRIMARY=claude" "Arsenkin is Claude-first"
assert_contains "$route" "FAILOVER=codex" "Arsenkin fails over to Codex"

route=$(routing_resolve "$rd" "$rd_task" PLAN)
assert_contains "$route" "PRIMARY=codex" "Rdesigner is Codex-first"
assert_contains "$route" "FAILOVER=claude" "Rdesigner fails over to Claude"

revision=$(profile_config_get "$ars" CONFIG_REVISION)
profile_config_write "$ars" "$revision" STAGE_REVIEW_PRIMARY gemini \
  STAGE_REVIEW_FAILOVER claude,codex
route=$(routing_resolve "$ars" "$ars_task" REVIEW)
assert_contains "$route" "PRIMARY=gemini" "canonical stage override beats project"
assert_contains "$route" "SOURCE=profile-stage" "stage source is visible"

printf 'RUNNER_OVERRIDE_PRIMARY=codex\nRUNNER_OVERRIDE_FAILOVER=gemini\n' >"$ars_task"
route=$(routing_resolve "$ars" "$ars_task" REVIEW)
assert_contains "$route" "PRIMARY=codex" "task override beats profile stage"
assert_contains "$route" "SOURCE=task" "task source is visible"

printf 'RUNNER_OVERRIDE_PRIMARY=codex\nRUNNER_OVERRIDE_FAILOVER=gemini\nRUNNER_OVERRIDE_STAGE_REVIEW=claude,codex\n' >"$ars_task"
route=$(routing_resolve "$ars" "$ars_task" REVIEW)
assert_contains "$route" "PRIMARY=claude" "task-stage override wins"
assert_contains "$route" "FAILOVER=codex" "task-stage chain is preserved"
assert_contains "$route" "SOURCE=task-stage" "task-stage source is visible"

printf 'RUNNER_OVERRIDE_STAGE_REVIEW=bad provider,$(touch pwned)\n' >"$ars_task"
route=$(routing_resolve "$ars" "$ars_task" REVIEW)
assert_contains "$route" "PRIMARY=gemini" "invalid task-stage chain is ignored"
assert_contains "$route" "SOURCE=profile-stage" "invalid task override falls back safely"

strict="$TEST_ROOT/strict.runners.env"
profile_config_create "$strict" codex ""
route=$(routing_resolve "$strict" "$rd_task" BUILD)
assert_contains "$route" "PRIMARY=codex" "strict project keeps primary"
assert_contains "$route" "FAILOVER=" "strict project has no hidden fallback"

finish_tests
