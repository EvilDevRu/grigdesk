#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

if [[ ! -f "$FACTORY_HOME/lib/breaker.sh" ]]; then
  test_fail "breaker module exists" "missing lib/breaker.sh"
  finish_tests
  exit $?
fi
source "$FACTORY_HOME/lib/breaker.sh"

breaker_record claude acct-a model opus claude-opus-5 100 300 fixture-model
assert_rc 0 "$?" "model limit is recorded"
breaker_record claude acct-a family sonnet "" 101 300 fixture-family
assert_rc 0 "$?" "family limit coexists"

count=$(find "$STATE_DIR/runners/breakers/v1/claude/acct-a" -name '*.state' | wc -l)
assert_eq 2 "$count" "independent scopes do not overwrite each other"

breaker_match claude acct-a opus claude-opus-5 200
assert_rc 0 "$?" "matching model is limited"
assert_eq model "$BREAKER_MATCH_SCOPE" "model scope is reported"

breaker_match claude acct-a fable claude-fable-1 200
assert_rc 1 "$?" "unrelated family remains available"

breaker_match claude acct-b opus claude-opus-5 200
assert_rc 1 "$?" "another account fingerprint is isolated"

breaker_record claude acct-a provider "" "" 110 250 fixture-provider
breaker_match claude acct-a fable claude-fable-1 200
assert_rc 0 "$?" "provider limit covers every family"
assert_eq provider "$BREAKER_MATCH_SCOPE" "provider scope has precedence"

breaker_match claude acct-a opus claude-opus-5 260
assert_rc 0 "$?" "expired provider reveals still-active model limit"
assert_eq model "$BREAKER_MATCH_SCOPE" "scope falls back after provider expiry"

breaker_clear claude acct-a model opus claude-opus-5
assert_rc 0 "$?" "exact breaker entry clears"
breaker_match claude acct-a opus claude-opus-5 260
assert_rc 1 "$?" "cleared model is available"
breaker_match claude acct-a sonnet claude-sonnet-1 260
assert_rc 0 "$?" "clearing model does not clear family entry"

for family in alpha beta gamma delta; do
  breaker_record codex acct-z family "$family" "" 120 500 "parallel-$family" &
done
wait
count=$(find "$STATE_DIR/runners/breakers/v1/codex/acct-z" -name '*.state' | wc -l)
assert_eq 4 "$count" "parallel breaker merge loses no entries"

finish_tests
