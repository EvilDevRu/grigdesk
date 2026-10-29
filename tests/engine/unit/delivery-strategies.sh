#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

driver="$FACTORY_TESTS_HOME/fixtures/pipeline-sample-driver.mjs"

for strategy in commit merge pull-request; do
  "$NODE_BIN" "$driver" constructor "$strategy"
  assert_rc 0 "$?" "DS-01..03 factory-context: точные действия $strategy"
done

finish_tests
