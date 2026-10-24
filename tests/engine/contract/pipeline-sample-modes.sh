#!/usr/bin/env bash
set -uo pipefail
source "$FACTORY_TESTS_HOME/lib/testlib.sh"

driver="$FACTORY_TESTS_HOME/fixtures/pipeline-sample-driver.mjs"

"$NODE_BIN" "$driver" shared
assert_rc 0 "$?" 'SAMPLE-MODES: legacy shared services сохраняет обе ветки и чужой стенд'

"$NODE_BIN" "$driver" legacyPortless
assert_rc 0 "$?" 'SAMPLE-MODES: без opt-in прежнее требование двух портов сохраняется'

"$NODE_BIN" "$driver" isolated
assert_rc 0 "$?" 'SAMPLE-MODES-01/03 isolated none доходит до BUILD без scout и прогресса sandbox'

finish_tests
