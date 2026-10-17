import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CockpitUpdateManager } from '../../server/src/lib/cockpitUpdate.ts';
import { readPersistentState, writePersistentState } from '../../server/src/lib/cockpitRelease.ts';

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
    releases: { async getStatus() {
       return status(); 
    }, invalidate() {
    
      } },
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

test('UP-01 desktop запускает отвязанный worker с origin и путём CLI-токена', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-update-desktop-'));
  const launches = [];
  let unrefs = 0;

  t.after(() => rm(root, { recursive: true, force: true }));

  const tokenPath = path.join(root, 'cli-token');
  const origin = 'http://127.0.0.1:9312';
  const manager = new CockpitUpdateManager({
    releases: {
      async getStatus() {
        return status();
      },
      invalidate() {},
    },
    rootDir: root,
    statePath: path.join(root, 'state.json'),
    desktop: () => true,
    underSystemd: () => true,
    origin,
    cliTokenPath: tokenPath,
    async runner() {
      assert.fail('desktop не вызывает systemd-run');
    },
    spawnProcess(file, args, options) {
      launches.push({
        file,
        args,
        options,
      });

      return {
        unref() {
          unrefs += 1;
        },
      };
    },
  });
  const job = await manager.startApply({ expectedCheckoutSha: HEAD });

  assert.equal(launches.length, 1);
  assert.equal(launches[0].file, process.execPath);
  assert.deepEqual(launches[0].args.slice(1), [
    '--root', root,
    '--work-root', path.join(root, '.state'),
    '--state', path.join(root, 'state.json'),
    '--job', job.id,
    '--mode', 'desktop',
    '--origin', origin,
    '--token-file', tokenPath,
  ]);
  assert.equal(launches[0].options.detached, true);
  assert.equal(launches[0].options.stdio, 'ignore');
  assert.equal(launches[0].options.cwd, root);
  assert.equal(unrefs, 1);
});

test('UP-08 isRestarting сверяет id и статус без fresh-проверки релизов', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-update-job-state-'));
  const statePath = path.join(root, 'state.json');

  t.after(() => rm(root, { recursive: true, force: true }));

  const manager = new CockpitUpdateManager({
    releases: {
      async getStatus() {
        assert.fail('isRestarting не запрашивает fresh-статус');
      },
    },
    rootDir: root,
    statePath,
    underSystemd: () => false,
  });

  await writePersistentState(statePath, {
    job: {
      id: 'fixture-job',
      status: 'restarting',
    },
  });
  assert.equal(await manager.isRestarting('fixture-job'), true);
  assert.equal(await manager.isRestarting('other-job'), false);

  await writePersistentState(statePath, {
    job: {
      id: 'fixture-job',
      status: 'building',
    },
  });
  assert.equal(await manager.isRestarting('fixture-job'), false);
  await writePersistentState(statePath, { job: null });
  assert.equal(await manager.isRestarting('fixture-job'), false);
});

test('DH-17 worker размещает рабочую копию на диске кода', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-work-root-'));
  let argv;

  t.after(() => rm(root, { recursive: true, force: true }));

  const manager = new CockpitUpdateManager({
    rootDir: root, 
    statePath: path.join(root, 'data/state.json'),
    releases: { async getStatus() {
       return status(); 
    }, invalidate() {
    
      } },
    underSystemd: () => false,

    spawnProcess(_file, args) {

       argv = args;

      return { unref() {
    
      } }; 
    },
  });

  await manager.startApply({ expectedCheckoutSha: HEAD });
  assert.equal(argv[argv.indexOf('--work-root') + 1], path.join(root, '.state'));
});
