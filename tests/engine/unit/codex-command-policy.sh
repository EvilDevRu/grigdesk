#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

policy="$FACTORY_HOME/lib/runners/codex-command-policy.py"

policy_command() {
  local command=$1 payload
  payload=$(python3 - "$command" <<'PY'
import json
import sys
print(json.dumps({"tool_name": "Bash", "tool_input": {"command": sys.argv[1]}}))
PY
  ) || return
  printf '%s\n' "$payload" | python3 "$policy" shared-stand
}

sample_repo="$TEST_ROOT/work/sample-repository"
profile_tool="$TEST_ROOT/profiles/sample-profile/stand-tool.sh"

for command in \
  '/usr/bin/docker ps' \
  'command docker inspect sample-container' \
  "git -C $sample_repo worktree add $TEST_ROOT/worktree main" \
  '/usr/bin/git commit -am forbidden' \
  'git push origin HEAD' \
  'gh pr create --title forbidden'; do
  output=$(policy_command "$command")
  assert_contains "$output" '"permissionDecision": "deny"' \
    "shared-stand command policy denies: $command"
done

output=$(policy_command "bash $profile_tool metrics --json")
assert_eq '' "$output" "profile-owned stand-tool remains available through the broker"

output=$(printf '{broken\n' | python3 "$policy" shared-stand)
assert_contains "$output" '"permissionDecision": "deny"' \
  "malformed PreToolUse payload fails closed"

output=$(printf '%s\n' '{"tool_name":"Read","tool_input":{}}' | \
  python3 "$policy" shared-stand)
assert_contains "$output" '"permissionDecision": "deny"' \
  "unexpected hook tool fails closed"

finish_tests
