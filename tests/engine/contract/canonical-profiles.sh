#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/profile-config.sh"

export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
mkdir -p "$FACTORY_PROFILES_DIR/fixture"
config="$FACTORY_PROFILES_DIR/fixture/runners.env"
cat >"$config" <<'EOF'
RUNNERS_SCHEMA=1
CONFIG_REVISION=1
PROJECT_RUNNER_PRIMARY=alpha
PROJECT_RUNNER_FAILOVER=beta
MODEL_DEFAULT_ALPHA_FAMILY=fixture
MODEL_DEFAULT_ALPHA_VERSION=latest
MODEL_DEFAULT_BETA_FAMILY=fixture
MODEL_DEFAULT_BETA_VERSION=latest
EOF
cat >"$FACTORY_PROFILES_DIR/fixture/profile.sh" <<'EOF'
#!/usr/bin/env bash
profile_stage_run() {
  return 0
}
EOF

profile_config_validate "$config"
assert_rc 0 "$?" "local canonical runner config validates"
assert_eq alpha "$(profile_config_get "$config" PROJECT_RUNNER_PRIMARY)" \
  "local profile selects its primary runner"
assert_eq beta "$(profile_config_get "$config" PROJECT_RUNNER_FAILOVER)" \
  "local profile selects its failover runner"

if grep -nF 'profile_stage_model()' \
  "$FACTORY_PROFILES_DIR"/*/profile.sh >"$TEST_ROOT/model-hooks"; then
  test_fail "profiles contain no runtime model hooks" "$(tr '\n' ' ' <"$TEST_ROOT/model-hooks")"
else
  test_ok "profiles contain no runtime model hooks"
fi

if grep -nE '\\.status|pipeline-set\\.sh.*(done|failed|skipped)' \
  "$FACTORY_PROFILES_DIR"/*/profile.sh >"$TEST_ROOT/status-contracts"; then
  test_fail "profiles contain no fixed or direct terminal status contract" \
    "$(tr '\n' ' ' <"$TEST_ROOT/status-contracts")"
else
  test_ok "profiles contain no fixed or direct terminal status contract"
fi

finish_tests
