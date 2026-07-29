#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/runners/codex.sh"

state_root="$TEST_ROOT/state-root"
project_extra="$TEST_ROOT/project-extra"
run_dir="$TEST_ROOT/run"
mkdir -p "$state_root" "$project_extra" "$run_dir"
export RUNNER_CODEX_ADD_DIRS="$state_root $project_extra"

factory_exec() {
  printf '%s\n' "$@" >"$TEST_ROOT/codex-argv"
  return 0
}

runner_codex_run 42 "prompt" BUILD gpt-fixture high 30 "$run_dir"
assert_rc 0 "$?" "Codex runner can be inspected without a model call"

argv=$(cat "$TEST_ROOT/codex-argv")
assert_contains "$argv" "$state_root" "Codex sandbox receives writable state root"
assert_contains "$argv" "$project_extra" "Codex sandbox receives profile write root"
add_count=$(grep -c '^--add-dir$' "$TEST_ROOT/codex-argv" || true)
assert_eq 2 "$add_count" "Codex emits one add-dir flag per writable root"

grep -q '^danger-full-access$' "$TEST_ROOT/codex-argv"
assert_rc 1 "$?" "Codex runner never disables the sandbox for extra roots"

finish_tests
