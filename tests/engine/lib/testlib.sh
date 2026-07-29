#!/usr/bin/env bash

TEST_COUNT=0
TEST_FAILED=0

test_note() {
  printf '# %s\n' "$*"
}

test_ok() {
  TEST_COUNT=$((TEST_COUNT + 1))
  printf 'ok %d - %s\n' "$TEST_COUNT" "$1"
}

test_fail() {
  TEST_COUNT=$((TEST_COUNT + 1))
  TEST_FAILED=$((TEST_FAILED + 1))
  printf 'not ok %d - %s\n' "$TEST_COUNT" "$1"
  [[ -z "${2:-}" ]] || printf '  ---\n  message: %s\n  ...\n' "$2"
}

assert_eq() {
  local expected=$1 actual=$2 name=$3
  if [[ "$actual" == "$expected" ]]; then
    test_ok "$name"
  else
    test_fail "$name" "expected=[$expected] actual=[$actual]"
  fi
}

assert_rc() {
  local expected=$1 actual=$2 name=$3
  assert_eq "$expected" "$actual" "$name"
}

assert_contains() {
  local haystack=$1 needle=$2 name=$3
  if [[ "$haystack" == *"$needle"* ]]; then
    test_ok "$name"
  else
    test_fail "$name" "missing=[$needle] in=[$haystack]"
  fi
}

assert_file_exists() {
  local path=$1 name=$2
  if [[ -f "$path" ]]; then
    test_ok "$name"
  else
    test_fail "$name" "file does not exist: $path"
  fi
}

assert_file_missing() {
  local path=$1 name=$2
  if [[ ! -e "$path" ]]; then
    test_ok "$name"
  else
    test_fail "$name" "path still exists: $path"
  fi
}

finish_tests() {
  if (( TEST_FAILED > 0 )); then
    printf '1..%d\n' "$TEST_COUNT"
    printf '# failed: %d\n' "$TEST_FAILED"
    return 1
  fi
  printf '1..%d\n' "$TEST_COUNT"
  return 0
}
