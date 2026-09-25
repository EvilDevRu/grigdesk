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

# Целая версия не должна исчезать из каталога: иначе новое семейство недоступно,
# а latest существующего семейства молча остаётся на старой дробной версии.
cat >"$FACTORY_CODEX_MODEL_CACHE" <<'JSON'
{"models":[
  {"slug":"gpt-6-astra","visibility":"list","priority":1},
  {"slug":"gpt-6-sol","visibility":"list","priority":2},
  {"slug":"gpt-6-luna","visibility":"list","priority":3},
  {"slug":"gpt-5.6-sol","visibility":"list","priority":4},
  {"slug":"gpt-5.6-terra","visibility":"list","priority":7},
  {"slug":"gpt-5.6-luna","visibility":"list","priority":8},
  {"slug":"gpt-6-hidden","visibility":"hide","priority":0},
  {"slug":"gpt-6-negative","visibility":"list","priority":-1},
  {"slug":"gpt-6-string-priority","visibility":"list","priority":"0"},
  {"slug":"gpt-6..1-invalid","visibility":"list","priority":0},
  {"slug":"gpt-6.-invalid","visibility":"list","priority":0},
  {"slug":"gpt-6","visibility":"list","priority":0}
]}
JSON

runner_codex_catalog >"$catalog"
assert_rc 0 "$?" "Каталог с целыми и дробными версиями читается без вызова модели"
assert_contains "$(cat "$catalog")" $'gpt-6-astra\tcodex\tastra\t6\tdefault' \
  "Целая версия сохраняет семейство ASTRA"
assert_eq 6 "$(wc -l <"$catalog")" "Скрытые и некорректные записи по-прежнему исключены"
cp "$catalog" "$snapshot/models.tsv"

for family in astra sol luna; do
  actual=$(catalog_resolve "$snapshot" codex "$family" latest auto 0.156.1)
  assert_rc 0 "$?" "Семейство $family/latest разрешается из каталога"
  assert_eq "gpt-6-$family" "$actual" "Семейство $family/latest выбирает актуальную модель"
done

actual=$(catalog_resolve "$snapshot" codex sol 5.6 auto 0.156.1)
assert_rc 0 "$?" "Явная дробная версия остаётся доступной"
assert_eq gpt-5.6-sol "$actual" "Закреплённая версия не подменяется новой"

actual=$(catalog_resolve_exact "$snapshot" codex gpt-6-astra 0.156.1)
assert_rc 0 "$?" "Exact id с целой версией разрешается"
assert_eq gpt-6-astra "$actual" "Exact id сохраняется без подмены"

actual=$(catalog_resolve "$snapshot" codex missing latest auto 0.156.1)
assert_rc 4 "$?" "Отсутствующее семейство остаётся недоступным"
assert_eq no_candidate "$actual" "Другое семейство не выбирается скрытым fallback"

finish_tests
