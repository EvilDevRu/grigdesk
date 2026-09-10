import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { CockpitReleaseService } from '../../server/src/lib/cockpitRelease.ts';

const exec = promisify(execFile);
async function git(cwd, ...args) {
  return (await exec('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
}
async function commit(root, message, contents) {
  await writeFile(path.join(root, 'marker.txt'), `${contents}\n`);
  await git(root, 'add', 'VERSION', 'marker.txt');
  await git(root, 'commit', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

test('real git classifies behind, ahead, diverged, dirty and WIP without mutating refs on check', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cockpit-release-git.'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'work');
  const origin = path.join(temp, 'origin.git');
  await git(temp, 'init', '-b', 'main', root);
  await git(root, 'config', 'user.name', 'Cockpit Test');
  await git(root, 'config', 'user.email', 'cockpit@example.invalid');
  await writeFile(path.join(root, 'VERSION'), '0.1.0\n');
  const first = await commit(root, 'v0.1.0', 'one');
  await git(root, 'tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
  await writeFile(path.join(root, 'VERSION'), '0.2.0\n');
  const second = await commit(root, 'v0.2.0', 'two');
  await git(root, 'tag', '-a', 'v0.2.0', '-m', 'v0.2.0');
  await git(temp, 'init', '--bare', origin);
  await git(root, 'remote', 'add', 'origin', origin);
  await git(root, 'push', 'origin', 'main', '--tags');
  await git(root, 'reset', '--hard', first);

  const statePath = path.join(temp, 'update-state.json');
  const service = new CockpitReleaseService({ rootDir: root, statePath, initialCheckDelayMs: 60_000 });
  const refsBefore = await git(root, 'show-ref');
  let status = await service.checkRemote();
  const refsAfter = await git(root, 'show-ref');
  assert.equal(refsAfter, refsBefore, 'ls-remote check did not fetch or move refs');
  assert.equal(status.latest.tag, 'v0.2.0');
  assert.equal(status.latest.sha, second);
  assert.equal(status.checkoutRelation, 'behind');
  assert.equal(status.updateAvailable, true);
  assert.equal(status.canInstallRelease, true);

  await git(root, 'switch', '-c', 'wip/test');
  service.invalidate();
  status = await service.getStatus({ fresh: true });
  assert.equal(status.canInstallRelease, false);
  assert.ok(status.installBlockReasons.includes('branch_not_main'));

  await writeFile(path.join(root, 'untracked.txt'), 'dirty\n');
  service.invalidate();
  status = await service.getStatus({ fresh: true });
  assert.equal(status.canApplyCheckout, false);
  assert.ok(status.applyBlockReasons.includes('working_tree_dirty'));
  await rm(path.join(root, 'untracked.txt'));

  await git(root, 'switch', 'main');
  await git(root, 'reset', '--hard', second);
  await writeFile(path.join(root, 'VERSION'), '0.2.0\n');
  await commit(root, 'ahead', 'three');
  service.invalidate();
  status = await service.getStatus({ fresh: true });
  assert.equal(status.checkoutRelation, 'ahead');
  assert.ok(status.installBlockReasons.includes('checkout_ahead'));

  await git(root, 'reset', '--hard', first);
  await writeFile(path.join(root, 'VERSION'), '0.1.0\n');
  await commit(root, 'diverged', 'other');
  service.invalidate();
  status = await service.getStatus({ fresh: true });
  assert.equal(status.checkoutRelation, 'diverged');
  assert.ok(status.installBlockReasons.includes('checkout_diverged'));
  service.stop();
});
