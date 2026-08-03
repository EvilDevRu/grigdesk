#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/runners/kimi.sh"

# У kimi CLI нет argv-флага effort: раннер обязан применить запрошенный effort через
# per-run KIMI_CODE_HOME — копия config.toml с переписанной секцией [thinking],
# credentials/oauth symlink-ами на дефолтный home. Невалидное значение (CLI его молча
# нормализует в high, spike 2026-08-03) отвергается fail-closed до вызова модели.

default_home="$TEST_ROOT/kimi-default-home"
mkdir -p "$default_home/credentials" "$default_home/oauth"
cat >"$default_home/config.toml" <<'EOF'
default_model = "kimi-code/k3"

[providers."managed:kimi-code"]
type = "oauth"

[models."kimi-code/k3"]
support_efforts = [ "low", "high", "max" ]
default_effort = "high"

[thinking]
enabled = true
effort = "high"
EOF
export KIMI_CODE_HOME="$default_home"

CAPTURE_FILE="$TEST_ROOT/kimi-argv.tsv"
CAPTURE_ENV="$TEST_ROOT/kimi-home-env.txt"
factory_exec() {
  local kind=$1
  shift
  [[ "$kind" == provider ]] || return 2
  : >"$CAPTURE_FILE"
  local index=0 arg
  for arg in "$@"; do
    printf '%s\t%s\n' "$index" "$arg" >>"$CAPTURE_FILE"
    index=$((index + 1))
  done
  printenv KIMI_CODE_HOME >"$CAPTURE_ENV"
  return 0
}

run_dir="$TEST_ROOT/run-max"
mkdir -p "$run_dir"
runner_kimi_run 42 prompt BUILD k3 max 30 "$run_dir"
assert_rc 0 "$?" "supported effort max is accepted"
assert_eq "$run_dir/kimi-home" "$(cat "$CAPTURE_ENV")" "CLI runs with a per-run KIMI_CODE_HOME"
run_config=$(cat "$run_dir/kimi-home/config.toml")
assert_contains "$run_config" 'effort = "max"' "per-run config carries the requested effort"
assert_contains "$run_config" 'default_effort = "high"' "model blocks keep their default_effort untouched"
assert_eq "$default_home/credentials" "$(readlink "$run_dir/kimi-home/credentials")" \
  "credentials are symlinked to the default home"
assert_eq "$default_home/oauth" "$(readlink "$run_dir/kimi-home/oauth")" \
  "oauth state is symlinked to the default home"
argv=$(cut -f2- "$CAPTURE_FILE")
assert_contains "$argv" -- '-p' "prompt is passed as an argument"
grep -Fxq -- '--effort' <<<"$argv"
assert_rc 1 "$?" "no unsupported --effort flag is invented for argv"

# Конфиг без секции [thinking]: секция дописывается, а не ломает файл.
sed -i '/^\[thinking\]/,$d' "$default_home/config.toml"
run_dir="$TEST_ROOT/run-low"
mkdir -p "$run_dir"
runner_kimi_run 42 prompt BUILD k3 low 30 "$run_dir"
assert_rc 0 "$?" "supported effort low is accepted"
run_config=$(cat "$run_dir/kimi-home/config.toml")
assert_contains "$run_config" '[thinking]' "missing thinking section is appended"
assert_contains "$run_config" 'effort = "low"' "appended section carries the requested effort"

# Невалидный effort: CLI молча деградирует в high, поэтому раннер отказывает сам,
# до вызова модели (fail-closed, classify → unknown → STALLED с причиной в stderr).
rm -f "$CAPTURE_FILE"
run_dir="$TEST_ROOT/run-xhigh"
mkdir -p "$run_dir"
runner_kimi_run 42 prompt BUILD k3 xhigh 30 "$run_dir" >/dev/null 2>&1
assert_rc 4 "$?" "codex-style xhigh is rejected for kimi"
assert_file_missing "$CAPTURE_FILE" "invalid effort fails before provider execution"

# Пустой effort: конфиг копируется без правки [thinking] (наследуется дефолт home).
printf '[thinking]\nenabled = true\neffort = "high"\n' >>"$default_home/config.toml"
run_dir="$TEST_ROOT/run-inherit"
mkdir -p "$run_dir"
runner_kimi_run 42 prompt BUILD k3 '' 30 "$run_dir"
assert_rc 0 "$?" "empty effort means inherit the default home config"
run_config=$(cat "$run_dir/kimi-home/config.toml")
assert_contains "$run_config" 'effort = "high"' "inherited config keeps its original effort"

finish_tests
