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

browser_node="$TEST_ROOT/pinned-node"
browser_helper="$TEST_ROOT/pinned-helper"
request=$(python3 - "$browser_node" "$browser_helper" <<'BROWSER_REQUEST'
import json
import shlex
import sys
value = {"action": "fill", "tabId": "t", "pageEpoch": 1, "ref": "e1",
         "text": "do docker ps; git push origin HEAD; $(touch /tmp/forbidden)"}
print(shlex.join([*sys.argv[1:], "request", "--input-json", json.dumps(value)]))
BROWSER_REQUEST
)
payload=$(python3 - "$request" <<'BROWSER_PAYLOAD'
import json
import sys
print(json.dumps({"tool_name": "Bash", "tool_input": {"command": sys.argv[1]}}))
BROWSER_PAYLOAD
)
output=$(printf '%s\n' "$payload" | python3 "$policy" shared-stand "$browser_node" "$browser_helper")
assert_eq '' "$output" "quoted page text не считается shell command"
for command in "$request; docker ps" "$request && git push" \
  "$browser_node $browser_helper relay --input-json '{}' ; docker ps"; do
  payload=$(python3 - "$command" <<'BROWSER_PAYLOAD'
import json
import sys
print(json.dumps({"tool_name": "Bash", "tool_input": {"command": sys.argv[1]}}))
BROWSER_PAYLOAD
)
  output=$(printf '%s\n' "$payload" | python3 "$policy" shared-stand "$browser_node" "$browser_helper")
  assert_contains "$output" '"permissionDecision": "deny"' "shell chain не получает helper exemption"
done

finish_tests
