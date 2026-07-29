import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createReviewPublisher } from '../../server/src/lib/reviews/publisher.js';
import { createReviewRunner } from '../../server/src/lib/reviews/runner.js';

const exec = promisify(execFile);

async function git(cwd, ...args) {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Cockpit Test',
      GIT_AUTHOR_EMAIL: 'cockpit@example.invalid',
      GIT_COMMITTER_NAME: 'Cockpit Test',
      GIT_COMMITTER_EMAIL: 'cockpit@example.invalid',
    },
  });
  return stdout.trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const base = path.join(root, 'base.git');
  const fork = path.join(root, 'fork.git');
  await exec('git', ['init', '--bare', '--initial-branch=main', base]);
  await exec('git', ['init', '--bare', '--initial-branch=main', fork]);
  await exec('git', ['init', '--initial-branch=main', source]);
  await writeFile(path.join(source, 'value.txt'), 'base\n');
  await git(source, 'add', 'value.txt');
  await git(source, 'commit', '-m', 'base');
  await git(source, 'remote', 'add', 'base', base);
  await git(source, 'remote', 'add', 'fork', fork);
  await git(source, 'push', 'base', 'HEAD:refs/heads/main');
  await git(source, 'checkout', '-b', 'feature/review');
  await writeFile(path.join(source, 'value.txt'), 'review head\n');
  await git(source, 'commit', '-am', 'review head');
  await git(source, 'push', 'fork', 'HEAD:refs/heads/feature/review');
  // Одноимённая ветка в base ловит ошибочный выбор head-репозитория.
  await git(source, 'push', 'base', 'HEAD:refs/heads/feature/review');
  const headSha = await git(source, 'rev-parse', 'HEAD');
  const baseFeatureBefore = await git(source, 'ls-remote', base, 'refs/heads/feature/review');
  return {
    root, source, base, fork, headSha, baseFeatureBefore,
  };
}

async function forkOnlyFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-fork-head-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const local = path.join(root, 'local');
  const base = path.join(root, 'base.git');
  const fork = path.join(root, 'fork.git');
  await exec('git', ['init', '--bare', '--initial-branch=main', base]);
  await exec('git', ['init', '--bare', '--initial-branch=main', fork]);
  await exec('git', ['init', '--initial-branch=main', source]);
  await writeFile(path.join(source, 'value.txt'), 'base\n');
  await git(source, 'add', 'value.txt');
  await git(source, 'commit', '-m', 'base');
  await git(source, 'remote', 'add', 'base', base);
  await git(source, 'remote', 'add', 'fork', fork);
  await git(source, 'push', 'base', 'HEAD:refs/heads/main');
  await git(source, 'push', 'fork', 'HEAD:refs/heads/main');
  await git(source, 'checkout', '-b', 'feature/fork-only');
  await writeFile(path.join(source, 'value.txt'), 'fork head\n');
  await git(source, 'commit', '-am', 'fork head');
  await git(source, 'push', 'fork', 'HEAD:refs/heads/feature/fork-only');
  const headSha = await git(source, 'rev-parse', 'HEAD');
  await exec('git', ['clone', '--quiet', base, local]);
  return {
    root, source, local, base, fork, headSha,
  };
}

test('RB-05 PUBLISH-03/PUBLISH-04/PUBLISH-07: exact fork ref публикуется fast-forward с remote CAS', async (t) => {
  const fx = await fixture(t);
  const hooks = path.join(fx.root, 'malicious-hooks');
  const hookTrap = path.join(fx.root, 'pre-push-executed');
  await mkdir(hooks);
  await writeFile(
    path.join(hooks, 'pre-push'),
    `#!/bin/sh\nprintf attacked > ${JSON.stringify(hookTrap)}\nexit 99\n`,
  );
  await chmod(path.join(hooks, 'pre-push'), 0o755);
  await git(fx.source, 'config', 'core.hooksPath', hooks);
  const taskPipeline = path.join(fx.root, 'state', 't705.pipeline');
  await mkdir(path.dirname(taskPipeline), { recursive: true });
  await writeFile(taskPipeline, 'WF_STATUS=done\n');
  const beforePipeline = await readFile(taskPipeline, 'utf8');
  const runner = createReviewRunner({
    stateDir: path.join(fx.root, 'state'),
    worktreeRoot: path.join(fx.root, 'worktrees'),
    agentAdapter: {
      async run({ cwd }) {
        await writeFile(path.join(cwd, 'value.txt'), 'review fixed\n');
        return { ok: true, summary: 'fixture change', allowedPaths: ['value.txt'] };
      },
    },
    verifyCommands: [[process.execPath, '-e', 'process.exit(0)']],
  });
  let run = await runner.createRun({
    projectId: 'demo',
    repositoryId: 'frontend',
    prNumber: 17,
    repoPath: fx.source,
    headRepoUrl: fx.fork,
    headRef: 'refs/heads/feature/review',
    headSha: fx.headSha,
    snapshotDigest: 'snapshot-v1',
    snapshotVersion: 'v1',
  });
  run = await runner.approveScope(run.reviewRunId, {
    scope: [{ itemKey: 'item-1', itemVersion: 'v1', action: 'fix' }],
    scopeVersion: 'scope-v1',
    actor: 'user',
  });
  run = await runner.build(run.reviewRunId, { owner: 'builder' });
  run = await runner.verify(run.reviewRunId, { owner: 'verifier' });
  run = await runner.accept(run.reviewRunId, { actor: 'user' });

  const calls = [];
  const publisher = createReviewPublisher({
    store: runner.store,
    git: async (cwd, args, options) => {
      calls.push(args);
      return runner.git(cwd, args, options);
    },
  });
  const published = await publisher.publish({
    reviewRunId: run.reviewRunId,
    acceptanceDigest: run.acceptance.digest,
    actor: 'user',
  });

  assert.equal(published.status, 'published');
  assert.equal(
    await git(fx.source, 'ls-remote', fx.fork, 'refs/heads/feature/review'),
    `${run.candidate.commit}\trefs/heads/feature/review`,
  );
  assert.equal(
    await git(fx.source, 'ls-remote', fx.base, 'refs/heads/feature/review'),
    fx.baseFeatureBefore,
  );
  const push = calls.find((args) => args[0] === 'push');
  assert.ok(push.includes(fx.fork));
  assert.ok(push.includes(`${run.candidate.commit}:refs/heads/feature/review`));
  assert.ok(push.includes('--no-follow-tags'));
  assert.ok(push.includes('--recurse-submodules=no'));
  assert.ok(push.includes(
    `--force-with-lease=refs/heads/feature/review:${fx.headSha}`,
  ));
  assert.equal(await readFile(taskPipeline, 'utf8'), beforePipeline);
  await assert.rejects(access(hookTrap));
});

test('PUBLISH-05: настоящий Git отвергает продвижение fork после CAS', async (t) => {
  const fx = await fixture(t);
  const runner = createReviewRunner({
    stateDir: path.join(fx.root, 'state'),
    worktreeRoot: path.join(fx.root, 'worktrees'),
    agentAdapter: {
      async run({ cwd }) {
        await writeFile(path.join(cwd, 'value.txt'), 'candidate\n');
        return { ok: true, allowedPaths: ['value.txt'] };
      },
    },
    verifyCommands: [[process.execPath, '-e', 'process.exit(0)']],
  });
  let run = await runner.createRun({
    projectId: 'demo',
    repositoryId: 'frontend',
    prNumber: 17,
    repoPath: fx.source,
    headRepoUrl: fx.fork,
    headRef: 'refs/heads/feature/review',
    headSha: fx.headSha,
    snapshotDigest: 'snap',
    snapshotVersion: 'v1',
  });
  run = await runner.approveScope(run.reviewRunId, {
    scope: [{ itemKey: 'item', itemVersion: 'v1', action: 'fix' }],
    scopeVersion: 'scope',
    actor: 'user',
  });
  run = await runner.build(run.reviewRunId);
  run = await runner.verify(run.reviewRunId);
  run = await runner.accept(run.reviewRunId, { actor: 'user' });

  const publisher = createReviewPublisher({
    store: runner.store,
    beforePush: async () => {
      await git(fx.source, 'checkout', '-B', 'racer', fx.headSha);
      await writeFile(path.join(fx.source, 'race.txt'), 'race\n');
      await git(fx.source, 'add', 'race.txt');
      await git(fx.source, 'commit', '-m', 'racing update');
      await git(fx.source, 'push', fx.fork, 'HEAD:refs/heads/feature/review');
    },
  });
  const result = await publisher.publish({
    reviewRunId: run.reviewRunId,
    acceptanceDigest: run.acceptance.digest,
    actor: 'user',
  });

  assert.equal(result.status, 'stale');
  assert.equal(result.publication.reason, 'remote_head_changed');
  assert.equal(await git(fx.source, 'rev-parse', 'racer'), (
    await git(fx.source, 'ls-remote', fx.fork, 'refs/heads/feature/review')
  ).split('\t')[0]);
});

test('PUBLISH-05: exact CAS отвергает rewind remote к предку после preflight', async (t) => {
  const fx = await fixture(t);
  const ancestorSha = await git(fx.source, 'rev-parse', `${fx.headSha}^`);
  const runner = createReviewRunner({
    stateDir: path.join(fx.root, 'state'),
    worktreeRoot: path.join(fx.root, 'worktrees'),
    agentAdapter: {
      async run({ cwd }) {
        await writeFile(path.join(cwd, 'value.txt'), 'candidate after rewind\n');
        return { ok: true, allowedPaths: ['value.txt'] };
      },
    },
    verifyCommands: [[process.execPath, '-e', 'process.exit(0)']],
  });
  let run = await runner.createRun({
    projectId: 'demo',
    repositoryId: 'frontend',
    prNumber: 17,
    repoPath: fx.source,
    headRepoUrl: fx.fork,
    headRef: 'refs/heads/feature/review',
    headSha: fx.headSha,
    snapshotDigest: 'snap-rewind',
    snapshotVersion: 'v1',
  });
  run = await runner.approveScope(run.reviewRunId, {
    scope: [{ itemKey: 'item', itemVersion: 'v1', action: 'fix' }],
    scopeVersion: 'scope-rewind',
    actor: 'user',
  });
  run = await runner.build(run.reviewRunId);
  run = await runner.verify(run.reviewRunId);
  run = await runner.accept(run.reviewRunId, { actor: 'user' });

  const publisher = createReviewPublisher({
    store: runner.store,
    beforePush: async () => {
      await git(
        fx.source,
        'push',
        '--force',
        fx.fork,
        `${ancestorSha}:refs/heads/feature/review`,
      );
    },
  });
  const result = await publisher.publish({
    reviewRunId: run.reviewRunId,
    acceptanceDigest: run.acceptance.digest,
    actor: 'user',
  });

  assert.equal(result.status, 'stale');
  assert.equal(result.publication.reason, 'remote_head_changed');
  assert.equal(
    (await git(fx.source, 'ls-remote', fx.fork, 'refs/heads/feature/review')).split('\t')[0],
    ancestorSha,
  );
  assert.notEqual(ancestorSha, run.candidate.commit);
});

test('GATE-08: amend candidate после приёмки блокирует publish', async (t) => {
  const fx = await fixture(t);
  const runner = createReviewRunner({
    stateDir: path.join(fx.root, 'state'),
    worktreeRoot: path.join(fx.root, 'worktrees'),
    agentAdapter: {
      async run({ cwd }) {
        await writeFile(path.join(cwd, 'value.txt'), 'accepted candidate\n');
        return { ok: true, allowedPaths: ['value.txt'] };
      },
    },
    verifyCommands: [[process.execPath, '-e', 'process.exit(0)']],
  });
  let run = await runner.createRun({
    projectId: 'demo',
    repositoryId: 'frontend',
    prNumber: 17,
    repoPath: fx.source,
    headRepoUrl: fx.fork,
    headRef: 'refs/heads/feature/review',
    headSha: fx.headSha,
    snapshotDigest: 'snap',
    snapshotVersion: 'v1',
  });
  run = await runner.approveScope(run.reviewRunId, {
    scope: [{ itemKey: 'item', itemVersion: 'v1', action: 'fix' }],
    scopeVersion: 'scope',
    actor: 'user',
  });
  run = await runner.build(run.reviewRunId);
  run = await runner.verify(run.reviewRunId);
  run = await runner.accept(run.reviewRunId, { actor: 'user' });
  await writeFile(path.join(run.binding.worktreePath, 'tampered.txt'), 'after acceptance\n');
  await git(run.binding.worktreePath, 'add', 'tampered.txt');
  await git(run.binding.worktreePath, 'commit', '--amend', '--no-edit');

  const publisher = createReviewPublisher({ store: runner.store });
  const blocked = await publisher.publish({
    reviewRunId: run.reviewRunId,
    acceptanceDigest: run.acceptance.digest,
    actor: 'user',
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.failure.code, 'CANDIDATE_CHANGED');
  assert.equal(blocked.acceptance, null);
  assert.equal(blocked.publication, null);
  assert.equal(
    (await git(fx.source, 'ls-remote', fx.fork, 'refs/heads/feature/review')).split('\t')[0],
    fx.headSha,
  );
});

test('ISOLATE-01: runner fetch-ит exact SHA из fork, отсутствующий в local base clone', async (t) => {
  const fx = await forkOnlyFixture(t);
  assert.equal(
    await git(fx.local, 'cat-file', '-e', `${fx.headSha}^{commit}`).then(() => true, () => false),
    false,
  );
  const runner = createReviewRunner({
    stateDir: path.join(fx.root, 'state'),
    worktreeRoot: path.join(fx.root, 'worktrees'),
    agentAdapter: {
      async run({ cwd }) {
        await writeFile(path.join(cwd, 'fixed.txt'), 'fixed\n');
        return { ok: true, allowedPaths: ['fixed.txt'] };
      },
    },
  });
  let run = await runner.createRun({
    reviewRunId: 'rr-fork-fetch-exact',
    projectId: 'demo',
    repositoryId: 'frontend',
    prNumber: 21,
    repoPath: fx.local,
    headRepoUrl: fx.fork,
    headRef: 'refs/heads/feature/fork-only',
    headSha: fx.headSha,
    snapshotDigest: 'snap',
    snapshotVersion: 'v1',
  });
  run = await runner.approveScope(run.reviewRunId, {
    scope: [{ key: 'remark', versionId: 'v1', action: 'fix' }],
    scopeVersion: 'scope',
    actor: 'user',
  });
  run = await runner.build(run.reviewRunId);
  assert.equal(await git(run.binding.worktreePath, 'rev-parse', 'HEAD^'), fx.headSha);
});

test('FRESH-01: fetch обнаруживает смену fork head до BUILD', async (t) => {
  const fx = await forkOnlyFixture(t);
  const runner = createReviewRunner({
    stateDir: path.join(fx.root, 'state'),
    worktreeRoot: path.join(fx.root, 'worktrees'),
    agentAdapter: { async run() { return { ok: true }; } },
  });
  let run = await runner.createRun({
    reviewRunId: 'rr-fork-fetch-stale',
    projectId: 'demo',
    repositoryId: 'frontend',
    prNumber: 21,
    repoPath: fx.local,
    headRepoUrl: fx.fork,
    headRef: 'refs/heads/feature/fork-only',
    headSha: fx.headSha,
    snapshotDigest: 'snap',
    snapshotVersion: 'v1',
  });
  run = await runner.approveScope(run.reviewRunId, {
    scope: [{ key: 'remark', versionId: 'v1', action: 'fix' }],
    scopeVersion: 'scope',
    actor: 'user',
  });
  await writeFile(path.join(fx.source, 'new.txt'), 'new head\n');
  await git(fx.source, 'add', 'new.txt');
  await git(fx.source, 'commit', '-m', 'new fork head');
  await git(fx.source, 'push', fx.fork, 'HEAD:refs/heads/feature/fork-only');

  await assert.rejects(
    runner.build(run.reviewRunId),
    (error) => error.code === 'SNAPSHOT_STALE',
  );
  await assert.rejects(
    git(runner.worktreePath(run.reviewRunId), 'rev-parse', 'HEAD'),
  );
});
