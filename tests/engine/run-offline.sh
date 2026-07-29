#!/usr/bin/env bash
set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FACTORY_HOME="$PROJECT_ROOT/engine"
FACTORY_TESTS_HOME="$PROJECT_ROOT/tests/engine"
TEST_FILTER="${1:-}"
RC=0
CURRENT_TEST_ROOT=""

cleanup_test_root() {
  case "${CURRENT_TEST_ROOT:-}" in
    /tmp/factory-offline.*)
      [[ -d "$CURRENT_TEST_ROOT" ]] && rm -rf -- "$CURRENT_TEST_ROOT"
      ;;
  esac
  CURRENT_TEST_ROOT=""
}
trap cleanup_test_root EXIT INT TERM

mapfile -t TEST_FILES < <(
  find "$FACTORY_TESTS_HOME/characterization" \
       "$FACTORY_TESTS_HOME/unit" \
       "$FACTORY_TESTS_HOME/contract" \
       "$FACTORY_TESTS_HOME/integration" \
       "$FACTORY_TESTS_HOME/race" \
       -maxdepth 1 -type f -name '*.sh' 2>/dev/null | sort
)

if [[ -n "$TEST_FILTER" ]]; then
  mapfile -t TEST_FILES < <(printf '%s\n' "${TEST_FILES[@]}" | grep "$TEST_FILTER" || true)
fi

if [[ ${#TEST_FILES[@]} -eq 0 ]]; then
  echo "нет offline-тестов${TEST_FILTER:+ по фильтру $TEST_FILTER}" >&2
  exit 2
fi

for test_file in "${TEST_FILES[@]}"; do
  cleanup_test_root
  test_root=$(mktemp -d /tmp/factory-offline.XXXXXX)
  CURRENT_TEST_ROOT="$test_root"
  mkdir -p "$test_root/config" "$test_root/state" "$test_root/xdg-config" \
    "$test_root/xdg-state" "$test_root/xdg-cache" "$test_root/work"
  echo "── ${test_file#"$PROJECT_ROOT/"}"
  env -i \
    PATH="$FACTORY_TESTS_HOME/fakes/bin:/usr/bin:/bin" \
    LC_ALL=C \
    FACTORY_HOME="$FACTORY_HOME" \
    FACTORY_PROFILES_DIR="$PROJECT_ROOT/profiles" \
    FACTORY_TESTS_HOME="$FACTORY_TESTS_HOME" \
    FACTORY_TESTING=1 \
    FACTORY_FORBID_LIVE=1 \
    TEST_REPEAT="${TEST_REPEAT:-5}" \
    FACTORY_CONFIG_ROOT="$test_root/config" \
    FACTORY_STATE="$test_root/state" \
    STATE_DIR="$test_root/state" \
    XDG_CONFIG_HOME="$test_root/xdg-config" \
    XDG_STATE_HOME="$test_root/xdg-state" \
    XDG_CACHE_HOME="$test_root/xdg-cache" \
    TEST_ROOT="$test_root" \
    bash --noprofile --norc "$test_file" || RC=1
  cleanup_test_root
done

exit "$RC"
