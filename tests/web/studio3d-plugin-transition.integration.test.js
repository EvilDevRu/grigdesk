import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { deserialize } from 'node:v8';

import { studioBrowserFixture } from './helpers/studio3dPluginBackground.js';
import { oldStudioWindow } from './helpers/studio3dLegacyWindow.js';
import { studioIntegrationTest, studioUntil } from '../server/helpers/studio3dPluginFixture.js';

const developmentDir = process.env.STUDIO3D_DEVELOPMENT_DIR;
const notFound = () => Object.assign(new Error('Старый API удалён.'), {
  status: 404,
  code: 'not_found',
  body: { error: 'not_found', message: 'Старый API удалён.' },
});

/**
 * Opt-in использует настоящий source helper с обязательным существующим development path.
 * Приёмка packaged payload требует отдельной подстановки package fixture на шаге16.
 */
function integration(name, run) {
  return studioIntegrationTest(test, name, run, { timeout: 20000 });
}

/**
 * Quote приходит от настоящего HTTP API с fake provider, UUID закрепляется до старого child submit.
 * Никакой snapshot текущей библиотеки не переименовывается при восстановлении background.
 */
async function requestFor(f) {
  const response = await f.call('POST', '/quote', {
    libraryId: f.libraryId,
    provider: 'tripo',
    operation: 'text-to-model',
    values: { prompt: 'Синтетический переход старого окна' },
  });

  assert.equal(response.statusCode, 200, response.body);

  const quote = response.json();

  return {
    provider: 'tripo',
    operation: 'text-to-model',
    values: quote.validation.values,
    expectedPrice: quote.quote.total,
    name: 'Старое окно',
    libraryId: f.libraryId,
    idempotencyKey: randomUUID(),
  };
}

/**
 * Fingerprint соответствует прежнему canonical request до добавления UUID, IDB остаётся настоящей.
 * Подготовленная запись применяется только recovery characterization, не подменяет old submit.
 */
function pendingRecord(f, request) {
  const { idempotencyKey, ...snapshot } = request;
  const owner = f.authStore.clientScope;

  return {
    key: idempotencyKey,
    owner,
    libraryId: request.libraryId,
    fingerprint: f.product.inspector.storage.studioFingerprint({
      owner,
      kind: 'run',
      modelId: undefined,
      versionId: undefined,
      request: snapshot,
    }),
    at: Date.now(),
    kind: 'run',
    request: structuredClone(request),
  };
}

/**
 * Старый controller получает исходный input и отдельный уже существующий UUID.
 * Library marker берётся из его init session, как в настоящем закрываемом старом окне.
 */
function beginSubmit(old, request) {
  const { libraryId: _libraryId, idempotencyKey: key, ...input } = request;

  return old.command('submit', { input, key });
}

integration('S3D-TRANSITION characterization: late POST404 старого child блокирует даже после abort',
  async t => {
    const f = await studioBrowserFixture(t, { panel: false });
    const request = await requestFor(f);
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const old = await oldStudioWindow(t, f, {
      owner: f.authStore.clientScope,
      libraryId: f.libraryId,
      network: async (op, body) => {
        assert.equal(op, 'run');
        entered.resolve(body);

        return release.promise;
      },
    });

    t.after(() => release.reject(notFound()));

    const work = beginSubmit(old, request);

    assert.deepEqual(await entered.promise, request);

    const before = await f.storage.list(f.authStore.clientScope);

    assert.equal(before.length, 1);
    assert.equal((await old.command('abort')).data, 'aborted');
    release.reject(notFound());
    assert.equal((await work).error.status, 404);

    const after = await f.storage.list(f.authStore.clientScope);
    const { blocked, ...identity } = after[0];

    assert.equal(typeof blocked, 'string');
    assert.equal(blocked.length > 0, true);
    assert.deepEqual(identity, before[0]);
    assert.equal(old.mutationCount(), 2);
    await old.close();
  });

integration('S3D-TRANSITION characterization: живой old GET404→POST404 удаляет pending', async t => {
  const f = await studioBrowserFixture(t, { panel: false });
  const record = pendingRecord(f, await requestFor(f));
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const order = [];

  await f.storage.put(record);

  const old = await oldStudioWindow(t, f, {
    owner: record.owner,
    libraryId: record.libraryId,
    network: async (op, ...args) => {
      order.push(op);

      if (op === 'job') {
        assert.deepEqual(args, [record.key, record.libraryId]);

        throw notFound();
      }

      assert.equal(op, 'run');
      assert.deepEqual(args, [record.request]);
      entered.resolve();

      return release.promise;
    },
  });

  t.after(() => release.reject(notFound()));

  const recovering = old.command('recover');

  await entered.promise;
  release.reject(notFound());
  await recovering;
  assert.deepEqual(order, ['job', 'run']);
  assert.deepEqual(await f.storage.list(record.owner), []);
  assert.equal(old.events.some(event => event.event === 'dropped' && event.data === record.key), true);
  await old.close();
});

/**
 * При direct update старый JS-context должен завершиться до удаления API и активации нового фона.
 * Shared IDB и disk checkpoint доказывают сохранность записи через настоящий child exit.
 */
async function closeBeforeTransition(f, old, release, owner) {
  const checkpoint = await old.checkpoint('before-exit');
  const mutations = old.mutationCount();

  assert.equal(globalThis.indexedDB, f.factory);
  await old.close();
  assert.equal(old.exited(), true);
  assert.equal(old.events.includes('child-exit'), true);

  const missing = await f.request('GET', '/api/studio3d/state');

  assert.equal(missing.statusCode, 404, missing.body);
  release.reject(notFound());
  await studioUntil(async () => old.suppressedReplies(), value => value === 1);
  assert.equal(old.mutationCount(), mutations);
  assert.deepEqual(await f.storage.list(owner), checkpoint.rows);
  assert.deepEqual(deserialize(await fs.readFile(checkpoint.target)), checkpoint.rows);
  assert.equal(globalThis.indexedDB, f.factory);

  return checkpoint.rows;
}

integration('S3D-TRANSITION supported: exit старого child сохраняет UUID, новый background GETknown без POST',
  async t => {
    const f = await studioBrowserFixture(t, { panel: false });
    const request = await requestFor(f);
    const accepted = Promise.withResolvers();
    const release = Promise.withResolvers();
    const old = await oldStudioWindow(t, f, {
      owner: f.authStore.clientScope,
      libraryId: f.libraryId,
      network: async (op, body) => {
        assert.equal(op, 'run');
        assert.deepEqual(body, request);

        const response = await f.call('POST', '/run', body);

        assert.equal(response.statusCode, 202, response.body);
        accepted.resolve(response.json());

        return release.promise;
      },
    });

    t.after(() => release.reject(notFound()));

    const work = beginSubmit(old, request);
    const result = await accepted.promise;

    assert.equal(result.libraryId, request.libraryId);

    const receipt = await f.call('GET', `/jobs/${request.idempotencyKey}?libraryId=${request.libraryId}`);

    assert.equal(receipt.statusCode, 200, receipt.body);
    assert.equal(receipt.json().intentId, request.idempotencyKey);
    await f.server.studio3d.context.jobs.tick();

    const before = await closeBeforeTransition(f, old, release, f.authStore.clientScope);

    assert.equal(before.length, 1);
    assert.equal(before[0].key, request.idempotencyKey);
    assert.deepEqual(before[0].request, request);
    assert.deepEqual(f.counts(), { panel: 0, background: 0 });
    assert.equal((await work).error.message, 'context_closed');
    await f.login();
    await f.ready();
    await studioUntil(() => f.storage.list(f.authStore.clientScope), rows => rows.length === 0);
    assert.equal(f.requests.some(row => row.path.includes(`/jobs/${request.idempotencyKey}?`)), true);
    assert.equal(f.requests.filter(row => row.method === 'POST' && row.path.endsWith('/run')).length, 0);
    assert.equal(f.fake.requests.filter(row => row.path.endsWith('/text-to-model')).length, 1);
    assert.deepEqual(f.counts(), { panel: 0, background: 1 });
  });

/**
 * Captured legacy sending data не генерируется заново и не получает новые UUID или финансовые поля.
 * SHA проверяется до boot; настоящий runtime восстанавливает неизвестный исход без нового send.
 */
async function unknownScenario() {
  const root = path.join(developmentDir, 'tests/fixtures/server-legacy-v1');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'DATA_SHA.json')));

  for (const row of manifest.filter(row => row.file === 'SCENARIOS.json'
    || row.file.startsWith('submitting-after-send/'))) {
    const bytes = await fs.readFile(path.join(root, row.file));

    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256, row.file);
  }

  const scenarios = JSON.parse(await fs.readFile(path.join(root, 'SCENARIOS.json')));
  const scenario = scenarios.find(row => row.name === 'submitting-after-send');

  assert.ok(scenario);
  assert.equal(scenario.stage, 'submitting');
  assert.equal(scenario.fakePaidPosts, 1);

  return { root, scenario };
}

integration('S3D-TRANSITION supported: old sending→unknown переживает exit и GETknown без повторной оплаты',
  async t => {
    const { root, scenario } = await unknownScenario();
    const f = await studioBrowserFixture(t, {
      panel: false,
      seed: async ({ config }) => fs.cp(path.join(root, 'submitting-after-send/library'),
        config.studio3dDir, { recursive: true }),
    });
    const request = scenario.request;
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const intentPath = path.join(f.config.studio3dDir, '.jobs', scenario.intentId, 'intent.json');
    const beforeJob = await f.call('GET', `/jobs/${scenario.intentId}?libraryId=${scenario.libraryId}`);

    assert.equal(f.libraryId, scenario.libraryId);
    assert.equal(beforeJob.statusCode, 200, beforeJob.body);
    assert.equal(beforeJob.json().children[0].status, 'unknown');

    const beforeDisk = await fs.readFile(intentPath);
    const old = await oldStudioWindow(t, f, {
      owner: f.authStore.clientScope,
      libraryId: scenario.libraryId,
      network: async (op, body) => {
        assert.equal(op, 'run');
        assert.deepEqual(body, request);
        entered.resolve();

        return release.promise;
      },
    });

    t.after(() => release.reject(notFound()));

    const work = beginSubmit(old, request);

    await entered.promise;

    const browserBefore = await closeBeforeTransition(f, old, release, f.authStore.clientScope);

    assert.equal(browserBefore.length, 1);
    assert.equal(browserBefore[0].key, scenario.intentId);
    assert.deepEqual(browserBefore[0].request, scenario.request);
    assert.equal((await work).error.message, 'context_closed');
    await f.login();
    await f.ready();
    await studioUntil(() => f.storage.list(f.authStore.clientScope), rows => rows.length === 0);

    const afterJob = await f.call('GET', `/jobs/${scenario.intentId}?libraryId=${scenario.libraryId}`);
    const tasks = await f.call('GET', '/tasks');

    assert.equal(afterJob.statusCode, 200, afterJob.body);
    assert.equal(afterJob.json().children[0].status, 'unknown');
    assert.equal(tasks.statusCode, 200, tasks.body);
    assert.equal(tasks.json().active.some(row => row.intentId === scenario.intentId
      && row.status === 'unknown'), true);
    assert.deepEqual(await fs.readFile(intentPath), beforeDisk);
    assert.equal(f.requests.some(row => row.path.includes(`/jobs/${scenario.intentId}?`)), true);
    assert.equal(f.requests.filter(row => row.method === 'POST' && row.path.endsWith('/run')).length, 0);
    assert.equal(f.fake.requests.filter(row => row.path.endsWith('/text-to-model')).length, 0);
    assert.equal(f.counts().panel, 0);
  });
