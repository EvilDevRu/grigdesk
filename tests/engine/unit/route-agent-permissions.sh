#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

repo="$TEST_ROOT/work/repo"
mkdir -p "$repo"
PROFILE_AGENT_CWD="$repo"
PROFILE_AGENT_DIRS="$repo"
profile_stage_agent_allow() {
  case "$1" in
    SHIP) printf '%s\n' 'Bash(gh pr create:*)' 'Bash(b24:*)' ;;
    HUNT_ACCESS) printf '%s\n' 'Bash(hunt-evidence.sh:*)' ;;
    VERIFY) printf '%s\n' 'Bash(hunt-evidence.sh:*)' 'Bash(stand-facts.sh:*)' ;;
  esac
  return 0
}

source "$FACTORY_HOME/lib/core.sh"

settings_file=$(FACTORY_ROUTE_FILESYSTEM_POLICY=state-only \
  FACTORY_ROUTE_BROWSER_POLICY=forbid _agent_settings REVIEW)
assert_eq "$CONTROL_DIR/agent-settings-REVIEW.json" "$settings_file" \
  "route permission metadata stays in trusted control state"
settings=$(cat "$settings_file")
assert_eq 400 "$(stat -c '%a' "$settings_file")" \
  "trusted provider settings are immutable to the launched process"
# Native OS sandbox снят намеренно: bwrap-namespace отбирал у рантайм-этапов группу docker
# и хостовый localhost, то есть весь канал до стенда (см. lib/core.sh). Проверка стоит здесь,
# чтобы возврат границы был осознанным: включат обратно — тест упадёт и напомнит про канал.
case "$settings" in
  *'"sandbox"'*)
    test_fail "settings carry no OS sandbox until the stand channel is restored" "$settings"
    ;;
  *)
    test_ok "settings carry no OS sandbox until the stand channel is restored"
    ;;
esac
tool_control="//${CONTROL_DIR#/}"
for tool in Read Edit Write NotebookEdit; do
  assert_contains "$settings" "\"${tool}(${tool_control}/**)\"" \
    "${tool} tool cannot reach trusted control metadata"
done
case "$settings" in
  *excludedCommands*)
    test_fail "Claude sandbox has no excluded commands" "$settings"
    ;;
  *)
    test_ok "Claude sandbox has no excluded commands"
    ;;
esac

# Prefix-based command rules are only a first barrier; the route runtime also
# compares workspace snapshots. Still deny common wrappers that would otherwise
# hide a write command from the provider permission matcher.
for wrapper in 'timeout' 'env' 'xargs' 'nohup' 'setsid' 'stdbuf' 'nice' 'sudo' 'sh -c' 'bash -c'; do
  assert_contains "$settings" "\"Bash(${wrapper}:*)\"" \
    "state-only route node denies the ${wrapper} wrapper"
done
case "$settings" in
  *'"deny":['*'"Bash(git commit:*)"'*)
    test_ok "wrapper denies sit next to workspace writer denies"
    ;;
  *)
    test_fail "wrapper denies sit next to workspace writer denies" "$settings"
    ;;
esac
assert_contains "$settings" '"Edit('"$repo"'/**)"' \
  "state-only route node denies direct edits in its workspace"
assert_contains "$settings" '"mcp__playwright"' \
  "browser-forbid policy reaches provider permissions"

# Writable nodes keep execution wrappers used by builds and tests.
writable=$(FACTORY_ROUTE_FILESYSTEM_POLICY=workspace-write \
  FACTORY_ROUTE_BROWSER_POLICY=allow _agent_settings BUILD)
case "$(cat "$writable")" in
  *'"Bash(timeout:*)"'*)
    test_fail "workspace-write route node keeps execution wrappers" "timeout denied for BUILD"
    ;;
  *)
    test_ok "workspace-write route node keeps execution wrappers"
    ;;
esac

task_settings_a=$(FACTORY_ROUTE_FILESYSTEM_POLICY=workspace-write _agent_settings BUILD 41)
task_settings_b=$(FACTORY_ROUTE_FILESYSTEM_POLICY=workspace-write _agent_settings BUILD 42)
assert_eq "$CONTROL_DIR/agent-settings-t41-BUILD.json" "$task_settings_a" \
  "trusted settings are task-scoped before concurrent provider launch"
if [[ "$task_settings_a" != "$task_settings_b" ]]; then
  test_ok "parallel tasks cannot replace each other's Claude settings path"
else
  test_fail "parallel tasks cannot replace each other's Claude settings path" "$task_settings_a"
fi

ship_settings=$(FACTORY_ROUTE_FILESYSTEM_POLICY=workspace-write _agent_settings SHIP)
ship_settings=$(cat "$ship_settings")
assert_contains "$ship_settings" '"Bash(gh pr create:*)"' \
  "delivery node receives its profile-owned command"
assert_contains "$ship_settings" '"Bash(b24:*)"' \
  "delivery node receives its tracker command"
case "$settings" in
  *'Bash(gh pr create:*)'*)
    test_fail "state-only review has no delivery grant" "gh leaked to REVIEW"
    ;;
  *)
    test_ok "state-only review has no delivery grant"
    ;;
esac

hunt_settings=$(FACTORY_ROUTE_FILESYSTEM_POLICY=state-only _agent_settings HUNT_ACCESS)
hunt_settings=$(cat "$hunt_settings")
assert_contains "$hunt_settings" '"Bash(hunt-evidence.sh:*)"' \
  "hunt lens receives its trusted evidence command"
case "$hunt_settings" in
  *'gh pr create'*|*'Bash(b24:*)'*)
    test_fail "hunt lens has no delivery grant" "$hunt_settings"
    ;;
  *)
    test_ok "hunt lens has no delivery grant"
    ;;
esac

verify_settings=$(FACTORY_ROUTE_FILESYSTEM_POLICY=state-only _agent_settings VERIFY)
verify_settings=$(cat "$verify_settings")
assert_contains "$verify_settings" '"Bash(stand-facts.sh:*)"' \
  "verify receives the trusted stand-facts command"

finish_tests
