#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

repo="$TEST_ROOT/work/repo"
mkdir -p "$repo"
PROFILE_AGENT_CWD="$repo"
PROFILE_AGENT_DIRS="$repo"
profile_stage_agent_allow() {
  case "$1" in
    SHIP) printf '%s\n' 'Bash(profile-deliver.sh:*)' 'Bash(tracker-update.sh:*)' ;;
    HUNT_ACCESS) printf '%s\n' 'Bash(profile-evidence.sh:*)' ;;
    VERIFY) printf '%s\n' 'Bash(profile-evidence.sh:*)' 'Bash(profile-verify.sh:*)' ;;
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
assert_contains "$ship_settings" '"Bash(profile-deliver.sh:*)"' \
  "delivery node receives its profile-owned command"
assert_contains "$ship_settings" '"Bash(tracker-update.sh:*)"' \
  "delivery node receives its tracker command"
case "$settings" in
  *'Bash(profile-deliver.sh:*)'*)
    test_fail "state-only review has no delivery grant" "delivery command leaked to REVIEW"
    ;;
  *)
    test_ok "state-only review has no delivery grant"
    ;;
esac

hunt_settings=$(FACTORY_ROUTE_FILESYSTEM_POLICY=state-only _agent_settings HUNT_ACCESS)
hunt_settings=$(cat "$hunt_settings")
assert_contains "$hunt_settings" '"Bash(profile-evidence.sh:*)"' \
  "hunt lens receives its trusted evidence command"
case "$hunt_settings" in
  *'profile-deliver.sh'*|*'Bash(tracker-update.sh:*)'*)
    test_fail "hunt lens has no delivery grant" "$hunt_settings"
    ;;
  *)
    test_ok "hunt lens has no delivery grant"
    ;;
esac

verify_settings=$(FACTORY_ROUTE_FILESYSTEM_POLICY=state-only _agent_settings VERIFY)
verify_settings=$(cat "$verify_settings")
assert_contains "$verify_settings" '"Bash(profile-verify.sh:*)"' \
  "verify receives the trusted profile verification command"

finish_tests

# --- составная команда решается по САМОЙ СЛАБОЙ части ---
# CLI разбирает `git status && cd … && git status` на части, и отказ одной запрещает
# всю команду. Замер по журналам всех прогонов: 1240 отказов Bash, 88% составные, и
# первыми блокирующими кусками идут `echo` (1178) и `cd` (357) — куски, которые сами
# по себе ничего не делают. Цена отказа не только в потраченном вызове: агент, которому
# запретили нужную проверку, подменяет её похожей и выдаёт результат за требуемый.
check_settings=$(FACTORY_ROUTE_FILESYSTEM_POLICY=state-only \
  FACTORY_ROUTE_BROWSER_POLICY=forbid _agent_settings REVIEW)
check_settings=$(cat "$check_settings")
write_settings=$(FACTORY_ROUTE_FILESYSTEM_POLICY=workspace-write \
  FACTORY_ROUTE_BROWSER_POLICY=forbid _agent_settings BUILD)
write_settings=$(cat "$write_settings")

has() { [[ "$1" == *"$2"* ]] && printf 'да' || printf 'нет'; }

# `cd` не умеет записать ничего вовсе, поэтому выдаётся всем узлам без исключения.
assert_eq да "$(has "$check_settings" '"Bash(cd:*)"')" "cd разрешён проверяющему узлу"
assert_eq да "$(has "$write_settings" '"Bash(cd:*)"')" "cd разрешён пишущему узлу"

# `echo`/`printf` — только там, где запись и так есть. На пишущем узле они не дают
# новой возможности: Write и Edit там уже выданы.
assert_eq да "$(has "$write_settings" '"Bash(echo:*)"')" "echo разрешён пишущему узлу"
assert_eq да "$(has "$write_settings" '"Bash(printf:*)"')" "printf разрешён пишущему узлу"

# А проверяющему нельзя: `echo x > file` правилами не выражается, и предупредительный
# рубеж прав сменился бы посмертным сторожем, который валит узел уже после всей работы.
assert_eq нет "$(has "$check_settings" '"Bash(echo:*)"')" \
  "echo проверяющему узлу не выдаётся: перенаправление правилом не ловится"
assert_eq нет "$(has "$check_settings" '"Bash(printf:*)"')" \
  "printf проверяющему узлу не выдаётся по той же причине"

# Узел без объявленной политики считается проверяющим по умолчанию не бывает, но и
# послаблений не получает: неизвестная политика не должна открывать запись обходным путём.
unknown_settings=$(FACTORY_ROUTE_FILESYSTEM_POLICY= _agent_settings REVIEW)
unknown_settings=$(cat "$unknown_settings")
assert_eq да "$(has "$unknown_settings" '"Bash(cd:*)"')" "cd есть и без объявленной политики"
