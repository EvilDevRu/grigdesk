import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CockpitUpdateManager } from '../../server/src/lib/cockpit-update.js';
import { readPersistentState } from '../../server/src/lib/cockpit-release.js';

const HEAD = 'a'.repeat(40);
const TARGET = 'b'.repeat(40);

function status(overrides = {}) {
  return {
    running: { instanceId: 'old-server-instance' },
    checkout: { sha: HEAD, dirty: false, branch: 'main', version: 'v0.1.0+1.gaaaaaaa' },
    latest: { tag: 'v0.2.0', version: '0.2.0', sha: TARGET },
    applyBlockReasons: [], installBlockReasons: [], job: null,
    ...overrides,
  };
}

test('manager validates SHA race, checked target and uses an interprocess job lock', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-update-manager.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = path.join(root, 'server', '.state', 'cockpit-update.json');
  let current = status();
  const releases = {
    async getStatus() { return current; },
    invalidate() {},
  };
  const launches = [];
  const manager = new CockpitUpdateManager({
    releases, rootDir: root, statePath, underSystemd: () => false,
    spawnProcess(file, args, options) {
      launches.push({ file, args, options });
      return { unref() {} };
    },
  });

  await assert.rejects(
    manager.startApply({ expectedCheckoutSha: 'c'.repeat(40) }),
    (error) => error.code === 'checkout_changed' && error.statusCode === 409,
  );
  await assert.rejects(
    manager.startUpdate({ targetTag: 'v0.3.0', expectedCheckoutSha: HEAD }),
    (error) => error.code === 'target_not_checked',
  );

  const job = await manager.startUpdate({ targetTag: 'v0.2.0', expectedCheckoutSha: HEAD });
  assert.equal(job.kind, 'update');
  assert.equal(job.targetSha, TARGET);
  assert.equal(job.previousRunningInstanceId, 'old-server-instance');
  assert.equal(launches.length, 1);
  assert.equal(launches[0].args.includes('../../main'), false);
  assert.equal((await readPersistentState(statePath)).job.id, job.id);
  const owner = JSON.parse(await readFile(`${statePath}.job-lock/owner.json`, 'utf8'));
  assert.equal(owner.id, job.id);

  await assert.rejects(
    manager.startApply({ expectedCheckoutSha: HEAD }),
    (error) => error.code === 'update_in_progress',
  );
});

test('dirty apply stays blocked even when allowDirty is sent explicitly', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-update-dirty.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new CockpitUpdateManager({
    releases: { async getStatus() { return status({ applyBlockReasons: ['working_tree_dirty'] }); }, invalidate() {} },
    rootDir: root,
    statePath: path.join(root, 'state.json'),
    spawnProcess() { throw new Error('worker must not launch'); },
  });
  await assert.rejects(
    manager.startApply({ expectedCheckoutSha: HEAD, allowDirty: true }),
    (error) => error.code === 'dirty_apply_not_supported',
  );
});

test('systemd mode launches a collected transient unit outside the server service cgroup', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-update-systemd.'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launches = [];
  const manager = new CockpitUpdateManager({
    releases: { async getStatus() { return status(); }, invalidate() {} },
    rootDir: root,
    statePath: path.join(root, 'state.json'),
    underSystemd: () => true,
    async runner(file, args) {
      launches.push({ file, args });
      return { code: 0, stdout: '', stderr: '' };
    },
    spawnProcess() { throw new Error('systemd mode must not use a detached child of the server'); },
  });
  await manager.startApply({ expectedCheckoutSha: HEAD });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].file, 'systemd-run');
  assert.ok(launches[0].args.includes('--user'));
  assert.ok(launches[0].args.includes('--collect'));
  assert.ok(launches[0].args.includes('--unit=cockpit-update-worker'));
  assert.ok(launches[0].args.includes(process.execPath));
});
