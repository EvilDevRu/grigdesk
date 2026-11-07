import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { computePayloadDigest } from '../../server/src/lib/packageInstall/payloadDigest.ts';
import { createPluginRepo, git } from './helpers/pluginRepo.js';
import { serviceFixture } from './helpers/pluginServiceFixture.js';
import { compatibleState, moduleRelease, prepareModule } from './helpers/pluginModuleFixture.js';

/**
 * Сравниваются все байты выпуска, Git identity и полный payload реальной копии.
 * Одинаковая проверка применяется к current и сохранённому previous.
 */
async function assertSnapshot(dir, record, release, sha, source) {
  assert.equal(record.sha, sha);
  assert.deepEqual(record.source, source);
  assert.deepEqual(record.npmDirs, []);
  assert.equal(record.payloadDigest, await computePayloadDigest(dir, record.npmDirs));
  assert.equal(await git(dir, 'rev-parse', 'HEAD'), sha);

  for (const [file, bytes] of Object.entries(release.files)) {
    assert.equal(await readFile(path.join(dir, file), 'utf8'), bytes, file);
  }
}

test('AC6-MODULE-ROUNDTRIP: api2 install → update → rollback сохраняет snapshots и прежний state',
  async (t) => {
    const repo = await createPluginRepo(t);
    const first = moduleRelease('1.0.0');
    const second = moduleRelease('1.1.0');
    const firstSha = await repo.release('1.0.0', first);
    const secondSha = await repo.release('1.1.0', second);
    const { service, pluginsDir, statePath } = await serviceFixture(t);
    const source = { kind: 'git', url: repo.url };
    const ready = await prepareModule(service, repo.url, { version: '1.0.0' });

    await compatibleState(statePath);
    assert.equal((await service.apply(ready.id, ready.reviewToken)).status, 'done');

    const installed = (await compatibleState(statePath)).plugins.demo;
    const currentDir = path.join(pluginsDir, 'demo');
    const previousDir = path.join(service.workDir, 'previous/demo');

    await assertSnapshot(currentDir, installed, first, firstSha, source);
    assert.equal(installed.previous, null);

    const checked = await service.checkUpdates();

    assert.equal(checked.demo.latest.sha, secondSha);
    assert.equal(checked.demo.updateAvailable, true);
    await service.startUpdate('demo');
    await service.whenIdle();

    const update = await service.currentJob();

    assert.equal(update.status, 'ready', JSON.stringify(update.error));
    await compatibleState(statePath);
    assert.equal((await service.apply(update.id, update.reviewToken)).status, 'done');

    const updated = (await compatibleState(statePath)).plugins.demo;

    await assertSnapshot(currentDir, updated, second, secondSha, source);
    await assertSnapshot(previousDir, updated.previous, first, firstSha, source);
    assert.equal(updated.previous.payloadDigest, installed.payloadDigest);

    const rollback = await service.rollback('demo', {
      requestId: randomUUID(),
      expectedRevision: updated.revision,
      expectedPreviousDigest: updated.previous.payloadDigest,
    });
    const restored = (await compatibleState(statePath)).plugins.demo;

    assert.equal(rollback.status, 'done');
    assert.equal(rollback.kind, 'rollback');
    assert.notEqual(rollback.id, update.id);
    assert.ok(restored.revision > updated.revision);
    assert.equal(restored.payloadDigest, installed.payloadDigest);
    await assertSnapshot(currentDir, restored, first, firstSha, source);
    await assertSnapshot(previousDir, restored.previous, second, secondSha, source);
  });

for (const file of ['panel.js', 'panel.css', 'ru.json', 'en.json']) {
  test(`AC5-MODULE-LOCAL: api2 обнаруживает и сохраняет ручные байты ${file}`, async (t) => {
    const repo = await createPluginRepo(t);

    await repo.release('1.0.0', moduleRelease('1.0.0'));
    await repo.release('1.1.0', moduleRelease('1.1.0'));

    let now = Date.now();
    const { service, pluginsDir } = await serviceFixture(t, { now: () => new Date(now) });
    const initial = await prepareModule(service, repo.url, { version: '1.0.0' });

    assert.equal((await service.apply(initial.id, initial.reviewToken)).status, 'done');
    assert.equal((await service.describe('demo')).localChanges, false);

    const relative = `ui/${file}`;
    const target = path.join(pluginsDir, 'demo', relative);
    const manual = `Ручная правка ${file}`;

    await writeFile(target, manual);
    now += 60_000;
    assert.equal((await service.describe('demo')).localChanges, true);
    await service.startUpdate('demo');
    await service.whenIdle();

    const failed = await service.currentJob();

    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.code, 'local_changes');
    assert.equal(await readFile(target, 'utf8'), manual);
    await service.startUpdate('demo', { replaceModified: true });
    await service.whenIdle();

    const ready = await service.currentJob();

    assert.equal(ready.status, 'ready', JSON.stringify(ready.error));

    const done = await service.apply(ready.id, ready.reviewToken);

    assert.equal(done.status, 'done');
    assert.ok(done.backupRef);
    assert.equal(await readFile(path.join(service.workDir, 'replaced', done.backupRef, relative), 'utf8'),
      manual);
    assert.equal((await service.describe('demo')).localChanges, false);
  });
}
