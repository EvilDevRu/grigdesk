#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

project_root="$(cd "$FACTORY_HOME/.." && pwd)"
ignored_profiles="$project_root/profiles"

case "$FACTORY_PROFILES_DIR" in
  "$TEST_ROOT"/*)
    test_ok "offline suite receives only a worker-local profile directory" ;;
  *)
    test_fail "offline suite receives only a worker-local profile directory" \
      "FACTORY_PROFILES_DIR points outside TEST_ROOT: $FACTORY_PROFILES_DIR" ;;
esac

if [[ "$FACTORY_PROFILES_DIR" != "$ignored_profiles" ]]; then
  test_ok "offline suite is detached from the ignored repository profiles"
else
  test_fail "offline suite is detached from the ignored repository profiles" \
    "worker inherited the repository profile directory"
fi

if find "$FACTORY_PROFILES_DIR" -mindepth 1 -print -quit | grep -q .; then
  test_fail "worker profile directory starts empty" \
    "$(find "$FACTORY_PROFILES_DIR" -mindepth 1 -maxdepth 2 -print | tr '\n' ' ')"
else
  test_ok "worker profile directory starts empty"
fi

# Это не общий privacy-lint репозитория, а узкая страховка hermetic engine-suite:
# абсолютные пути рабочей машины и профильные helper-ы здесь появляться не должны.
absolute_workspace='/home/[[:alnum:]_.-]+/Workspace/'
if grep -RInE --exclude='offline-profile-isolation.sh' "$absolute_workspace" \
  "$FACTORY_TESTS_HOME" >"$TEST_ROOT/personalized-tests"; then
  test_fail "engine tests contain no host-bound workspace path" \
    "$(tr '\n' ' ' <"$TEST_ROOT/personalized-tests")"
else
  test_ok "engine tests contain no host-bound workspace path"
fi

direct_profile_exec='(source|python3|bash|node)[[:space:]].*FACTORY_PROFILES_DIR'
if grep -RInE --include='*.sh' --exclude='offline-profile-isolation.sh' \
  "$direct_profile_exec" "$FACTORY_TESTS_HOME" >"$TEST_ROOT/profile-exec"; then
  test_fail "common tests never execute helpers through FACTORY_PROFILES_DIR" \
    "$(tr '\n' ' ' <"$TEST_ROOT/profile-exec")"
else
  test_ok "common tests never execute helpers through FACTORY_PROFILES_DIR"
fi

python3 - "$FACTORY_TESTS_HOME" <<'PY'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
uuid_re = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
    re.IGNORECASE,
)
bad = []
for path in root.rglob("*"):
    if not path.is_file() or path.name == "offline-profile-isolation.sh":
        continue
    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        continue
    for line_no, line in enumerate(content.splitlines(), 1):
        for value in uuid_re.findall(line):
            if not value.startswith("00000000-0000-4000-8000-"):
                bad.append(f"{path.relative_to(root)}:{line_no}")

if bad:
    print("not ok 6 - engine fixtures use only visibly synthetic UUIDs")
    print("  ---")
    print("  message: " + " ".join(bad))
    print("  ...")
    raise SystemExit(1)
print("ok 6 - engine fixtures use only visibly synthetic UUIDs")
PY
uuid_rc=$?

# Python печатает шестую TAP-проверку сам; синхронизируем счётчик testlib.
TEST_COUNT=$((TEST_COUNT + 1))
(( uuid_rc == 0 )) || TEST_FAILED=$((TEST_FAILED + 1))

finish_tests
