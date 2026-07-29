#!/usr/bin/env bash
set -uo pipefail

source "$FACTORY_TESTS_HOME/lib/testlib.sh"

PROJECT_ROOT="$(cd "$FACTORY_HOME/.." && pwd)"
host_root="${PROJECT_ROOT%%/Workspace/*}"
NODE_BIN="${NODE_BIN:-}"
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN=$(command -v node 2>/dev/null || true)
fi
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN=$(find "$host_root/.nvm/versions/node" /usr/local /opt \
    -type f -path '*/bin/node' 2>/dev/null | sort -V | tail -n 1)
fi
repo="$TEST_ROOT/work/repo"
mkdir -p "$repo"
git -C "$repo" init --initial-branch=main -q
git -C "$repo" config user.name "Cockpit Test"
git -C "$repo" config user.email "cockpit@example.invalid"
printf 'base\n' >"$repo/value.txt"
git -C "$repo" add value.txt
git -C "$repo" commit -qm base
head_sha=$(git -C "$repo" rev-parse HEAD)

PROJECT_ROOT="$PROJECT_ROOT" REPO="$repo" HEAD_SHA="$head_sha" \
  "$NODE_BIN" --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const { createReviewRunner } = await import(
  `${process.env.PROJECT_ROOT}/server/src/lib/reviews/runner.js`
);

async function makeRunner(id, commands) {
  const runner = createReviewRunner({
    stateDir: process.env.STATE_DIR,
    worktreeRoot: `${process.env.TEST_ROOT}/worktrees`,
    agentAdapter: {
      async run({ cwd }) {
        await writeFile(`${cwd}/${id}.txt`, 'fixed\n');
        return { ok: true, allowedPaths: [`${id}.txt`] };
      },
    },
    verifyCommands: commands,
  });
  let run = await runner.createRun({
    reviewRunId: id,
    projectId: 'demo',
    repositoryId: 'repo',
    prNumber: id.endsWith('green') ? 1 : 2,
    repoPath: process.env.REPO,
    headRepoUrl: process.env.REPO,
    headRef: 'refs/heads/main',
    headSha: process.env.HEAD_SHA,
    snapshotDigest: id,
    snapshotVersion: 'v1',
  });
  run = await runner.approveScope(id, {
    scope: [{
      key: `${id}-remark`,
      versionId: 'v1',
      action: 'fix',
      instruction: `Файл ${id}.txt создан и содержит исправление`,
    }],
    scopeVersion: 'scope',
    actor: 'test-user',
  });
  run = await runner.build(id);
  return { runner, run };
}

const green = await makeRunner('rr-verify-green', [
  {
    id: 'targeted-green',
    command: process.execPath,
    args: ['-e', "import('node:fs').then(fs=>process.exit(fs.existsSync('rr-verify-green.txt')?0:1))"],
    required: true,
    compareBaseline: true,
    itemKeys: ['rr-verify-green-remark'],
  },
]);
const verified = await green.runner.verify(green.run.reviewRunId);
assert.equal(verified.status, 'verified');
assert.equal(verified.verify.passed, true);
assert.match(verified.verify.digest, /^[0-9a-f]{64}$/);
assert.equal(verified.verify.report.schemaVersion, 2);
assert.equal(
  verified.verify.report.commands.find((item) => item.id === 'targeted-green').delta.classification,
  'resolved',
);
assert.equal(verified.verify.report.criteria[0].status, 'passed');
assert.deepEqual(verified.verify.report.links[0].commandIds, ['targeted-green']);
const accepted = await green.runner.accept(verified.reviewRunId, { actor: 'test-user' });
assert.equal(accepted.status, 'accepted');
assert.match(accepted.acceptance.digest, /^[0-9a-f]{64}$/);

const dirty = await makeRunner('rr-verify-dirty', [
  {
    id: 'targeted-dirty',
    command: process.execPath,
    args: ['-e', "import('node:fs/promises').then(fs=>fs.writeFile('surprise.txt','x'))"],
    required: true,
    itemKeys: ['rr-verify-dirty-remark'],
  },
]);
const rejected = await dirty.runner.verify(dirty.run.reviewRunId);
assert.equal(rejected.status, 'verification_failed');
assert.equal(rejected.verify.report.worktreeClean, false);
await assert.rejects(
  dirty.runner.accept(rejected.reviewRunId, { actor: 'test-user' }),
  (error) => error.code === 'VERIFY_REQUIRED',
);
NODE
rc=$?
assert_rc 0 "$rc" "VERIFY-02 VERIFY-03 VERIFY-06: зелёный отчёт принимается, мутация блокирует приёмку"

finish_tests
