#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/runners/claude.sh"

control="$FACTORY_CONFIG_ROOT/control"
settings="$control/claude-route-settings.json"
run_dir="$TEST_ROOT/run"
mkdir -p "$control" "$run_dir"
chmod 700 "$control"
tool_control="//${control#/}"
# Native OS sandbox снят (см. lib/core.sh): engine выдаёт settings без блока `sandbox`,
# и раннер обязан их принимать — иначе конвейер встаёт целиком.
printf '{"permissions":{"allow":[],"deny":["Read(%s)","Read(%s/**)","Edit(%s)","Edit(%s/**)","Write(%s)","Write(%s/**)","NotebookEdit(%s)","NotebookEdit(%s/**)"]}}' \
  "$tool_control" "$tool_control" "$tool_control" "$tool_control" \
  "$tool_control" "$tool_control" "$tool_control" "$tool_control" >"$settings"
chmod 400 "$settings"

# Этот файл подменяет claude фейком, поэтому доказывает только то, что раннер ПЕРЕДАЁТ
# нужные флаги. Соблюдает ли их живой CLI — вопрос к самому бинарю: на него отвечает
# tools/claude-contract-smoke.mjs, который гоняется после обновления CLI и периодически.
FAKE_CLAUDE_VERSION='2.1.241 (Claude Code)'
CAPTURE_FILE="$TEST_ROOT/claude-argv.tsv"
factory_exec() {
  local kind=$1
  shift
  [[ "$kind" == provider ]] || return 2
  if [[ "${1:-}" == claude && "${2:-}" == --version ]]; then
    printf '%s\n' "$FAKE_CLAUDE_VERSION"
    return 0
  fi
  local index=0 arg
  : >"$CAPTURE_FILE"
  for arg in "$@"; do
    printf '%s\t%s\n' "$index" "$arg" >>"$CAPTURE_FILE"
    index=$((index + 1))
  done
  return 0
}

probe=$(runner_claude_probe)
probe_rc=$?
assert_rc 0 "$probe_rc" "установленный Claude CLI доступен раннеру"
assert_contains "$probe" '2.1.241' "probe отдаёт версию установленного CLI"

# Списка разрешённых версий больше нет намеренно: он дописывался руками на каждое
# обновление, до правки regex весь конвейер стоял недоступным, а изоляцию всё это время
# держали флаги запуска, а не список. Новая версия обязана быть доступной сразу.
FAKE_CLAUDE_VERSION='2.2.0 (Claude Code)'
runner_claude_probe >/dev/null 2>&1
assert_rc 0 "$?" "новая версия CLI не блокируется списком аудита"

# Осмысленность ответа проверять всё равно надо: без номера версии probe нечего положить
# ни в телеметрию запуска, ни в диалект аналитики.
FAKE_CLAUDE_VERSION='(Claude Code)'
runner_claude_probe >/dev/null 2>&1
assert_rc 4 "$?" "ответ без номера версии остаётся fail-closed"
FAKE_CLAUDE_VERSION='2.1.241 (Claude Code)'

export RUNNER_CLAUDE_CONTROL_DIR="$control"
export RUNNER_CLAUDE_SETTINGS="$settings"
runner_claude_run 42 prompt BUILD opus high 30 "$run_dir"
assert_rc 0 "$?" "Claude argv can be inspected without a model call"

argv=$(cut -f2- "$CAPTURE_FILE")
assert_contains "$argv" '--settings' "Claude receives only the trusted settings file"
settings_arg=$(awk -F '\t' '$2 == "--settings" { getline; sub(/^[^\t]*\t/, ""); print; exit }' "$CAPTURE_FILE")
assert_eq "$settings" "$settings_arg" "--settings points inside the trusted control root"
source_arg=$(awk -F '\t' '$2 == "--setting-sources" { getline; sub(/^[^\t]*\t/, ""); print; exit }' "$CAPTURE_FILE")
assert_eq '' "$source_arg" "empty --setting-sources disables user, project and local settings"
for flag in --strict-mcp-config --disable-slash-commands; do
  grep -Fxq -- "$flag" <<<"$argv"
  assert_rc 0 "$?" "Claude route argv includes $flag"
done
grep -Fxq -- '--safe-mode' <<<"$argv"
assert_rc 1 "$?" "safe-mode снят: агентам конвейера нужна память CLAUDE.md из worktree"
grep -Fxq -- '--mcp-config' <<<"$argv"
assert_rc 1 "$?" "strict MCP mode loads no filesystem MCP configuration"
grep -Fxq -- '--bare' <<<"$argv"
assert_rc 1 "$?" "route isolation does not disable OAuth or keychain authentication"
grep -Fxq -- '--dangerously-skip-permissions' <<<"$argv"
assert_rc 1 "$?" "Claude route runner never bypasses permissions"

untrusted="$TEST_ROOT/untrusted-settings.json"
printf '{}\n' >"$untrusted"
chmod 400 "$untrusted"
RUNNER_CLAUDE_SETTINGS="$untrusted"
CAPTURE_FILE="$TEST_ROOT/untrusted-argv.tsv"
runner_claude_run 42 prompt BUILD opus high 30 "$run_dir" >/dev/null 2>&1
assert_rc 78 "$?" "settings outside the trusted control root fail closed"
assert_file_missing "$CAPTURE_FILE" "untrusted settings fail before provider execution"

# Отсутствие границы честнее её имитации: объявленный sandbox обязан остаться аудированной
# формой, поэтому дырявый блок (excludedCommands) отвергается так же жёстко, как раньше.
half="$control/half-sandboxed-settings.json"
printf '{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,"excludedCommands":["docker"],"filesystem":{"denyRead":["%s","%s/**"],"denyWrite":["%s","%s/**"]}},"permissions":{"allow":[],"deny":["Read(%s)","Read(%s/**)","Edit(%s)","Edit(%s/**)","Write(%s)","Write(%s/**)","NotebookEdit(%s)","NotebookEdit(%s/**)"]}}' \
  "$control" "$control" "$control" "$control" \
  "$tool_control" "$tool_control" "$tool_control" "$tool_control" \
  "$tool_control" "$tool_control" "$tool_control" "$tool_control" >"$half"
chmod 400 "$half"
RUNNER_CLAUDE_SETTINGS="$half"
CAPTURE_FILE="$TEST_ROOT/half-argv.tsv"
runner_claude_run 42 prompt BUILD opus high 30 "$run_dir" >/dev/null 2>&1
assert_rc 78 "$?" "a declared sandbox with escape hatches still fails closed"
assert_file_missing "$CAPTURE_FILE" "half-configured sandbox fails before provider execution"

finish_tests
