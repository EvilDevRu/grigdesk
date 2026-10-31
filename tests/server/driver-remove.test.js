import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createApplyFs } from '../../server/src/lib/pluginInstall/applyPackage.ts';
import { createTrackerRuntime } from '../../server/src/lib/trackers/runtime.ts';
import { driverInstallFixture, driverRepo, prepareDriver } from './helpers/driverInstallFixture.js';
import { selectTracker, trackerFixture, writeTracker } from './helpers/trackerFixture.js';

const driverId = 'fixture-driver';
const removeUrl = (id = driverId) => `/api/driver-installs/drivers/${id}/remove`;

/**
 * Используется настоящий установленный пакет, общий installer и обычный auth guard.
 * Реквизиты помещаются в отдельный store, чтобы сравнить его байты после удаления.
 */
async function removableFixture(t) {
  const fixture = await trackerFixture(t, {
    setup: (config) => writeTracker(config, driverId),
  });

  fixture.credsStore.writeFor(driverId, { token: 'fixture-owner-secret' });

  return fixture;
}

test('DRIVER-REMOVE-01: свободный пакет удаляется, реквизиты и пометка остаются', async (t) => {
  const fixture = await removableFixture(t);
  const credentials = await readFile(fixture.config.trackerCredentialsPath, 'utf8');
  const response = await fixture.request('POST', removeUrl(), {});

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { id: driverId, restartRequired: true });
  assert.equal(existsSync(path.join(fixture.config.driversDir, driverId)), false);
  assert.equal(await readFile(fixture.config.trackerCredentialsPath, 'utf8'), credentials);
  assert.deepEqual(fixture.runtime.selection.read(), { externalId: null, revision: 0 });

  const descriptor = fixture.runtime.catalog().drivers.find((driver) => driver.id === driverId);

  assert.equal(descriptor.deleted, true);
  assert.equal(descriptor.status, 'restartRequired');
  assert.equal(descriptor.configured, false);
  assert.deepEqual(fixture.runtime.registry.activeIds, ['own']);
  assert.equal(fixture.events.filter((event) => event.name === 'trackers-changed').length, 1);
  assert.equal((await fixture.request('POST', removeUrl(), {})).statusCode, 404);
});

test('DRIVER-REMOVE-02: выбранный пакет ждёт вызов, закрывает допуск и сбрасывает выбор', async (t) => {
  const fixture = await removableFixture(t);

  await selectTracker(fixture, driverId);

  const revision = fixture.runtime.selection.read().revision;
  const release = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const replacing = Promise.withResolvers();
  const registry = fixture.runtime.registry;
  const original = registry.prepareReplace.bind(registry);

  t.after(() => release.resolve());
  t.mock.method(registry, 'prepareReplace', (...args) => {
    const pending = original(...args);

    replacing.resolve();

    return pending;
  });
  fixture.events.length = 0;

  const accepted = registry.call(driverId, async () => {
    entered.resolve();
    await release.promise;

    return 'finished';
  });

  await entered.promise;

  const removal = fixture.request('POST', removeUrl(), {});

  await replacing.promise;
  await assert.rejects(registry.call(driverId, async () => 'new'), { code: 'tracker_unavailable' });
  assert.equal(existsSync(path.join(fixture.config.driversDir, driverId)), true);
  assert.equal(fixture.events.length, 0);
  assert.equal((await fixture.request('POST', removeUrl(), {})).statusCode, 409);
  release.resolve();
  assert.equal(await accepted, 'finished');
  assert.equal((await removal).statusCode, 200);
  assert.deepEqual(fixture.runtime.selection.read(), { externalId: null, revision: revision + 1 });
  assert.deepEqual(fixture.events.filter((event) => event.name === 'trackers-changed'), [{
    name: 'trackers-changed', payload: { externalId: null, revision: revision + 1 },
  }]);
  assert.equal((await fixture.request('GET', '/api/grigdesk-tasks')).json().trackerConfigured, false);
  assert.deepEqual(fixture.credsStore.readFor(driverId), { token: 'fixture-owner-secret' });

  const invalid = await fixture.request('POST', '/api/trackers/settings', {
    externalId: driverId, expectedRevision: revision + 1,
  });

  assert.equal(invalid.statusCode, 400);
  assert.equal(fixture.runtime.selection.read().externalId, null);
});

test('DRIVER-REMOVE-03: занятый заменой пакет даёт прежний 409 и остаётся на диске', async (t) => {
  const fixture = await removableFixture(t);
  const lease = await fixture.runtime.registry.prepareReplace(driverId, new AbortController().signal);

  t.after(() => lease.finish('reverted'));

  const response = await fixture.request('POST', removeUrl(), {});

  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error, 'install_busy');
  assert.equal(existsSync(path.join(fixture.config.driversDir, driverId)), true);
});

test('DRIVER-REMOVE-04: установка блокирует удаление, неизвестный id и own дают 404', async (t) => {
  const fixture = await removableFixture(t);

  for (const id of ['unknown-driver', 'own']) {
    assert.equal((await fixture.request('POST', removeUrl(id), {})).statusCode, 404);
  }

  const repo = await driverRepo(t);

  await repo.release('1.0.0');
  await prepareDriver(fixture.runtime.installs, repo.url);

  const response = await fixture.request('POST', removeUrl(), {});

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error, 'install_busy');
  assert.equal(existsSync(path.join(fixture.config.driversDir, driverId)), true);
});

test('DRIVER-REMOVE-05: удаление требует сессию, свой Origin, JSON и пустое тело', async (t) => {
  const fixture = await removableFixture(t);

  const anonymous = await fixture.app.inject({
    method: 'POST',
    url: removeUrl(),
    payload: {},
  });

  assert.equal(anonymous.statusCode, 401);

  for (const [headers, payload, status] of [
    [{ 'x-grigdesk-token': 'tracker-test-cli' }, {}, 403],
    [{ ...fixture.headers, origin: 'http://foreign.fixture' }, {}, 403],
    [{ ...fixture.headers, 'content-type': 'text/plain' }, '{}', 415],
    [fixture.headers, { extra: true }, 400],
  ]) {
    const response = await fixture.app.inject({
      method: 'POST',
      url: removeUrl(),
      headers,
      payload,
    });

    assert.equal(response.statusCode, status, response.body);
  }

  assert.equal(existsSync(path.join(fixture.config.driversDir, driverId)), true);
});

test('DRIVER-REMOVE-06: после рестарта пометка исчезает, переустановка сохраняет реквизиты', async (t) => {
  const fixture = await removableFixture(t);

  await selectTracker(fixture, driverId);
  assert.equal((await fixture.request('POST', removeUrl(), {})).statusCode, 200);
  await fixture.runtime.close();

  const restarted = await createTrackerRuntime({
    ...fixture.moduleOptions,
    config: fixture.config,
    credsStore: fixture.credsStore,
  });

  try {
    assert.equal(restarted.catalog().drivers.some((driver) => driver.id === driverId), false);
    assert.equal(restarted.selection.read().externalId, null);

    await writeTracker(fixture.config, driverId);
    await restarted.registry.refresh();
    assert.equal(restarted.catalog().drivers.find((driver) => driver.id === driverId).deleted, undefined);
    assert.deepEqual(restarted.credsStore.readFor(driverId), { token: 'fixture-owner-secret' });
  } finally {
    await restarted.close();
  }
});

test('DRIVER-REMOVE-07: managed current/previous удаляются, пакет переустанавливается', async (t) => {
  const fixture = await driverInstallFixture(t);
  const repo = await driverRepo(t);

  for (const version of ['1.0.0', '1.1.0']) {
    await repo.release(version);

    const ready = await prepareDriver(fixture.service, repo.url, version);

    await fixture.service.apply(ready.id, ready.reviewToken);
  }

  const previous = path.join(fixture.service.workDir, 'previous', repo.id);

  assert.equal(existsSync(previous), true);
  await fixture.service.remove(repo.id);
  assert.equal(existsSync(previous), false);
  assert.equal(await fixture.service.describe(repo.id), null);

  const ready = await prepareDriver(fixture.service, repo.url);

  assert.equal((await fixture.service.apply(ready.id, ready.reviewToken)).status, 'done');
  assert.equal(fixture.service.removedIds().includes(repo.id), false);
});

test('DRIVER-REMOVE-08: recovery завершает остановку между переносом пакета и commit журнала', async (t) => {
  const fixture = await driverInstallFixture(t);

  await writeTracker({ driversDir: fixture.driversDir }, driverId);
  await fixture.service.close();

  const roots = { pluginsDir: fixture.driversDir, workDir: fixture.service.workDir };
  const fs = createApplyFs(roots);
  const directory = path.join(fixture.driversDir, driverId);
  const current = await fs.lstatIdentity(directory, []);
  const transactionId = randomUUID();

  await fixture.service.store.mutate((state) => {
    state.removal = {
      pluginId: driverId,
      transactionId,
      previousTransactionId: randomUUID(),
      current,
      previous: null,
      npmDirs: [],
      previousNpmDirs: [],
    };
  });

  const transaction = path.join(roots.workDir, 'transactions', transactionId);

  await fs.ensureDir(transaction);
  await fs.rename(directory, path.join(transaction, 'retired'));

  const restarted = await driverInstallFixture(t, { root: fixture.root });

  try {
    assert.equal(restarted.service.health(), null);
    assert.equal(existsSync(directory), false);
    assert.equal(existsSync(transaction), false);
    assert.deepEqual(restarted.service.removedIds(), [driverId]);
  } finally {
    await restarted.service.close();
  }
});

test('DRIVER-REMOVE-09: удаление другого пакета сохраняет выбранный источник и поколение', async (t) => {
  const fixture = await removableFixture(t);

  await writeTracker(fixture.config, 'other-driver');
  await fixture.runtime.registry.refresh();
  await selectTracker(fixture, 'other-driver');

  const selection = fixture.runtime.selection.read();

  assert.equal((await fixture.request('POST', removeUrl(), {})).statusCode, 200);
  assert.deepEqual(fixture.runtime.selection.read(), selection);
  assert.ok(fixture.runtime.registry.activeIds.includes('other-driver'));
});

test('DRIVER-REMOVE-10: переустановка снимает deleted, прежний ESM остаётся закрытым', async (t) => {
  const fixture = await removableFixture(t);

  await selectTracker(fixture, driverId);
  assert.equal((await fixture.request('POST', removeUrl(), {})).statusCode, 200);

  const repo = await driverRepo(t, { id: driverId });

  await repo.release('1.0.0');

  const ready = await prepareDriver(fixture.runtime.installs, repo.url);

  assert.equal((await fixture.runtime.installs.apply(ready.id, ready.reviewToken)).status, 'done');

  const descriptor = fixture.runtime.catalog().drivers.find((driver) => driver.id === driverId);

  assert.equal(descriptor.deleted, false);
  assert.equal(descriptor.status, 'restartRequired');
  await assert.rejects(fixture.runtime.registry.call(driverId, async () => 'old'));
  assert.deepEqual(fixture.credsStore.readFor(driverId), { token: 'fixture-owner-secret' });
});

test('DRIVER-REMOVE-11: неудачный импорт также можно удалить без повторного исполнения', async (t) => {
  const fixture = await trackerFixture(t, {
    setup: (config) => writeTracker(config, driverId, {
      code: 'throw new Error("fixture failed import"); export default () => ({});',
    }),
  });

  await selectTracker(fixture, driverId);
  assert.equal(fixture.runtime.registry.isLoaded(driverId), true);
  assert.equal((await fixture.request('POST', removeUrl(), {})).statusCode, 200);
  assert.equal(fixture.runtime.selection.read().externalId, null);
});
