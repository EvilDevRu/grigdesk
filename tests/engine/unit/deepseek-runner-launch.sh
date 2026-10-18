#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

runner="$FACTORY_HOME/lib/runners/deepseek.sh"
if [[ ! -f "$runner" ]]; then
  test_fail "DeepSeek launch contract has a runner" "missing $runner"
  finish_tests
  exit $?
fi
source "$runner"

mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/run" "$TEST_ROOT/additional"
fake_bin="$TEST_ROOT/bin/dsh"
printf '#!/usr/bin/env bash\nexit 0\n' >"$fake_bin"
chmod +x "$fake_bin"
export GRIGDESK_DEEPSEEK_BIN="$fake_bin"
export DEEPSEEK_API_KEY=synthetic-factory-key
export FACTORY_FORBID_LIVE=0

capture="$TEST_ROOT/argv"
factory_exec() {
  : >"$capture"
  printf '%s\n' "$@" >"$capture"
}

prompt='PROMPT_CANARY must travel only through a private file'
export FACTORY_ROUTE_FILESYSTEM_POLICY=state-only
runner_deepseek_run 42 "$prompt" CHECK \
  '["deepseek-official","deepseek-v4-flash"]' high 17 "$TEST_ROOT/run"
assert_rc 0 "$?" "state-only launch reaches the wrapper"
mapfile -t argv <"$capture"
assert_eq provider "${argv[0]}" "wrapper is classified as provider execution"
assert_eq timeout "${argv[1]}" "provider is bounded by GNU timeout"
assert_eq -k "${argv[2]}" "timeout has an explicit kill grace"
assert_eq 30 "${argv[3]}" "timeout kill grace is thirty seconds"
assert_eq 17 "${argv[4]}" "route timeout is preserved"
assert_eq "$NODE_BIN" "${argv[5]}" "pinned host Node launches the wrapper"
assert_contains "$(printf '%s ' "${argv[@]}")" 'server/scripts/deepseekRunner.mts' \
  "runner calls the dedicated wrapper"
assert_contains "$(printf '%s ' "${argv[@]}")" '--mode read-only' \
  "state-only maps to the DSH read-only sandbox"
assert_contains "$(printf '%s ' "${argv[@]}")" '--prompt-file' \
  "prompt is passed by filename"
if grep -Fq "$prompt" "$capture"; then
  test_fail "prompt content is absent from argv" "prompt leaked into $capture"
else
  test_ok "prompt content is absent from argv"
fi
prompt_file=$(awk 'previous == "--prompt-file" { print; exit } { previous=$0 }' "$capture")
assert_file_exists "$prompt_file" "private prompt file exists before wrapper execution"
assert_eq "$prompt" "$(cat "$prompt_file")" "prompt file preserves bytes"
assert_eq 600 "$(stat -c '%a' "$prompt_file")" "prompt file is private"

export FACTORY_ROUTE_FILESYSTEM_POLICY=workspace-write
runner_deepseek_run 42 write BUILD \
  '["deepseek-official","deepseek-v4-flash"]' max 19 "$TEST_ROOT/run"
assert_rc 0 "$?" "workspace-write launch reaches the wrapper"
assert_contains "$(tr '\n' ' ' <"$capture")" '--mode workspace-write' \
  "workspace-write remains project-writable without per-write hooks"

for unsupported in transactional-write ''; do
  export FACTORY_ROUTE_FILESYSTEM_POLICY="$unsupported"
  : >"$capture"
  runner_deepseek_run 42 reject CHECK \
    '["deepseek-official","deepseek-v4-flash"]' high 5 "$TEST_ROOT/run" >/dev/null 2>&1
  assert_rc 4 "$?" "unsupported filesystem policy '$unsupported' fails before launch"
  assert_eq '' "$(cat "$capture")" "unsupported filesystem policy invokes no process"
done

export FACTORY_ROUTE_FILESYSTEM_POLICY=workspace-write
for bad_model in '["deepseek-official","not-real"]'; do
  : >"$capture"
  runner_deepseek_run 42 reject CHECK "$bad_model" high 5 "$TEST_ROOT/run" >/dev/null 2>&1
  assert_rc 4 "$?" "unknown model fails before prompt"
  assert_eq '' "$(cat "$capture")" "unknown model invokes no process"
done
: >"$capture"
runner_deepseek_run 42 reject CHECK \
  '["deepseek-official","deepseek-v4-flash"]' impossible 5 "$TEST_ROOT/run" >/dev/null 2>&1
assert_rc 4 "$?" "unknown effort fails before prompt"
assert_eq '' "$(cat "$capture")" "unknown effort invokes no process"

export RUNNER_DEEPSEEK_ADD_DIRS="$TEST_ROOT/additional"
runner_deepseek_run 42 context CHECK \
  '["deepseek-official","deepseek-v4-flash"]' low 5 "$TEST_ROOT/run"
if grep -Fq "$TEST_ROOT/additional" "$capture"; then
  test_fail "additional roots never become DSH write roots" "path leaked into wrapper argv"
else
  test_ok "additional roots never become DSH write roots"
fi

# OFFLINE_GUARD must catch a provider binary even when a caller lies and labels it local.
unset -f factory_exec
source "$FACTORY_HOME/lib/executor.sh"
export FACTORY_FORBID_LIVE=1
factory_exec local "$fake_bin" >/dev/null 2>&1
assert_rc 126 "$?" "dsh basename is blocked even when mislabeled local"

finish_tests
