#!/usr/bin/env bash
set -uo pipefail

source "$FACTORY_TESTS_HOME/lib/testlib.sh"

PROJECT_ROOT="$(cd "$FACTORY_HOME/.." && pwd)"
result="$TEST_ROOT/envelope.json"
host_root="${PROJECT_ROOT%%/Workspace/*}"
NODE_BIN="${NODE_BIN:-}"
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN=$(command -v node 2>/dev/null || true)
fi
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN=$(find "$host_root/.nvm/versions/node" /usr/local /opt \
    -type f -path '*/bin/node' 2>/dev/null | sort -V | tail -n 1)
fi

GITHUB_TOKEN='secret-trap-value' PROJECT_ROOT="$PROJECT_ROOT" RESULT_FILE="$result" \
  "$NODE_BIN" --input-type=module <<'NODE'
import { writeFile } from 'node:fs/promises';
const { createBuildEnvelope } = await import(
  `${process.env.PROJECT_ROOT}/server/src/lib/reviews/runner.js`
);

const cwd = `${process.env.TEST_ROOT || '/tmp'}/review-worktree`;
const envelope = createBuildEnvelope({
  reviewRunId: 'rr-envelope-contract',
  binding: { worktreePath: cwd, headSha: 'a'.repeat(40) },
  scope: [{ key: 'remark-1', versionId: 'v1', action: 'fix' }],
});
await writeFile(process.env.RESULT_FILE, JSON.stringify(envelope));
NODE
rc=$?
assert_rc 0 "$rc" "SEC-06: BUILD-envelope создаётся без model/push вызова"

raw=$(<"$result")
assert_contains "$raw" '"gitPush":false' "SEC-03: envelope запрещает git push"
assert_contains "$raw" '"githubMutation":false' "SEC-03: envelope запрещает GitHub mutation"
assert_contains "$raw" '"publisher":false' "SEC-05: publisher не передаётся агенту"
assert_contains "$raw" '"siblingWorktrees":false' "SEC-02: соседние worktree запрещены"
assert_contains "$raw" '"inheritHostEnvironment":false' "SEC-08: host env не наследуется"
if [[ "$raw" == *"secret-trap-value"* ]]; then
  test_fail "SEC-10: секрет не попадает в envelope" "обнаружено значение токена"
else
  test_ok "SEC-10: секрет не попадает в envelope"
fi

finish_tests
