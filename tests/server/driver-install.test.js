import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { computePayloadDigest } from '../../server/src/lib/pluginInstall/payloadDigest.ts';
import {
  driverInstallFixture, driverRecord, driverRepo, prepareDriver,
} from './helpers/driverInstallFixture.js';

test('DRIVER-INSTALL-01: install, update, rollback возвращают driver bytes и digest', async (t) => {
  const repo = await driverRepo(t);

  await repo.release('1.0.0', { 'payload.txt': 'первая версия' });

  const fixture = await driverInstallFixture(t);
  const pluginBefore = await readFile(fixture.pluginStatePath, 'utf8');
  const first = await prepareDriver(fixture.service, repo.url);

  assert.equal((await fixture.service.apply(first.id, first.reviewToken)).status, 'done');

  const initial = await driverRecord(fixture);
  const current = path.join(fixture.driversDir, repo.id);

  assert.equal(await readFile(path.join(current, 'payload.txt'), 'utf8'), 'первая версия');
  assert.equal(initial.payloadDigest, await computePayloadDigest(current, []));
  await repo.release('1.1.0', { 'payload.txt': 'вторая версия' });
  await fixture.service.startUpdate(repo.id);
  await fixture.service.whenIdle();

  const update = await fixture.service.currentJob();

  assert.equal(update.status, 'ready', JSON.stringify(update.error));
  assert.ok(update.preview.changes.sensitive.includes('driver.json'));
  await fixture.service.apply(update.id, update.reviewToken);

  const upgraded = await driverRecord(fixture);
  const request = {
    requestId: randomUUID(),
    expectedRevision: upgraded.revision,
    expectedPreviousDigest: upgraded.previous.payloadDigest,
  };
  const rolled = await fixture.service.rollback(repo.id, request);
  const restored = await driverRecord(fixture);

  assert.equal(rolled.status, 'done');
  assert.equal(restored.version, '1.0.0');
  assert.equal(restored.payloadDigest, initial.payloadDigest);
  assert.equal(await readFile(path.join(current, 'payload.txt'), 'utf8'), 'первая версия');
  assert.equal(await readFile(fixture.pluginStatePath, 'utf8'), pluginBefore);
  assert.deepEqual(await fixture.service.rollback(repo.id, request), rolled);
});

for (const [name, manifest, code] of [
  ['contract', { contract: 99 }, 'contract_unsupported'],
  ['reserved id', { id: 'own' }, 'id_reserved'],
  ['unsafe id', { id: '../outside' }, 'id_invalid'],
  ['version/tag', { version: '2.0.0' }, 'version_mismatch'],
  ['plugin navigation', { nav: { title: 'Модуль' } }, 'manifest_invalid'],
]) {
  test(`DRIVER-INSTALL-02: ${name} отклоняется без import и публикации`, async (t) => {
    const repo = await driverRepo(t, { manifest });

    await repo.release('1.0.0');

    const fixture = await driverInstallFixture(t);

    await fixture.service.startInstall({ url: repo.url, version: '1.0.0' });
    await fixture.service.whenIdle();

    const rejected = await fixture.service.currentJob();

    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.error.code, code);
    assert.equal(await readFile(path.join(fixture.driversDir, repo.id, 'driver.ts'))
      .catch(() => null), null);
  });
}

test('DRIVER-INSTALL-03: stale token и изменённый digest не публикуют пакет, повтор apply без эффекта',
  async (t) => {
    const repo = await driverRepo(t);

    await repo.release('1.0.0', { 'payload.txt': 'оригинал' });

    const fixture = await driverInstallFixture(t);
    const ready = await prepareDriver(fixture.service, repo.url);

    await assert.rejects(fixture.service.apply(ready.id, 'f'.repeat(64)), { code: 'preview_stale' });
    assert.deepEqual(fixture.leases, []);
    await writeFile(path.join(fixture.service.workDir, 'jobs', ready.id, 'package/payload.txt'), 'подмена');
    await assert.rejects(fixture.service.apply(ready.id, ready.reviewToken));
    assert.deepEqual(fixture.leases, ['reverted']);
    assert.equal(await readFile(path.join(fixture.driversDir, repo.id, 'payload.txt'))
      .catch(() => null), null);

    await fixture.service.cancel(ready.id);

    const fresh = await prepareDriver(fixture.service, repo.url);
    const done = await fixture.service.apply(fresh.id, fresh.reviewToken);
    const state = await readFile(fixture.statePath, 'utf8');

    assert.deepEqual(fixture.leases, ['reverted', 'installed']);
    assert.deepEqual(await fixture.service.apply(fresh.id, fresh.reviewToken), done);
    assert.equal(await readFile(fixture.statePath, 'utf8'), state);
    assert.deepEqual(fixture.leases, ['reverted', 'installed']);
  });

test('DRIVER-INSTALL-03: dirty previous сохраняется и запрещает rollback', async (t) => {
  const repo = await driverRepo(t);

  await repo.release('1.0.0', { 'payload.txt': 'первая' });

  const fixture = await driverInstallFixture(t);
  const ready = await prepareDriver(fixture.service, repo.url);

  await fixture.service.apply(ready.id, ready.reviewToken);
  await repo.release('1.1.0', { 'payload.txt': 'вторая' });
  await fixture.service.startUpdate(repo.id);
  await fixture.service.whenIdle();

  const update = await fixture.service.currentJob();

  assert.equal(update.status, 'ready');
  await fixture.service.apply(update.id, update.reviewToken);

  const record = await driverRecord(fixture);
  const previous = path.join(fixture.service.workDir, 'previous', repo.id, 'payload.txt');

  await writeFile(previous, 'ручная правка');
  await assert.rejects(fixture.service.rollback(repo.id, {
    requestId: randomUUID(),
    expectedRevision: record.revision,
    expectedPreviousDigest: record.previous.payloadDigest,
  }), { code: 'previous_modified' });
  assert.equal(await readFile(previous, 'utf8'), 'ручная правка');
  assert.equal((await driverRecord(fixture)).version, '1.1.0');
});

test('DRIVER-INSTALL-02: symlink отклоняется проверкой git tree до публикации', async (t) => {
  const repo = await driverRepo(t);

  await repo.release('1.0.0');

  const { symlink } = await import('node:fs/promises');
  const { git } = await import('./helpers/pluginRepo.js');

  await symlink('../outside', path.join(repo.work, 'linked.ts'));
  await git(repo.work, 'add', '-A');
  await git(repo.work, 'commit', '-qm', 'symlink fixture');
  await git(repo.work, 'tag', 'v1.1.0');
  await git(repo.work, 'push', '-q', 'origin', 'main', '--tags');

  const fixture = await driverInstallFixture(t);

  await fixture.service.startInstall({ url: repo.url, version: '1.1.0' });
  await fixture.service.whenIdle();

  const job = await fixture.service.currentJob();

  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'symlink_forbidden');
});
