#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"
source "$FACTORY_HOME/lib/runners/catalog.sh"
source "$FACTORY_HOME/lib/runners/codex.sh"

export FACTORY_CODEX_MODEL_CACHE="$TEST_ROOT/models_cache.json"
printf '%s\n' \
  '{"models":[' \
  '{"slug":"gpt-5.5-sol","visibility":"list","priority":7},' \
  '{"slug":"gpt-5.6-sol","visibility":"list","priority":1},' \
  '{"slug":"gpt-5.6-terra","visibility":"list","priority":2},' \
  '{"slug":"hidden-model","visibility":"hide","priority":0}' \
  ']}' >"$FACTORY_CODEX_MODEL_CACHE"

catalog="$TEST_ROOT/codex.models.tsv"
runner_codex_catalog >"$catalog"
assert_rc 0 "$?" "Codex catalog is read from local CLI metadata without a model call"
assert_contains "$(cat "$catalog")" $'gpt-5.6-sol\tcodex\tsol\t5.6' \
  "Codex model slug is normalized to family and version"

snapshot="$TEST_ROOT/snapshot"
mkdir -p "$snapshot"
cp "$catalog" "$snapshot/models.tsv"
actual=$(catalog_resolve "$snapshot" codex sol latest auto 1.0.0)
assert_rc 0 "$?" "Codex family latest resolves from local catalog"
assert_eq gpt-5.6-sol "$actual" "latest sol selects current highest-priority model"

assert_eq 3 "$(wc -l <"$catalog")" "hidden and malformed cache entries are excluded"

finish_tests
