#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/core.sh"

repo="$TEST_ROOT/work/repo"
mkdir -p "$repo"
git -C "$repo" init -q
git -C "$repo" config user.name fixture
git -C "$repo" config user.email fixture@example.test
printf 'baseline\n' >"$repo/source.txt"
git -C "$repo" add source.txt
git -C "$repo" commit -qm baseline
printf 'грязное до этапа\n' >"$repo/source.txt"

PROFILE_AGENT_CWD="$repo"
profile_stage_readonly() {
  [[ "$1" == REVIEW ]] && printf '1\n'
}
profile_source_roots() {
  printf '%s\n' "$repo"
}

before=$(_readonly_guard_capture 7 REVIEW 1 before)
assert_rc 0 "$?" "core captures exact baseline for a readonly stage"
if [[ "$before" == "$STATE_DIR/"* ]]; then
  test_fail "readonly baseline stays outside provider-writable STATE_DIR" "$before"
else
  test_ok "readonly baseline stays outside provider-writable STATE_DIR"
fi
settings_file=$(_agent_settings REVIEW)
assert_eq "$CONTROL_DIR/agent-settings-REVIEW.json" "$settings_file" \
  "runner permission metadata also stays in the host control root"

# Правило сверяется по ПРЕФИКСУ команды, поэтому запускатель отмывает любой запрет:
# `timeout 60 git commit …` не совпадает ни с одной маской выше. Хуже — в личных настройках
# человека `Bash(timeout:*)` вполне может стоять в allow, а файл этапа ложится ПОВЕРХ них.
settings=$(cat "$settings_file")
for wrapper in 'timeout' 'env' 'xargs' 'nohup' 'setsid' 'stdbuf' 'nice' 'sudo' 'sh -c' 'bash -c'; do
  assert_contains "$settings" "\"Bash(${wrapper}:*)\"" \
    "readonly stage denies the ${wrapper} wrapper"
done
case "$settings" in
  *'"deny":['*'"Bash(git commit:*)"'*) test_ok "wrapper denies sit next to the writer denies" ;;
  *) test_fail "wrapper denies sit next to the writer denies" "$settings" ;;
esac

# Пишущему этапу обёртки нужны (сборка, тесты, e2e через скрипт профиля) — там их не режем.
case "$(cat "$(_agent_settings BUILD)")" in
  *'"Bash(timeout:*)"'*) test_fail "writable stage keeps its wrappers" "timeout denied for BUILD" ;;
  *) test_ok "writable stage keeps its wrappers" ;;
esac
_guard_readonly 7 REVIEW 1 "$before"
assert_rc 0 "$?" "unchanged readonly stage passes the guard"

printf 'грязное повторно изменено\n' >"$repo/source.txt"
_guard_readonly 7 REVIEW 1 "$before"
assert_rc 1 "$?" "readonly stage stops on content change of an already dirty file"
assert_file_exists "$CONTROL_DIR/guards/t7/REVIEW/try-1.diff" \
  "readonly violation keeps an audit summary"

export FACTORY_AUTOREVERT=1
profile_revert_files() {
  printf 'called\n' >"$TEST_ROOT/revert-called"
}
before=$(_readonly_guard_capture 7 REVIEW 2 before)
printf 'ещё одно изменение\n' >"$repo/source.txt"
_guard_readonly 7 REVIEW 2 "$before"
assert_rc 1 "$?" "legacy autorevert flag does not weaken transaction ownership"
assert_file_missing "$TEST_ROOT/revert-called" \
  "guard never overwrites files through legacy profile_revert_files"

profile_source_roots() {
  return 0
}
_readonly_guard_capture 7 REVIEW 3 before >/dev/null
assert_rc 2 "$?" "readonly stage fails closed when a profile has no source roots"

finish_tests
