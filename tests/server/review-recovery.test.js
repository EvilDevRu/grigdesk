import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { createReviewRunner, defaultGit } from '../../server/src/lib/reviews/runner.js';

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-review-recover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await exec('git', ['init', '--initial-branch=main', repo]);
  await writeFile(path.join(repo, 'base.txt'), 'base\n');
  await git(repo, 'add', 'base.txt');
  await git(repo, 'commit', '-m', 'base');
  return { root, repo, headSha: await git(repo, 'rev-parse', 'HEAD') };
}

async function approvedRunner(t, adapter, {
  scope = [{ itemKey: 'item', itemVersion: 'v1', action: 'fix' }],
  verifyCommands = [[process.execPath, '-e', 'process.exit(0)']],
  runnerOptions = {},
} = {}) {
  const fx = await fixture(t);
  const runner = createReviewRunner({
    stateDir: path.join(fx.root, 'state'),
    worktreeRoot: path.join(fx.root, 'worktrees'),
    agentAdapter: adapter,
    verifyCommands,
    ...runnerOptions,
  });
  let run = await runner.createRun({
    projectId: 'demo',
    repositoryId: 'repo',
    prNumber: 1,
    repoPath: fx.repo,
    headRepoUrl: fx.repo,
    headRef: 'refs/heads/main',
    headSha: fx.headSha,
    snapshotDigest: 'snap',
    snapshotVersion: 'v1',
  });
  run = await runner.approveScope(run.reviewRunId, {
    scope,
    scopeVersion: 'scope',
    actor: 'user',
  });
  return { ...fx, runner, run };
}

test('RECOVER-01: сбой BUILD с грязным worktree требует человека и не пишет поверх', async (t) => {
  const fx = await approvedRunner(t, {
    async run() {
      throw new Error('В этом тесте BUILD не запускается');
    },
  });
  const prepared = await fx.runner.prepare(fx.run.reviewRunId, { owner: 'worker' });
  await fx.runner.store.update(fx.run.reviewRunId, (state) => ({
    ...state,
    status: 'building',
  }));
  const lease = await fx.runner.store.acquireLease(fx.run.reviewRunId, {
    owner: 'crashed-worker',
    now: 100,
    ttlMs: 10,
  });
  await writeFile(path.join(prepared.binding.worktreePath, 'half-written.txt'), 'partial\n');

  assert.equal(lease.lease.expiresAt, 110);
  const recovered = await fx.runner.recover(fx.run.reviewRunId, { now: 111 });
  assert.equal(recovered.status, 'blocked');
  assert.equal(recovered.recovery.reason, 'build_result_unknown_dirty_worktree');
  assert.equal(await git(prepared.binding.worktreePath, 'status', '--porcelain'), '?? half-written.txt');
});

test('RECOVER-01 SEC-02: commit без durable path journal остаётся заблокированным', async (t) => {
  const fx = await approvedRunner(t, {
    async run() {
      throw new Error('В этом тесте BUILD не запускается');
    },
  }, {
    scope: [{
      itemKey: 'item',
      itemVersion: 'v1',
      action: 'fix',
      allowedPaths: ['allowed.txt'],
    }],
  });
  const prepared = await fx.runner.prepare(fx.run.reviewRunId, { owner: 'worker' });
  const worktree = prepared.binding.worktreePath;
  await writeFile(path.join(worktree, 'outside-scope.txt'), 'fixed\n');
  await git(worktree, 'add', 'outside-scope.txt');
  await git(worktree, 'commit', '-m', `Cockpit review ${fx.run.reviewRunId}`);
  const commit = await git(worktree, 'rev-parse', 'HEAD');
  await fx.runner.store.update(fx.run.reviewRunId, (state) => ({
    ...state,
    status: 'building',
  }));
  await fx.runner.store.acquireLease(fx.run.reviewRunId, {
    owner: 'crashed-worker',
    now: 100,
    ttlMs: 10,
  });

  const recovered = await fx.runner.recover(fx.run.reviewRunId, { now: 111 });
  assert.equal(recovered.status, 'blocked');
  assert.equal(recovered.recovery.reason, 'build_commit_unjournaled');
  assert.equal(recovered.candidate, null);
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), commit);
  assert.equal(await git(worktree, 'rev-list', '--count', `${fx.headSha}..HEAD`), '1');
});

test('RECOVER-RACE-01: поздний recover не затирает более новую revision', async (t) => {
  let recoveryInspection = false;
  let entered;
  let release;
  const inside = new Promise((resolve) => { entered = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  let stopped = false;
  const fx = await approvedRunner(t, {
    async run() {
      throw new Error('В этом тесте BUILD не запускается');
    },
  }, {
    runnerOptions: {
      git: async (cwd, args, options) => {
        if (recoveryInspection && !stopped && args[0] === 'status') {
          stopped = true;
          entered();
          await barrier;
        }
        return defaultGit(cwd, args, options);
      },
    },
  });
  await fx.runner.prepare(fx.run.reviewRunId, { owner: 'worker' });
  await fx.runner.store.update(fx.run.reviewRunId, (state) => ({
    ...state,
    status: 'provisioning',
  }));
  await fx.runner.store.acquireLease(fx.run.reviewRunId, {
    owner: 'crashed-worker',
    now: 100,
    ttlMs: 10,
  });

  recoveryInspection = true;
  const lateRecovery = fx.runner.recover(fx.run.reviewRunId, { now: 111 });
  await inside;
  const newer = await fx.runner.store.update(fx.run.reviewRunId, (state) => ({
    ...state,
    status: 'failed',
    failure: { code: 'NEWER_WORKER_RESULT' },
    lease: null,
  }));
  release();

  await assert.rejects(
    lateRecovery,
    (error) => error.code === 'STATE_REVISION_STALE',
  );
  const current = await fx.runner.getRun(fx.run.reviewRunId);
  assert.equal(current.revision, newer.revision);
  assert.equal(current.status, 'failed');
  assert.equal(current.failure.code, 'NEWER_WORKER_RESULT');
});

test('RECOVER-01: VERIFY повторяется только для неизменного candidate tree', async (t) => {
  const fx = await approvedRunner(t, {
    async run({ cwd }) {
      await writeFile(path.join(cwd, 'fixed.txt'), 'fixed\n');
      return { ok: true, allowedPaths: ['fixed.txt'] };
    },
  });
  let run = await fx.runner.build(fx.run.reviewRunId);
  run = await fx.runner.store.update(run.reviewRunId, (state) => ({
    ...state,
    status: 'verifying',
  }));
  await fx.runner.store.acquireLease(run.reviewRunId, {
    owner: 'crashed-verifier',
    now: 100,
    ttlMs: 10,
  });

  const recovered = await fx.runner.recover(run.reviewRunId, { now: 111 });
  assert.equal(recovered.status, 'built');
  assert.equal(recovered.candidate.commit, run.candidate.commit);

  await writeFile(path.join(run.binding.worktreePath, 'unexpected.txt'), 'dirty\n');
  const dirty = await fx.runner.store.update(run.reviewRunId, (state) => ({
    ...state,
    status: 'verifying',
  }));
  assert.equal(dirty.status, 'verifying');
  const blocked = await fx.runner.recover(run.reviewRunId, { now: 200 });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.recovery.reason, 'verify_candidate_changed');
});

test('ISOLATE-06: ручной cleanup удаляет только exact worktree terminal-запуска', async (t) => {
  const fx = await approvedRunner(t, {
    async run({ cwd }) {
      await writeFile(path.join(cwd, 'fixed.txt'), 'fixed\n');
      return { ok: true, allowedPaths: ['fixed.txt'] };
    },
  });
  let run = await fx.runner.build(fx.run.reviewRunId);
  const worktree = run.binding.worktreePath;
  run = await fx.runner.store.update(run.reviewRunId, (state) => ({
    ...state,
    status: 'failed',
  }));
  const cleaned = await fx.runner.cleanup(run.reviewRunId, {
    actor: 'user',
    discardCandidate: true,
  });
  assert.equal(cleaned.cleanup.status, 'completed');
  assert.equal(cleaned.cleanup.worktreeRemoved, true);
  await assert.rejects(git(worktree, 'rev-parse', 'HEAD'));
  assert.equal(
    await git(fx.repo, 'show-ref', '--verify', `refs/heads/${run.binding.candidateBranch}`)
      .then(() => true, () => false),
    false,
  );
});

test('ISOLATE-06: cleanup не следует подменённому пути и не работает до terminal state', async (t) => {
  const fx = await approvedRunner(t, {
    async run() {
      throw new Error('BUILD не нужен');
    },
  });
  await assert.rejects(
    fx.runner.cleanup(fx.run.reviewRunId, { actor: 'user' }),
    (error) => error.code === 'CLEANUP_STATE_INVALID',
  );
  const foreign = path.join(fx.root, 'foreign');
  await fx.runner.store.update(fx.run.reviewRunId, (state) => ({
    ...state,
    status: 'failed',
    binding: { ...state.binding, worktreePath: foreign },
  }));
  await assert.rejects(
    fx.runner.cleanup(fx.run.reviewRunId, { actor: 'user' }),
    (error) => error.code === 'CLEANUP_PATH_MISMATCH',
  );
});

test('RUN-04: межпроцессный create lock оставляет один active run на PR', async (t) => {
  const fx = await fixture(t);
  const options = {
    stateDir: path.join(fx.root, 'state'),
    worktreeRoot: path.join(fx.root, 'worktrees'),
    agentAdapter: { async run() { return { ok: true }; } },
  };
  const firstRunner = createReviewRunner(options);
  const secondRunner = createReviewRunner(options);
  const input = {
    projectId: 'demo',
    repositoryId: 'repo',
    prNumber: 1,
    repoPath: fx.repo,
    headRepoUrl: fx.repo,
    headRef: 'refs/heads/main',
    headSha: fx.headSha,
    snapshotDigest: 'snap',
    snapshotVersion: 'v1',
  };
  const results = await Promise.allSettled([
    firstRunner.createRun({ ...input, reviewRunId: 'rr-active-race-one' }),
    secondRunner.createRun({ ...input, reviewRunId: 'rr-active-race-two' }),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  const rejected = results.find((item) => item.status === 'rejected');
  assert.equal(rejected.reason.code, 'ACTIVE_RUN_EXISTS');

  const active = results.find((item) => item.status === 'fulfilled').value;
  await firstRunner.store.update(active.reviewRunId, (state) => ({
    ...state,
    status: 'failed',
  }));
  const retry = await secondRunner.createRun({
    ...input,
    reviewRunId: 'rr-active-race-retry',
  });
  assert.equal(retry.status, 'awaiting_scope');
});

test('SEC-02: BUILD не коммитит чувствительный файл и symlink escape', async (t) => {
  for (const variant of ['secret', 'symlink']) {
    const fx = await approvedRunner(t, {
      async run({ cwd }) {
        if (variant === 'secret') await writeFile(path.join(cwd, '.env'), 'TOKEN=trap\n');
        else await symlink('/etc/passwd', path.join(cwd, 'escape'));
        return { ok: true, allowedPaths: [variant === 'secret' ? '.env' : 'escape'] };
      },
    });
    await assert.rejects(
      fx.runner.build(fx.run.reviewRunId),
      (error) => error.code === (
        variant === 'secret' ? 'BUILD_ALLOWED_PATH_INVALID' : 'CANDIDATE_SYMLINK_ESCAPE'
      ),
    );
    assert.equal(await git(fx.run.binding.repoPath, 'rev-parse', 'HEAD'), fx.headSha);
  }
});

test('SEC-02: BUILD commit требует exact совпадения Git index с allowedPaths', async (t) => {
  for (const variant of ['missing', 'mismatch']) {
    const fx = await approvedRunner(t, {
      async run({ cwd }) {
        await writeFile(path.join(cwd, 'fixed.txt'), 'fixed\n');
        return variant === 'missing'
          ? { ok: true }
          : { ok: true, allowedPaths: ['different.txt'] };
      },
    });
    await assert.rejects(
      fx.runner.build(fx.run.reviewRunId),
      (error) => error.code === (
        variant === 'missing' ? 'BUILD_ALLOWED_PATHS_REQUIRED' : 'BUILD_PATH_SET_MISMATCH'
      ),
    );
    assert.equal(await git(fx.repo, 'rev-parse', 'HEAD'), fx.headSha);
  }
});

test('SEC-02: host Git не исполняет post-checkout и pre-commit hooks репозитория', async (t) => {
  const fx = await fixture(t);
  const hooks = path.join(fx.root, 'malicious-hooks');
  const trap = path.join(fx.root, 'hook-executed');
  await mkdir(hooks);
  for (const name of ['post-checkout', 'pre-commit', 'commit-msg']) {
    const hook = path.join(hooks, name);
    await writeFile(hook, `#!/bin/sh\nprintf attacked > ${JSON.stringify(trap)}\nexit 99\n`);
    await chmod(hook, 0o755);
  }
  await git(fx.repo, 'config', 'core.hooksPath', hooks);
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
    projectId: 'demo',
    repositoryId: 'repo',
    prNumber: 1,
    repoPath: fx.repo,
    headRepoUrl: fx.repo,
    headRef: 'refs/heads/main',
    headSha: fx.headSha,
    snapshotDigest: 'snap',
    snapshotVersion: 'v1',
  });
  run = await runner.approveScope(run.reviewRunId, {
    scope: [{ itemKey: 'item', itemVersion: 'v1', action: 'fix' }],
    scopeVersion: 'scope',
    actor: 'user',
  });

  const built = await runner.build(run.reviewRunId);
  assert.equal(built.status, 'built');
  await assert.rejects(access(trap));
});

test('SEC-GIT-01: filter из exact PR tree блокируется до worktree checkout', async (t) => {
  const fx = await fixture(t);
  const trap = path.join(fx.root, 'smudge-executed');
  const filter = path.join(fx.root, 'evil-smudge');
  await writeFile(filter, `#!/bin/sh\nprintf attacked > ${trap}\ncat\n`);
  await chmod(filter, 0o755);
  await writeFile(path.join(fx.repo, '.gitattributes'), '*.txt filter=evil\n');
  await git(fx.repo, 'add', '.gitattributes');
  await git(fx.repo, 'commit', '-m', 'malicious attributes');
  const headSha = await git(fx.repo, 'rev-parse', 'HEAD');
  await git(fx.repo, 'config', 'filter.evil.smudge', filter);
  await git(fx.repo, 'config', 'filter.evil.required', 'true');

  const runner = createReviewRunner({
    stateDir: path.join(fx.root, 'state'),
    worktreeRoot: path.join(fx.root, 'worktrees'),
    agentAdapter: { async run() { throw new Error('BUILD не должен запускаться'); } },
  });
  let run = await runner.createRun({
    projectId: 'demo',
    repositoryId: 'repo',
    prNumber: 1,
    repoPath: fx.repo,
    headRepoUrl: fx.repo,
    headRef: 'refs/heads/main',
    headSha,
    snapshotDigest: 'snap',
    snapshotVersion: 'v1',
  });
  run = await runner.approveScope(run.reviewRunId, {
    scope: [{ itemKey: 'item', itemVersion: 'v1', action: 'fix' }],
    scopeVersion: 'scope',
    actor: 'user',
  });

  await assert.rejects(
    runner.prepare(run.reviewRunId),
    (error) => error.code === 'HEAD_FILTER_ATTRIBUTE_FORBIDDEN'
      && error.details?.path === 'base.txt'
      && error.details?.filter === 'evil',
  );
  await assert.rejects(access(trap));
  await assert.rejects(access(path.join(fx.root, 'worktrees', `review-${run.reviewRunId}`)));
  const blocked = await runner.getRun(run.reviewRunId);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.error.code, 'HEAD_FILTER_ATTRIBUTE_FORBIDDEN');
});

test('SEC-GIT-02: BUILD не может подложить ignored .gitattributes перед staging', async (t) => {
  const trap = path.join(os.tmpdir(), `cockpit-filter-${process.pid}-${Date.now()}`);
  const fx = await approvedRunner(t, {
    async run({ cwd }) {
      await mkdir(path.join(cwd, 'generated'));
      await writeFile(path.join(cwd, '.gitignore'), 'generated/.gitattributes\n');
      await writeFile(path.join(cwd, 'generated', '.gitattributes'), '*.txt filter=evil\n');
      await writeFile(path.join(cwd, 'generated', 'value.txt'), 'candidate\n');
      return {
        ok: true,
        allowedPaths: ['.gitignore', 'generated/value.txt'],
      };
    },
  });
  t.after(() => rm(trap, { force: true }));
  const filter = path.join(fx.root, 'evil-clean');
  await writeFile(filter, `#!/bin/sh\nprintf attacked > ${trap}\ncat\n`);
  await chmod(filter, 0o755);
  await git(fx.repo, 'config', 'filter.evil.clean', filter);
  await git(fx.repo, 'config', 'filter.evil.required', 'true');

  await assert.rejects(
    fx.runner.build(fx.run.reviewRunId),
    (error) => error.code === 'BUILD_GIT_ATTRIBUTES_FORBIDDEN',
  );
  await assert.rejects(access(trap));
});

test('SEC-GIT-02: BUILD не меняет tracked .gitattributes/.lfsconfig даже со скрытым index flag', async (t) => {
  for (const controlName of ['.gitattributes', '.lfsconfig']) {
    const fx = await fixture(t);
    await mkdir(path.join(fx.repo, 'config'));
    const relativePath = `config/${controlName}`;
    await writeFile(path.join(fx.repo, relativePath), '# safe\n');
    await git(fx.repo, 'add', relativePath);
    await git(fx.repo, 'commit', '-m', `safe ${controlName}`);
    const headSha = await git(fx.repo, 'rev-parse', 'HEAD');
    const runner = createReviewRunner({
      stateDir: path.join(fx.root, `state-${controlName.slice(1)}`),
      worktreeRoot: path.join(fx.root, `worktrees-${controlName.slice(1)}`),
      agentAdapter: {
        async run({ cwd }) {
          await writeFile(path.join(cwd, relativePath), '*.txt filter=evil\n');
          await git(cwd, 'update-index', '--assume-unchanged', '--', relativePath);
          await writeFile(path.join(cwd, 'fixed.txt'), 'fixed\n');
          return { ok: true, allowedPaths: ['fixed.txt'] };
        },
      },
    });
    let run = await runner.createRun({
      projectId: 'demo',
      repositoryId: 'repo',
      prNumber: controlName === '.gitattributes' ? 2 : 3,
      repoPath: fx.repo,
      headRepoUrl: fx.repo,
      headRef: 'refs/heads/main',
      headSha,
      snapshotDigest: 'snap',
      snapshotVersion: 'v1',
    });
    run = await runner.approveScope(run.reviewRunId, {
      scope: [{ itemKey: 'item', itemVersion: 'v1', action: 'fix' }],
      scopeVersion: 'scope',
      actor: 'user',
    });

    await assert.rejects(
      runner.build(run.reviewRunId),
      (error) => error.code === 'BUILD_GIT_ATTRIBUTES_FORBIDDEN',
    );
  }
});

test('SEC-GIT-03: новый BUILD path не может активировать latent filter exact base', async (t) => {
  const fx = await fixture(t);
  await writeFile(path.join(fx.repo, '.gitattributes'), 'generated/*.txt filter=evil\n');
  await git(fx.repo, 'add', '.gitattributes');
  await git(fx.repo, 'commit', '-m', 'latent attributes');
  const headSha = await git(fx.repo, 'rev-parse', 'HEAD');
  const trap = path.join(fx.root, 'clean-executed');
  const filter = path.join(fx.root, 'evil-clean');
  await writeFile(filter, `#!/bin/sh\nprintf attacked > ${trap}\ncat\n`);
  await chmod(filter, 0o755);
  await git(fx.repo, 'config', 'filter.evil.clean', filter);
  await git(fx.repo, 'config', 'filter.evil.required', 'true');
  const runner = createReviewRunner({
    stateDir: path.join(fx.root, 'state'),
    worktreeRoot: path.join(fx.root, 'worktrees'),
    agentAdapter: {
      async run({ cwd }) {
        await mkdir(path.join(cwd, 'generated'));
        await writeFile(path.join(cwd, 'generated', 'value.txt'), 'candidate\n');
        return { ok: true, allowedPaths: ['generated/value.txt'] };
      },
    },
  });
  let run = await runner.createRun({
    projectId: 'demo',
    repositoryId: 'repo',
    prNumber: 1,
    repoPath: fx.repo,
    headRepoUrl: fx.repo,
    headRef: 'refs/heads/main',
    headSha,
    snapshotDigest: 'snap',
    snapshotVersion: 'v1',
  });
  run = await runner.approveScope(run.reviewRunId, {
    scope: [{ itemKey: 'item', itemVersion: 'v1', action: 'fix' }],
    scopeVersion: 'scope',
    actor: 'user',
  });

  await assert.rejects(
    runner.build(run.reviewRunId),
    (error) => error.code === 'BUILD_FILTER_ATTRIBUTE_FORBIDDEN'
      && error.details?.path === 'generated/value.txt',
  );
  await assert.rejects(access(trap));
});

test('SEC-GIT-04: defaultGit очищает runtime env, а каждый host diff fail-closed', async (t) => {
  const fx = await fixture(t);
  const poisonedGlobal = path.join(fx.root, 'global.gitconfig');
  await writeFile(poisonedGlobal, '[alias]\n  poisoned = status\n');
  const result = await defaultGit(fx.repo, ['rev-parse', '--git-dir'], {
    env: {
      PATH: process.env.PATH,
      HOME: fx.root,
      GIT_DIR: path.join(fx.root, 'missing-git-dir'),
      GIT_CONFIG_GLOBAL: poisonedGlobal,
      LD_PRELOAD: path.join(fx.root, 'missing-preload.so'),
    },
  });
  assert.equal(result.stdout.trim(), '.git');
  await assert.rejects(defaultGit(fx.repo, ['config', '--global', '--get', 'alias.poisoned'], {
    env: {
      PATH: process.env.PATH,
      HOME: fx.root,
      GIT_CONFIG_GLOBAL: poisonedGlobal,
    },
  }));

  const calls = [];
  const builtFixture = await approvedRunner(t, {
    async run({ cwd }) {
      await writeFile(path.join(cwd, 'fixed.txt'), 'fixed\n');
      return { ok: true, allowedPaths: ['fixed.txt'] };
    },
  }, {
    runnerOptions: {
      git: async (cwd, args, options) => {
        calls.push([...args]);
        return defaultGit(cwd, args, options);
      },
    },
  });
  const built = await builtFixture.runner.build(builtFixture.run.reviewRunId);
  await builtFixture.runner.verify(built.reviewRunId);
  const diffs = calls.filter((args) => args[0] === 'diff');
  assert.ok(diffs.length >= 8);
  for (const args of diffs) {
    assert.equal(args.includes('--no-ext-diff'), true, args.join(' '));
    assert.equal(args.includes('--no-textconv'), true, args.join(' '));
  }
});

test('SEC-04/VERIFY-03: VERIFY fail-closed без обязательной команды', async (t) => {
  const fx = await fixture(t);
  const runner = createReviewRunner({
    stateDir: path.join(fx.root, 'state'),
    worktreeRoot: path.join(fx.root, 'worktrees'),
    agentAdapter: {
      async run({ cwd }) {
        await writeFile(path.join(cwd, 'fixed.txt'), 'fixed\n');
        return { ok: true, allowedPaths: ['fixed.txt'] };
      },
    },
    verifyCommands: [],
  });
  let run = await runner.createRun({
    projectId: 'demo',
    repositoryId: 'repo',
    prNumber: 1,
    repoPath: fx.repo,
    headRepoUrl: fx.repo,
    headRef: 'refs/heads/main',
    headSha: fx.headSha,
    snapshotDigest: 'snap',
    snapshotVersion: 'v1',
  });
  run = await runner.approveScope(run.reviewRunId, {
    scope: [{ key: 'item', versionId: 'v1', action: 'fix' }],
    scopeVersion: 'scope',
    actor: 'user',
  });
  run = await runner.build(run.reviewRunId);
  run = await runner.verify(run.reviewRunId);
  assert.equal(run.status, 'verification_failed');
  assert.equal(
    run.verify.report.commands.find((item) => item.id === 'verify-not-configured')?.ok,
    false,
  );
});

test('SEC-06: VERIFY sandbox не видит файл рядом с worktree', async (t) => {
  const fx = await approvedRunner(t, {
    async run({ cwd }) {
      await writeFile(path.join(cwd, 'fixed.txt'), 'fixed\n');
      return { ok: true, allowedPaths: ['fixed.txt'] };
    },
  });
  const trap = path.join(fx.root, 'host-secret.txt');
  await writeFile(trap, 'host secret\n');
  const built = await fx.runner.build(fx.run.reviewRunId);
  const verified = await fx.runner.verify(built.reviewRunId, {
    commands: [[
      process.execPath,
      '-e',
      `process.exit(require('node:fs').existsSync(${JSON.stringify(trap)}) ? 1 : 0)`,
    ]],
  });
  assert.equal(verified.status, 'verified');
  assert.equal(verified.verify.report.commands[0].ok, true);
});

test('VERIFY-01 VERIFY-05: baseline debt отделён, а отчёт связывает критерий с доказательством', async (t) => {
  const fx = await approvedRunner(t, {
    async run({ cwd }) {
      await writeFile(path.join(cwd, 'base.txt'), 'fixed\n');
      return {
        ok: true,
        allowedPaths: ['base.txt'],
        summary: 'Исправлено значение',
        perRemark: [{
          itemKey: 'item',
          change: 'base заменён на fixed',
          verification: 'targeted-value',
        }],
        review: {
          approved: true,
          items: [{ itemKey: 'item', status: 'fulfilled', evidence: 'Новый текст присутствует' }],
          unrelatedChanges: [],
          summary: 'Scope соблюдён',
        },
      };
    },
  }, {
    scope: [{
      itemKey: 'item',
      itemVersion: 'v1',
      action: 'fix',
      instruction: 'Файл base.txt содержит fixed',
    }],
    verifyCommands: [{
      id: 'targeted-value',
      command: process.execPath,
      args: [
        '-e',
        "import('node:fs').then(fs=>process.exit(fs.readFileSync('base.txt','utf8')==='fixed\\n'?0:1))",
      ],
      required: true,
      compareBaseline: true,
      itemKeys: ['item'],
    }, {
      id: 'legacy-lint',
      command: process.execPath,
      args: ['-e', "process.stderr.write('legacy lint debt\\n');process.exit(1)"],
      required: true,
      compareBaseline: true,
    }],
  });

  const built = await fx.runner.build(fx.run.reviewRunId);
  const verified = await fx.runner.verify(built.reviewRunId);
  const report = verified.verify.report;
  const targeted = report.commands.find((item) => item.id === 'targeted-value');
  const legacy = report.commands.find((item) => item.id === 'legacy-lint');

  assert.equal(verified.status, 'verified');
  assert.equal(report.schemaVersion, 2);
  assert.equal(targeted.delta.classification, 'resolved');
  assert.equal(targeted.effectiveOk, true);
  assert.equal(legacy.ok, false);
  assert.equal(legacy.effectiveOk, true);
  assert.equal(legacy.delta.classification, 'known-failure');
  assert.equal(report.summary.knownFailures, 1);
  assert.equal(report.criteria[0].status, 'passed');
  assert.deepEqual(report.criteria[0].commandIds, ['targeted-value']);
  assert.deepEqual(report.links[0].commandIds, ['targeted-value']);
  assert.ok(report.artifacts.some((item) => item.kind === 'git-tree'));
  assert.ok(report.artifacts.some((item) => item.kind === 'command-log'));
  assert.deepEqual(verified.candidate.buildEvidence.allowedPaths, ['base.txt']);
  assert.equal(verified.candidate.buildEvidence.perRemark[0].itemKey, 'item');
  assert.equal(verified.candidate.buildEvidence.review.approved, true);
});

test('SEC-VERIFY-01: ignored секреты worktree не попадают в disposable VERIFY tree', async (t) => {
  const fx = await approvedRunner(t, {
    async run({ cwd }) {
      await writeFile(path.join(cwd, '.gitignore'), '.env\n');
      await writeFile(path.join(cwd, 'fixed.txt'), 'fixed\n');
      return { ok: true, allowedPaths: ['.gitignore', 'fixed.txt'] };
    },
  }, {
    scope: [{
      itemKey: 'item',
      itemVersion: 'v1',
      action: 'fix',
      allowedPaths: ['.gitignore', 'fixed.txt'],
    }],
    verifyCommands: [{
      id: 'ignored-secret-absent',
      command: process.execPath,
      args: [
        '-e',
        "const fs=require('node:fs');if(fs.existsSync('.env')){process.stderr.write('secret leaked');process.exit(1)}",
      ],
      coversAllCriteria: true,
    }],
  });
  const built = await fx.runner.build(fx.run.reviewRunId);
  await writeFile(path.join(built.binding.worktreePath, '.env'), 'TOP_SECRET=value\n');
  await access(path.join(built.binding.worktreePath, '.env'));

  const verified = await fx.runner.verify(built.reviewRunId);
  assert.equal(verified.status, 'verified');
  assert.equal(verified.verify.report.passed, true);
  assert.equal(
    verified.verify.report.commands.find((command) => command.id === 'ignored-secret-absent')?.ok,
    true,
  );
});

test('VERIFY-02: новая ошибка относительно зелёного baseline блокирует приёмку', async (t) => {
  const fx = await approvedRunner(t, {
    async run({ cwd }) {
      await writeFile(path.join(cwd, 'regression.txt'), 'new failure\n');
      return { ok: true, allowedPaths: ['regression.txt'] };
    },
  }, {
    verifyCommands: [{
      id: 'no-regression',
      command: process.execPath,
      args: [
        '-e',
        "import('node:fs').then(fs=>process.exit(fs.existsSync('regression.txt')?1:0))",
      ],
      required: true,
      compareBaseline: true,
    }],
  });

  const built = await fx.runner.build(fx.run.reviewRunId);
  const failed = await fx.runner.verify(built.reviewRunId);
  const command = failed.verify.report.commands.find((item) => item.id === 'no-regression');

  assert.equal(failed.status, 'verification_failed');
  assert.equal(command.delta.classification, 'regression');
  assert.equal(command.effectiveOk, false);
  assert.equal(failed.verify.report.summary.regressions, 1);
  await assert.rejects(
    fx.runner.accept(failed.reviewRunId, { actor: 'user' }),
    (error) => error.code === 'VERIFY_REQUIRED',
  );
});

test('VERIFY-03 VERIFY-04: обязательный критерий без mapped check остаётся unchecked', async (t) => {
  const fx = await approvedRunner(t, {
    async run({ cwd }) {
      await writeFile(path.join(cwd, 'fixed.txt'), 'fixed\n');
      return { ok: true, allowedPaths: ['fixed.txt'] };
    },
  }, {
    scope: [{
      itemKey: 'item',
      itemVersion: 'v1',
      action: 'fix',
      instruction: 'Исправление подтверждено целевым тестом',
    }],
    verifyCommands: [{
      id: 'global-check',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      required: true,
    }],
  });

  const built = await fx.runner.build(fx.run.reviewRunId);
  const failed = await fx.runner.verify(built.reviewRunId);

  assert.equal(failed.status, 'verification_failed');
  assert.equal(failed.verify.report.criteria[0].status, 'unchecked');
  assert.equal(failed.verify.report.summary.uncheckedCriteria, 1);
  assert.match(failed.verify.report.criteria[0].reason, /не привязана/i);
});
