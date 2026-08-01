#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/core.sh"

# P0-контракты реальных профилей. Они намеренно проверяются отдельно от
# canonical-profiles.sh: тот тест строит изолированный fixture-профиль.

# --- arsenkin ---------------------------------------------------------------
# shellcheck disable=SC1090
source "$FACTORY_PROFILES_DIR/arsenkin/profile.sh"

assert_eq "" "$(profile_stage_readonly TRACE)" \
  "arsenkin TRACE may make and clean temporary source changes"
assert_eq 1 "$(profile_stage_readonly MEASURE)" \
  "arsenkin MEASURE remains source-readonly"

feature_stages=" ${PROFILE_ROUTE_STAGES_feature[*]} "
case "$feature_stages" in
  *" TCRITIC "*) test_fail "arsenkin TCRITIC is not a separate runtime stage" "$feature_stages" ;;
  *) test_ok "arsenkin TCRITIC is not a separate runtime stage" ;;
esac

tests_prompt=$(profile_stage_prompt 9999 TESTS)
assert_contains "$tests_prompt" "тест-критика" \
  "arsenkin TESTS performs its internal critic itself"
assert_contains "$tests_prompt" "TCRITIC done" \
  "arsenkin TESTS publishes the internal critic status"

repro_prompt=$(profile_stage_prompt 9999 REPRO)
assert_contains "$repro_prompt" "функциональный баг" \
  "arsenkin debug reproduction supports functional bugs"
assert_contains "$repro_prompt" "Данные выбирай ПО СИМПТОМУ" \
  "arsenkin debug does not force table-performance data"

measure_prompt=$(profile_stage_prompt 9999 MEASURE)
assert_contains "$measure_prompt" "readonly" \
  "arsenkin MEASURE explicitly forbids source changes"
case "$measure_prompt" in
  *"FACTORY-TRACE"*) test_fail "arsenkin MEASURE does not own instrumentation cleanup" ;;
  *) test_ok "arsenkin MEASURE does not own instrumentation cleanup" ;;
esac

trace_prompt=$(profile_stage_prompt 9999 TRACE)
assert_contains "$trace_prompt" "FACTORY-TRACE:t9999" \
  "arsenkin TRACE owns a task-scoped marker"
proof_prompt=$(profile_stage_prompt 9999 PROOF)
assert_contains "$proof_prompt" "ОБЯЗАТЕЛЬНАЯ ЧИСТКА" \
  "arsenkin PROOF cleans debug instrumentation before the human gate"

ars_roots=$(profile_source_roots 9999)
assert_contains "$ars_roots" "/home/evildev/Workspace/arsenkin/be/html" \
  "arsenkin source roots include the bootstrap backend"
assert_contains "$ars_roots" "/home/evildev/Workspace/arsenkin/be/worktree-t9999" \
  "arsenkin source roots include the task backend"
assert_contains "$ars_roots" "/home/evildev/Workspace/arsenkin/fe/worktree-t9999" \
  "arsenkin source roots include the task frontend"

# --- rdesigner --------------------------------------------------------------
# shellcheck disable=SC1090
source "$FACTORY_PROFILES_DIR/rdesigner/profile.sh"

for stage in SCOUT IDEAS SKEPTIC SYNTH; do
  assert_eq 1 "$(profile_stage_readonly "$stage")" \
    "rdesigner $stage is source-readonly"
done

for route_name in dev quick; do
  declare -n route_stages="PROFILE_ROUTE_STAGES_${route_name}"
  route_dump=" ${route_stages[*]} "
  case "$route_dump" in
    *" SHIP "*|*" RETRO "*)
      test_fail "rdesigner $route_name leaves SHIP/RETRO to the engine tail" "$route_dump"
      ;;
    *) test_ok "rdesigner $route_name leaves SHIP/RETRO to the engine tail" ;;
  esac
  unset -n route_stages
done

retro_prompt=$(profile_stage_prompt 9999 RETRO)
assert_contains "$retro_prompt" "rdesigner-lessons.md" \
  "rdesigner RETRO persists reusable lessons outside source"
assert_contains "$retro_prompt" "stage-result команду done" \
  "rdesigner RETRO has a terminal instruction"
assert_eq "/home/evildev/Workspace/rdesigner" "$(profile_source_roots 9999)" \
  "rdesigner declares its source root"

# --- cockpit ----------------------------------------------------------------
# shellcheck disable=SC1090
source "$FACTORY_PROFILES_DIR/cockpit/profile.sh"
cockpit_roots=$(profile_source_roots 9999)
assert_contains "$cockpit_roots" "/home/evildev/Workspace/cockpit" \
  "cockpit source roots include the bootstrap repository"
assert_contains "$cockpit_roots" "/home/evildev/Workspace/cockpit-worktrees/t9999" \
  "cockpit source roots include the task worktree"

finish_tests
