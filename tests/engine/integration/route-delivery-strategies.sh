#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

driver="$FACTORY_TESTS_HOME/fixtures/pipeline-sample-driver.mjs"

for strategy in commit merge pull-request; do
  "$NODE_BIN" "$driver" guard "$strategy"
  assert_rc 0 "$?" "DS-01..03 runtime: exact actions и approved $strategy"
done

"$NODE_BIN" "$driver" pin
assert_rc 0 "$?" 'DS-04 resume сохраняет стратегию и отвергает повреждённый pin'

finish_tests
