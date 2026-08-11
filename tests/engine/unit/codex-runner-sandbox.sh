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
assert_contains "$argv" "sandbox_workspace_write.network_access=true" \
  "Codex factory runner keeps network access inside workspace-write sandbox"

grep -q '^danger-full-access$' "$TEST_ROOT/codex-argv"
assert_rc 1 "$?" "Codex runner never disables the sandbox for extra roots"

# Shared stand получает не общий workspace-write/network, а самодостаточный
# permission profile: exact control dir read-only, network полностью выключен.
control_dir="$TEST_ROOT/agent-control"
mkdir -m 700 "$control_dir"
mkfifo -m 600 "$control_dir/request.fifo" "$control_dir/response.fifo"
touch "$control_dir/client.lock"
chmod 400 "$control_dir/client.lock"
export RUNNER_CODEX_RESTRICT_SHARED_STAND=1
export PROFILE_AGENT_CONTROL_DIR="$control_dir"
export RUNNER_CODEX_READ_DIRS="$project_extra"

# Shared-stand resolver проверяет layout установленного npm-пакета. Собираем
# минимальный tracked-by-test runtime под TEST_ROOT, не полагаясь на ignored
# node_modules рабочей машины.
codex_runtime="$TEST_ROOT/codex-runtime"
codex_entry="$codex_runtime/bin/codex"
codex_native="$codex_runtime/node_modules/@openai/codex-linux-fixture/vendor/fixture/bin/codex"
mkdir -p "$(dirname "$codex_entry")" "$(dirname "$codex_native")"
printf '#!/usr/bin/env bash\nexit 0\n' >"$codex_entry"
printf '#!/usr/bin/env bash\nexit 0\n' >"$codex_native"
chmod +x "$codex_entry" "$codex_native"
export PATH="$codex_runtime/bin:$PATH"

runner_codex_run 42 "prompt" BUILD gpt-fixture high 30 "$run_dir"
restricted_rc=$?
assert_rc 0 "$restricted_rc" "shared-stand Codex policy can be inspected without a model call"

restricted=$(cat "$TEST_ROOT/codex-argv")
for exact in --ignore-user-config --strict-config --dangerously-bypass-hook-trust; do
  grep -Fxq -- "$exact" "$TEST_ROOT/codex-argv"
  assert_rc 0 "$?" "shared-stand runner emits $exact"
done
assert_contains "$restricted" 'default_permissions="factory-shared-stand"' \
  "shared-stand runner selects its exact permission profile"
assert_contains "$restricted" '":minimal" = "read"' \
  "shared-stand runner has no host-wide read grant"
assert_contains "$restricted" '":workspace_roots" = { "." = "write", ".git" = "read", ".codex" = "read" }' \
  "shared-stand workspace cannot mutate git or Codex policy"
assert_contains "$restricted" "\"$control_dir\" = \"read\"" \
  "shared-stand runner mounts only its exact control directory read-only"
assert_contains "$restricted" 'network = { enabled = false }' \
  "shared-stand command sandbox has no network transport"
assert_contains "$restricted" "$FACTORY_HOME/lib/runners/codex-command-policy.py shared-stand" \
  "shared-stand runner installs the engine-owned command hook"
grep -Fxq -- '--sandbox' "$TEST_ROOT/codex-argv"
assert_rc 1 "$?" "shared-stand runner does not mix legacy sandbox flags with a permission profile"
grep -Fq -- 'sandbox_workspace_write.network_access' "$TEST_ROOT/codex-argv"
assert_rc 1 "$?" "shared-stand runner does not inherit broad workspace network"
for forbidden in features.network_proxy unix_sockets domains= 127.0.0.1 /var/run/docker.sock; do
  grep -Fq -- "$forbidden" "$TEST_ROOT/codex-argv"
  assert_rc 1 "$?" "shared-stand policy contains no transport token: $forbidden"
done
control_add_count=$(grep -Fx -- "$control_dir" "$TEST_ROOT/codex-argv" | wc -l)
assert_eq 0 "$control_add_count" "control directory is never emitted as writable --add-dir"

RUNNER_CODEX_ADD_DIRS="$state_root $project_extra $control_dir"
runner_codex_run 42 "prompt" BUILD gpt-fixture high 30 "$run_dir" >/dev/null 2>&1
assert_rc 4 "$?" "shared-stand runner rejects writable-root overlap with control dir"

finish_tests
