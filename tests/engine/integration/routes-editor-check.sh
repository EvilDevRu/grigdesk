#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

route_tool="$FACTORY_HOME/bin/factory-route"
fixture_file="$FACTORY_TESTS_HOME/../fixtures/routes-editor.mjs"

editor_input=$("$NODE_BIN" --input-type=module -e '
import { pathToFileURL } from "node:url";
const { makeCatalogInput } = await import(pathToFileURL(process.argv[1]));
process.stdout.write(JSON.stringify(makeCatalogInput()));
' "$fixture_file")

# RE-C1-01: редактор получает чистый каталог через stdin без current и routesDir.
checked=$(printf '%s' "$editor_input" | "$route_tool" --profile sample editor-check 2>&1)
checked_rc=$?
assert_rc 0 "$checked_rc" "RE-C1-01: корректный каталог проходит без current"
assert_contains "$checked" '"ok": true' "RE-C1-01: ответ содержит ok=true"
assert_contains "$checked" '"issues": []' "RE-C1-01: список проблем пуст"

make_invalid() {
  local variant=$1
  printf '%s' "$editor_input" | "$NODE_BIN" -e '
let input = "";
process.stdin.on("data", (part) => { input += part; });
process.stdin.on("end", () => {
  const value = JSON.parse(input);
  if (process.argv[1] === "profile") value.bootstrap.profile = "other";
  if (process.argv[1] === "field") value.routes.quick.route.model = "forbidden";
  if (process.argv[1] === "transition") value.routes.quick.route.nodes[0].on.done = null;
  process.stdout.write(JSON.stringify(value));
});
' "$variant"
}

# RE-C1-02: отсутствие профиля, лишнее поле и null дают предметные ошибки.
for variant in profile field transition; do
  rejected=$(make_invalid "$variant" | "$route_tool" --profile sample editor-check 2>&1)
  rejected_rc=$?
  assert_contains "$rejected" '"ok": false' "RE-C1-02: $variant отклонён JSON-ответом"
  assert_contains "$rejected" '"path":' "RE-C1-02: $variant имеет адрес проблемы"
  if [[ "$rejected_rc" -eq 0 ]]; then
    test_fail "RE-C1-02: $variant имеет ненулевой код" "exit=0"
  else
    test_ok "RE-C1-02: $variant имеет ненулевой код"
  fi
done

malformed=$(printf '{' | "$route_tool" --profile sample editor-check 2>&1)
if [[ "$malformed" == *"Traceback"* || "$malformed" == *"$TEST_ROOT"* ]]; then
  test_fail "RE-C1-02: битый JSON не раскрывает traceback или путь" "$malformed"
else
  test_ok "RE-C1-02: битый JSON не раскрывает traceback или путь"
fi

# RE-C1-03: ни profile.sh, ни provider, ни каталог runtime не затрагиваются.
mkdir -p "$TEST_ROOT/profiles/sample-profile"
printf 'touch "%s"\n' "$TEST_ROOT/profile-sourced" > "$TEST_ROOT/profiles/sample-profile/profile.sh"
before=$(find "$TEST_ROOT" -type f -printf '%P\n' | sort)
printf '%s' "$editor_input" | "$route_tool" --profile sample editor-check >/dev/null 2>&1
after=$(find "$TEST_ROOT" -type f -printf '%P\n' | sort)
assert_eq "$before" "$after" "RE-C1-03: проверка не создала файлов"
assert_file_missing "$TEST_ROOT/profile-sourced" "RE-C1-03: профильный shell не исполнен"
assert_file_missing "$TEST_ROOT/routes" "RE-C1-03: runtime routesDir не создан"

finish_tests
