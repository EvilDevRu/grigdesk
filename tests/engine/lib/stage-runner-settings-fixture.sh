#!/usr/bin/env bash
# Изолированный профиль и trusted attempt создаются штатными командами движка.
# Только адаптеры моделей синтетические: storage, CAS, запуск и сигналы настоящие.
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

settings_fixture() {
  export FACTORY_RUNNERS_DIR="$TEST_ROOT/runners"
  export FACTORY_PROFILES_DIR="$TEST_ROOT/profiles"
  mkdir -p "$FACTORY_RUNNERS_DIR" "$FACTORY_PROFILES_DIR/demo-profile" "$TEST_ROOT/work"
  cp "$FACTORY_TESTS_HOME/fakes/runners/alpha.sh" "$FACTORY_RUNNERS_DIR/alpha.sh"
  cp "$FACTORY_TESTS_HOME/fakes/runners/beta.sh" "$FACTORY_RUNNERS_DIR/beta.sh"
  cat >>"$FACTORY_RUNNERS_DIR/alpha.sh" <<'RUNNER'
runner_alpha_catalog() {
  printf '%s\n' \
    $'alpha-model\talpha\tfixture\t1\tdefault\t100\t1\t0\t1\t0.0.0\t999.0.0' \
    $'alpha-strong\talpha\tfixture\t2\tdefault\t90\t1\t0\t1\t0.0.0\t999.0.0'
}
runner_alpha_family_alias() {
  [[ "$1" == default || "$1" == strong ]]
}
runner_alpha_model_options() {
  [[ "${SETTINGS_METADATA_UNAVAILABLE:-0}" != 1 ]] || return 4
  printf '%s\n' '{"schema":1,"models":[
    {"id":"alpha-model","label":"Alpha","efforts":["low","high"],"aliases":["default"]},
    {"id":"alpha-strong","label":"Strong","efforts":["high","max",""],"aliases":["strong"]}]}'
}
RUNNER
  cat >>"$FACTORY_RUNNERS_DIR/beta.sh" <<'RUNNER'
runner_beta_model_options() {
  printf '%s\n' '{"schema":1,"models":[{"id":"beta-model","label":"Beta","efforts":["high"]}]}'
}
RUNNER
  sed 's/beta/gamma/g' "$FACTORY_RUNNERS_DIR/beta.sh" >"$FACTORY_RUNNERS_DIR/gamma.sh"
  cat >>"$FACTORY_RUNNERS_DIR/gamma.sh" <<'RUNNER'
runner_gamma_catalog() {
  printf '%s\n' $'["route","model"]\tgamma\tfixture\t1\tdefault\t100\t1\t0\t1\t0.0.0\t999.0.0'
}
runner_gamma_model_options() {
  printf '%s\n' '{"schema":1,"models":[{"id":"[\"route\",\"model\"]","efforts":["off","high"]}]}'
}
RUNNER
  # Захват идёт внутри настоящего provider child после launch barrier.
  # Существующий fake сохраняет семантический stage-result и классификацию отказа.
  for provider in alpha beta gamma; do
    python3 - "$FACTORY_RUNNERS_DIR/$provider.sh" "$provider" <<'PYTHON'
from pathlib import Path
import sys

file = Path(sys.argv[1])
provider = sys.argv[2]
marker = f"runner_{provider}_run() {{"
capture = (
    "  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "
    + f"'{provider}' "
    + '"$4" "$5" "$FACTORY_RUN_ID" "$FACTORY_RUN_EPOCH" >>"$TEST_ROOT/argv.tsv"'
)
file.write_text(file.read_text().replace(marker, marker + "\n" + capture, 1))
PYTHON
  done

  config="$FACTORY_PROFILES_DIR/demo-profile/runners.env"
  printf '%s\n' \
    RUNNERS_SCHEMA=1 CONFIG_REVISION=1 PROJECT_RUNNER_PRIMARY=alpha PROJECT_RUNNER_FAILOVER=beta \
    MODEL_DEFAULT_ALPHA_FAMILY=fixture MODEL_DEFAULT_ALPHA_VERSION=latest \
    MODEL_DEFAULT_ALPHA_EXACT=alpha-model MODEL_DEFAULT_ALPHA_EFFORT=high \
    MODEL_DEFAULT_BETA_FAMILY=fixture MODEL_DEFAULT_BETA_VERSION=latest \
    MODEL_DEFAULT_BETA_EXACT=beta-model MODEL_DEFAULT_BETA_EFFORT=high >"$config"
  printf 'PROFILE_NAME=demo-profile\n' >"$FACTORY_PROFILES_DIR/demo-profile/profile.sh"
  PROFILE_NAME=demo-profile
  PROFILE_AGENT_CWD="$TEST_ROOT/work"
  PROFILE_AGENT_DIRS="$TEST_ROOT/work"
  source "$FACTORY_HOME/lib/core.sh"
  source "$FACTORY_HOME/lib/attempt-state.sh"
  routes_dir="$TEST_ROOT/routes"
  published=$("$NODE_BIN" "$FACTORY_TESTS_HOME/fixtures/routes-catalog-publish.mjs" "$routes_dir" null)
  [[ $? == 0 ]] || return 78
  catalog_hash=$(jq -r .catalogHash <<<"$published")
  route_hash=$(jq -r .routeHashes.feature <<<"$published")
  attempt=$(attempt_state_begin_v2 81 demo-profile "$routes_dir" "$catalog_hash") || return
  attempt_state_select_route_v2 81 "$attempt" feature >/dev/null || return
  attempt_lifecycle_init_v2 81 "$attempt" || return
  attempt_dir="$(attempt_state_v2_task_root 81)/attempts/$attempt"
  pipeline_store_route_init 81 PLAN PROFILE demo-profile ATTEMPT_ID "$attempt" \
    ROUTE feature ROUTE_HASH "$route_hash" CATALOG_HASH "$catalog_hash" \
    CATALOG_PROTOCOL route-v2 WF_STATUS stopped
  export FACTORY_LIFECYCLE_ATTEMPT_ID="$attempt"
  export FACTORY_LIFECYCLE_NODE_ID=plan
  export FACTORY_LIFECYCLE_RUN_KEY=PLAN
  : >"$TEST_ROOT/invocations"
  : >"$TEST_ROOT/argv.tsv"
  export FAKE_ALPHA_RESULT=done
}
