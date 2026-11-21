#!/usr/bin/env bash
# Собирает кандидаты в отдельном каталоге и запускает поведенческие проверки.
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
directory="$(mktemp -d "${TMPDIR:-/tmp}/grigdesk-cli-tests.XXXXXXXX")"
trap 'rm -rf -- "$directory"' EXIT
directory="$(cd -- "$directory" && pwd -P)"
bash tools/build-go-utilities.sh "$directory"

tests=(
  tests/routes/commands.test.mts
  tests/routes/local.test.mts
  tests/routes/redirect.test.mts
  tests/tracker/install.test.mts
  tests/tracker/tracker-go.test.mts
  tests/tracker/pipeline-go.test.mts
  tests/tracker/pipelineArbiter.test.mts
  tests/tracker/pipelineAuth.test.mts
  tests/tracker/pipelineCancel.test.mts
  tests/tracker/pipelineControl.test.mts
  tests/tracker/pipelineFailures.test.mts
  tests/tracker/pipelineLaunch.test.mts
  tests/tracker/pipelineReads.test.mts
  tests/tracker/pipelineSettings.test.mts
  tests/tracker/pipelineWait.test.mts
  tests/voice/voice-go.test.mts
  tests/relay/client-channel.test.js
  tests/relay/network.test.js
  tests/relay/server.test.js
  tests/relay/binary/commands.test.js
  tests/relay/binary/network.test.js
)
if [[ "$(uname -s)" == Linux ]]; then
  tests+=(tests/relay/binary/process.test.js)
fi
GRIGDESK_GO_UTILITIES_TEST_BIN_DIR="$directory" NODE_TEST_MAX_RSS_MB=4096 \
  bash tests/run-node-tests-safe.sh --test --test-concurrency=2 "${tests[@]}"
