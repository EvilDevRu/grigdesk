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
  cat >"$TEST_ROOT/codex-stdin"
  return "${FIXTURE_CODEX_RC:-0}"
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

# Auto-review определяется точным сочетанием route policy и native sandbox,
# поэтому SHIP и BUILD имеют одинаковые права, а неизвестные политики не расширяются.
for stage in BUILD SHIP; do
  FACTORY_ROUTE_FILESYSTEM_POLICY=workspace-write RUNNER_AUTO_COMPACT_WINDOW=120000 \
    runner_codex_run 42 "prompt" "$stage" gpt-fixture high 30 "$run_dir"
  assert_rc 0 "$?" "$stage workspace-write запускается через штатный reviewer"
  argv=$(cat "$TEST_ROOT/codex-argv")
  approve_count=$(grep -c '^--approve-for-me$' "$TEST_ROOT/codex-argv" || true)
  assert_eq 1 "$approve_count" "$stage задаёт ровно один approve-for-me"

  for forbidden in --sandbox --yolo --dangerously-bypass-approvals-and-sandbox danger-full-access; do
    grep -Fxq -- "$forbidden" "$TEST_ROOT/codex-argv"
    assert_rc 1 "$?" "$stage не смешивает Auto-review с $forbidden"
  done
  grep -Fq -- 'approval_policy="never"' "$TEST_ROOT/codex-argv"
  assert_rc 1 "$?" "$stage не выключает native approvals"

  for exact in provider timeout -k 30 codex exec --json --skip-git-repo-check -m gpt-fixture \
    'model_reasoning_effort="high"' model_auto_compact_token_limit=120000 \
    sandbox_workspace_write.network_access=true "$state_root" "$project_extra" "$run_dir/last.md" -; do
    grep -Fxq -- "$exact" "$TEST_ROOT/codex-argv"
    assert_rc 0 "$?" "$stage сохраняет аргумент $exact"
  done
  assert_eq prompt "$(cat "$TEST_ROOT/codex-stdin")" "$stage сохраняет prompt в stdin"
done

for policy in state-only transactional-write unset unknown; do
  route_policy=$policy
  [[ "$policy" != unset ]] || route_policy=''
  FACTORY_ROUTE_FILESYSTEM_POLICY="$route_policy" \
    runner_codex_run 42 "prompt" SHIP gpt-fixture high 30 "$run_dir"
  assert_rc 0 "$?" "$policy сохраняет старую файловую политику"
  grep -Fxq -- '--approve-for-me' "$TEST_ROOT/codex-argv"
  assert_rc 1 "$?" "$policy не получает Auto-review даже на SHIP"
  grep -Fxq -- '--sandbox' "$TEST_ROOT/codex-argv"
  assert_rc 0 "$?" "$policy сохраняет native sandbox"
  if [[ "$policy" == state-only ]]; then
    grep -Fxq -- 'approval_policy="never"' "$TEST_ROOT/codex-argv"
    assert_rc 0 "$?" "state-only явно запрещает escalation"
  fi
done

for sandbox in read-only danger-full-access; do
  FACTORY_ROUTE_FILESYSTEM_POLICY=workspace-write RUNNER_CODEX_SANDBOX="$sandbox" \
    runner_codex_run 42 "prompt" SHIP gpt-fixture high 30 "$run_dir"
  grep -Fxq -- '--approve-for-me' "$TEST_ROOT/codex-argv"
  assert_rc 1 "$?" "explicit $sandbox не подменяется Auto-review"
  grep -Fxq -- "$sandbox" "$TEST_ROOT/codex-argv"
  assert_rc 0 "$?" "explicit $sandbox сохраняется как прежний вход"
done

FACTORY_ROUTE_FILESYSTEM_POLICY=workspace-write FIXTURE_CODEX_RC=17 \
  runner_codex_run 42 "prompt" SHIP gpt-fixture high 30 "$run_dir"
assert_rc 17 "$?" "Auto-review сохраняет exit code провайдера"

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

FACTORY_ROUTE_FILESYSTEM_POLICY=workspace-write \
  runner_codex_run 42 "prompt" SHIP gpt-fixture high 30 "$run_dir"
restricted_rc=$?
assert_rc 0 "$restricted_rc" "shared-stand Codex policy can be inspected without a model call"

restricted=$(cat "$TEST_ROOT/codex-argv")
for exact in '--approve-for-me' '--sandbox'; do
  grep -Fxq -- "$exact" "$TEST_ROOT/codex-argv"
  assert_rc 1 "$?" "restricted SHIP не получает $exact"
done
grep -Fxq -- 'approval_policy="never"' "$TEST_ROOT/codex-argv"
assert_rc 0 "$?" "restricted SHIP сохраняет never"
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
