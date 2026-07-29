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
base_sha=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" checkout -qb pr-one
printf 'one\n' >"$repo/value.txt"
git -C "$repo" commit -qam one
head_one=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" checkout -q main
git -C "$repo" checkout -qb pr-two
printf 'two\n' >"$repo/value.txt"
git -C "$repo" commit -qam two
head_two=$(git -C "$repo" rev-parse HEAD)
printf 'WF_STATUS=done\n' >"$STATE_DIR/t42.pipeline"
pipeline_before=$(<"$STATE_DIR/t42.pipeline")

PROJECT_ROOT="$PROJECT_ROOT" REPO="$repo" HEAD_ONE="$head_one" HEAD_TWO="$head_two" \
  "$NODE_BIN" --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const { createReviewRunner } = await import(
  `${process.env.PROJECT_ROOT}/server/src/lib/reviews/runner.js`
);

const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec('git', ['-C', cwd, ...args])).stdout.trim();
const runner = createReviewRunner({
  stateDir: process.env.STATE_DIR,
  worktreeRoot: `${process.env.TEST_ROOT}/worktrees`,
  agentAdapter: {
    async run({ cwd, run, envelope }) {
      assert.equal(envelope.capabilities.gitPush, false);
      await writeFile(`${cwd}/candidate-${run.reviewRunId}.txt`, `${run.reviewRunId}\n`);
      return { ok: true, allowedPaths: [`candidate-${run.reviewRunId}.txt`] };
    },
  },
});

async function build(id, number, headSha) {
  let run = await runner.createRun({
    reviewRunId: id,
    projectId: 'demo',
    repositoryId: 'repo',
    prNumber: number,
    repoPath: process.env.REPO,
    headRepoUrl: process.env.REPO,
    headRef: number === 1 ? 'refs/heads/pr-one' : 'refs/heads/pr-two',
    headSha,
    snapshotDigest: `snapshot-${number}`,
    snapshotVersion: 'v1',
  });
  run = await runner.approveScope(id, {
    scope: [{ key: `remark-${number}`, versionId: 'v1', action: 'fix' }],
    scopeVersion: 'scope-v1',
    actor: 'test-user',
  });
  return runner.build(id);
}

const one = await build('rr-isolation-one', 1, process.env.HEAD_ONE);
const two = await build('rr-isolation-two', 2, process.env.HEAD_TWO);
assert.notEqual(one.reviewRunId, two.reviewRunId);
assert.notEqual(one.binding.worktreePath, two.binding.worktreePath);
assert.notEqual(one.binding.candidateBranch, two.binding.candidateBranch);
assert.equal(await git(one.binding.worktreePath, 'rev-parse', 'HEAD^'), process.env.HEAD_ONE);
assert.equal(await git(two.binding.worktreePath, 'rev-parse', 'HEAD^'), process.env.HEAD_TWO);
assert.notEqual(one.candidate.commit, two.candidate.commit);
assert.equal(await readFile(`${process.env.STATE_DIR}/t42.pipeline`, 'utf8'), 'WF_STATUS=done\n');
NODE
rc=$?
assert_rc 0 "$rc" "ISOLATE-01 ISOLATE-02 RUN-01: два PR имеют exact base и не трогают t42.pipeline"
pipeline_after=$(<"$STATE_DIR/t42.pipeline")
assert_eq "$pipeline_before" "$pipeline_after" "RUN-01: task pipeline побайтово не изменён"
assert_file_exists "$STATE_DIR/review-runs/rr-isolation-one/state.json" "RUN-02: первый run имеет свой state"
assert_file_exists "$STATE_DIR/review-runs/rr-isolation-two/state.json" "RUN-02: второй run имеет свой state"

finish_tests
