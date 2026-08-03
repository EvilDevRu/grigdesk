import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  CockpitReleaseService,
  readPersistentState,
  writePersistentState,
} from '../../server/src/lib/cockpit-release.js';

const exec = promisify(execFile);
const worker = fileURLToPath(new URL('../../server/src/workers/cockpit-update-worker.js', import.meta.url));

async function git(cwd, ...args) {
  return (await exec('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
}

async function writePackage(dir, name) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'), `${JSON.stringify({
    name, version: '1.0.0', private: true, type: 'module',
    ...(name === 'fixture-web' ? { scripts: { build: 'node build.js' } } : {}),
  }, null, 2)}\n`);
  await writeFile(path.join(dir, 'package-lock.json'), `${JSON.stringify({
    name, version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name, version: '1.0.0' } },
  }, null, 2)}\n`);
}

async function fixtureRepository(temp, { brokenBuild = false } = {}) {
  const publisher = path.join(temp, 'publisher');
  const origin = path.join(temp, 'origin.git');
  const root = path.join(temp, 'work');
  await git(temp, 'init', '-b', 'main', publisher);
  await git(publisher, 'config', 'user.name', 'Cockpit Test');
  await git(publisher, 'config', 'user.email', 'cockpit@example.invalid');
  await writeFile(path.join(publisher, '.gitignore'), 'server/node_modules/\nserver/.state/\nweb/node_modules/\nweb/dist/\n');
  await writeFile(path.join(publisher, 'VERSION'), '0.1.0\n');
  await writeFile(path.join(publisher, 'release.txt'), 'one\n');
  await mkdir(path.join(publisher, 'bin'), { recursive: true });
  await writeFile(path.join(publisher, 'bin', 'restart'), '#!/usr/bin/env bash\nexit 0\n');
  await writePackage(path.join(publisher, 'server'), 'fixture-server');
  await writePackage(path.join(publisher, 'web'), 'fixture-web');
  await writeFile(path.join(publisher, 'web', 'build.js'), [
    "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
    "await mkdir('dist', { recursive: true });",
    "const value = await readFile('../release.txt', 'utf8');",
    "await writeFile('dist/index.html', value);",
    '',
  ].join('\n'));
  await mkdir(path.join(publisher, 'tests', 'server'), { recursive: true });
  await writeFile(path.join(publisher, 'tests', 'server', 'cockpit-release.test.js'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('fixture smoke', () => assert.equal(1, 1));",
    '',
  ].join('\n'));
  await git(publisher, 'add', '.');
  await git(publisher, 'commit', '-m', 'v0.1.0');
  const first = await git(publisher, 'rev-parse', 'HEAD');
  await git(publisher, 'tag', '-a', 'v0.1.0', '-m', 'v0.1.0');

  await writeFile(path.join(publisher, 'VERSION'), '0.2.0\n');
  await writeFile(path.join(publisher, 'release.txt'), 'two\n');
  if (brokenBuild) await writeFile(path.join(publisher, 'web', 'build.js'), "throw new Error('fixture build failed');\n");
  await git(publisher, 'add', '.');
  await git(publisher, 'commit', '-m', 'v0.2.0');
  const second = await git(publisher, 'rev-parse', 'HEAD');
  await git(publisher, 'tag', '-a', 'v0.2.0', '-m', 'v0.2.0');

  await git(temp, 'init', '--bare', origin);
  await git(publisher, 'remote', 'add', 'origin', origin);
  await git(publisher, 'push', 'origin', 'main', '--tags');
  await git(temp, 'clone', '--branch', 'main', origin, root);
  await git(root, 'reset', '--hard', first);
  await git(root, 'tag', '-d', 'v0.2.0');
  await mkdir(path.join(root, 'server', 'node_modules'), { recursive: true });
  await mkdir(path.join(root, 'web', 'dist'), { recursive: true });
  await writeFile(path.join(root, 'server', 'node_modules', 'old.txt'), 'old\n');
  await writeFile(path.join(root, 'web', 'dist', 'index.html'), 'old\n');
  return { root, publisher, first, second };
}

async function queueJob(root, first, second) {
  const statePath = path.join(root, 'server', '.state', 'cockpit-update.json');
  const id = randomUUID();
  const now = new Date().toISOString();
  await mkdir(`${statePath}.job-lock`, { recursive: true });
  await writeFile(path.join(`${statePath}.job-lock`, 'owner.json'), `${JSON.stringify({ id })}\n`);
  await writePersistentState(statePath, {
    releaseCheck: {
      latest: { version: '0.2.0', tag: 'v0.2.0', sha: second, url: null },
      checkedAt: now, checkError: null,
    },
    job: {
      id, kind: 'update', status: 'queued', stage: 'queued', createdAt: now, updatedAt: now,
      targetSha: second, targetVersion: '0.2.0', targetTag: 'v0.2.0',
      expectedCheckoutSha: first, error: null,
    },
  });
  return { id, statePath };
}

async function queueApply(root, sha) {
  const statePath = path.join(root, 'server', '.state', 'cockpit-update.json');
  const id = randomUUID();
  const now = new Date().toISOString();
  await mkdir(`${statePath}.job-lock`, { recursive: true });
  await writeFile(path.join(`${statePath}.job-lock`, 'owner.json'), `${JSON.stringify({ id })}\n`);
  await writePersistentState(statePath, {
    job: {
      id, kind: 'apply', status: 'queued', stage: 'queued', createdAt: now, updatedAt: now,
      targetSha: sha, targetVersion: 'v0.1.0', targetTag: null,
      expectedCheckoutSha: sha, error: null,
    },
  });
  return { id, statePath };
}

test('worker prepares a tagged release, fast-forwards exact SHA and waits for new server confirmation', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cockpit-worker-ok.'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const { root, first, second } = await fixtureRepository(temp);
  const { id, statePath } = await queueJob(root, first, second);

  try {
    await exec(process.execPath, [worker, '--root', root, '--state', statePath, '--job', id, '--mode', 'script'], {
      cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const state = await readPersistentState(statePath);
    assert.fail(`worker failed: ${JSON.stringify(state.job?.error)} (${error.message})`);
  }
  assert.equal(await git(root, 'rev-parse', 'HEAD'), second);
  assert.equal((await readPersistentState(statePath)).job.status, 'restarting');
  assert.equal((await readFile(path.join(root, 'web', 'dist', 'index.html'), 'utf8')).trim(), 'two');

  const service = new CockpitReleaseService({ rootDir: root, statePath });
  const status = await service.getStatus({ fresh: true });
  assert.equal(status.job.status, 'done', 'new process confirms its own running SHA');
  service.stop();
});

test('build failure happens before merge and leaves main at the old release', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cockpit-worker-fail.'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const { root, first, second } = await fixtureRepository(temp, { brokenBuild: true });
  const { id, statePath } = await queueJob(root, first, second);

  await assert.rejects(exec(process.execPath, [worker, '--root', root, '--state', statePath, '--job', id, '--mode', 'script'], {
    cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  }));
  assert.equal(await git(root, 'rev-parse', 'HEAD'), first);
  const state = await readPersistentState(statePath);
  assert.equal(state.job.status, 'failed');
  assert.equal(state.job.error.code, 'web_build_failed');
});

test('local apply builds the exact clean checkout without changing any git ref', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cockpit-worker-apply.'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const { root, first } = await fixtureRepository(temp);
  const { id, statePath } = await queueApply(root, first);
  const refsBefore = await git(root, 'show-ref');

  await exec(process.execPath, [worker, '--root', root, '--state', statePath, '--job', id, '--mode', 'script'], {
    cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(await git(root, 'rev-parse', 'HEAD'), first);
  assert.equal(await git(root, 'show-ref'), refsBefore);
  assert.equal((await readFile(path.join(root, 'web', 'dist', 'index.html'), 'utf8')).trim(), 'one');
  assert.equal((await readPersistentState(statePath)).job.status, 'restarting');
});

test('a remote tag moved after check is rejected before merge', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cockpit-worker-tag-race.'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const { root, publisher, first, second } = await fixtureRepository(temp);
  const { id, statePath } = await queueJob(root, first, second);
  await git(publisher, 'tag', '-f', '-a', 'v0.2.0', '-m', 'moved tag', first);
  await git(publisher, 'push', '--force', 'origin', 'refs/tags/v0.2.0');

  await assert.rejects(exec(process.execPath, [worker, '--root', root, '--state', statePath, '--job', id, '--mode', 'script'], {
    cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  }));
  assert.equal(await git(root, 'rev-parse', 'HEAD'), first);
  const state = await readPersistentState(statePath);
  assert.equal(state.job.status, 'failed');
  assert.equal(state.job.error.code, 'remote_tag_changed');
});
