import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  studioIntegrationTest,
  studioPluginFixture,
  uploadStudioModel,
} from './helpers/studio3dPluginFixture.js';
import { makeGlb } from './helpers/studio3dGlb.js';

/**
 * Проверки используют действующий C collector/core/loader и реальный P bundle fixture.
 * Переданный explicit development path обязателен в локальных воротах и не маскируется skip.
 */
function integrationTest(name, callback) {
  return studioIntegrationTest(test, name, callback);
}

/**
 * Цена и значения берутся из настоящего core facade, transport — только fake localhost.
 * Сессионный внешний router принимает один durable заказ с заданным UUID.
 */
async function accept(f) {
  const quote = await f.call('POST', '/quote', {
    libraryId: f.libraryId,
    provider: 'tripo',
    operation: 'text-to-model',
    values: { prompt: 'Изолированный исход уведомления' },
  });

  assert.equal(quote.statusCode, 200, quote.body);

  const quoted = quote.json();
  const request = {
    libraryId: f.libraryId,
    idempotencyKey: crypto.randomUUID(),
    provider: 'tripo',
    operation: 'text-to-model',
    values: quoted.validation.values,
    expectedPrice: quoted.quote.total,
    name: 'Персонаж уведомления',
  };
  const accepted = await f.call('POST', '/run', request);

  assert.equal(accepted.statusCode, 202, accepted.body);
  await f.runtime().context.jobs.tick();

  return request;
}

/**
 * Настоящий default entry обрабатывает локальный GLB без ослабления CDN egress policy.
 * Paid ready с явным fake download port отдельно проверен P notification tests.
 */
async function acceptLocal(f) {
  const uploaded = await uploadStudioModel(f, makeGlb({ triangles: 2 }));

  assert.equal(uploaded.statusCode, 200, uploaded.body);

  const created = await f.call('POST', '/models', {
    libraryId: f.libraryId,
    uploadId: uploaded.json().uploadId,
    name: 'Персонаж уведомления',
  });

  assert.equal(created.statusCode, 200, created.body);

  const value = created.json();
  const base = {
    libraryId: f.libraryId,
    provider: 'local',
    operation: 'rotate',
    modelId: value.model.id,
    versionId: value.version.id,
    values: { turn: 'y90' },
  };
  const quoted = await f.call('POST', '/quote', base);

  assert.equal(quoted.statusCode, 200, quoted.body);

  const quote = quoted.json();
  const request = {
    ...base,
    idempotencyKey: crypto.randomUUID(),
    values: quote.validation.values,
    expectedPrice: quote.quote.total,
  };
  const accepted = await f.call('POST', '/run', request);

  assert.equal(accepted.statusCode, 202, accepted.body);
  await f.runtime().context.jobs.tick();

  return request;
}

function live(f) {
  return f.probe.events.filter((event) => event.event === 'plugin-event'
    && event.data.event === 'notification').map((event) => event.data);
}

async function snapshot(f) {
  const response = await f.request('GET', '/api/plugins/notifications');

  assert.equal(response.statusCode, 200, response.body);

  return response.json().plugins.find((entry) => entry.pluginId === 'studio3d');
}

integrationTest('S3D-NOTIFY actual collector/auth принимает тот же durable ready snapshot и live payload',
  async (t) => {
    const f = await studioPluginFixture(t, { web: true });

    assert.equal((await f.request('GET', '/api/plugins/notifications', undefined, null)).statusCode, 401);

    assert.deepEqual((await snapshot(f)).items, []);

    const request = await acceptLocal(f);
    const context = f.runtime().context;

    const events = live(f);
    const saved = await snapshot(f);

    assert.equal(events.length, 1);
    assert.equal(saved.error, null);
    assert.equal(saved.generation, events[0].generation);
    assert.deepEqual(saved.items, [events[0].data]);
    assert.equal(saved.items[0].title.ru, 'Модель «Персонаж уведомления» готова');
    assert.equal(saved.items[0].title.en, 'Model “Персонаж уведомления” is ready');
    assert.equal(saved.items[0].tone, 'accent');
    assert.equal(saved.items[0].sticky, false);

    const intent = await context.intents.get(request.idempotencyKey);

    assert.deepEqual(saved.items[0].params, {
      model: intent.modelId,
      version: intent.children[0].version.id,
    });
    assert.equal(saved.items[0].dedupKey.startsWith(f.libraryId + ':' + request.idempotencyKey + ':'), true);
    assert.equal((await context.intents.get(request.idempotencyKey)).children[0].actual, 0);
    assert.equal((await context.intents.get(request.idempotencyKey)).children[0].paymentState, 'free');
    await snapshot(f);
    assert.equal(live(f).length, 1);

    const modelId = saved.items[0].params.model;
    const deleted = await f.call('DELETE', `/models/${modelId}?libraryId=${f.libraryId}`);

    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.deepEqual(live(f).at(-1).data, { action: 'dismiss-topic', topic: `model:${modelId}` });
    assert.deepEqual((await snapshot(f)).items, []);
    assert.equal(f.fake.requests.filter((item) => item.path === '/v3/generation/text-to-model').length, 0);
  });

integrationTest('S3D-NOTIFY actual core foreign rejected failure даёт cause и одинаковый snapshot/live',
  async (t) => {
    const f = await studioPluginFixture(t, { web: true });

    f.fake.respondOnce('POST', /text-to-model/, 400, { code: 1003, message: 'fixture params' });

    const request = await accept(f);
    const events = live(f);
    const saved = await snapshot(f);
    const intent = await f.runtime().context.intents.get(request.idempotencyKey);
    const child = intent.children[0];

    assert.equal(child.stage, 'rejected');
    assert.equal(child.paymentState, 'unpaid');
    assert.equal(events.length, 1);
    assert.equal(saved.error, null);
    assert.deepEqual(saved.items, [events[0].data]);
    assert.equal(saved.items[0].title.ru, 'Не получилось: «Персонаж уведомления»');
    assert.equal(saved.items[0].title.en, 'Failed: “Персонаж уведомления”');
    assert.deepEqual(saved.items[0].body, { ru: child.error.message, en: child.error.message });
    assert.equal(saved.items[0].sticky, true);
    assert.equal(saved.items[0].tone, 'danger');
    assert.deepEqual(saved.items[0].params, { model: intent.modelId, version: child.version.id });
    await f.runtime().context.jobs.tick();
    assert.equal(live(f).length, 1);
  });

integrationTest('S3D-NOTIFY actual collector не публикует late libraryA под текущим libraryB', async (t) => {
  const f = await studioPluginFixture(t, { web: true });
  const context = f.runtime().context;
  let release;
  let entered;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const admitted = new Promise((resolve) => {
    entered = resolve;
  });

  context.jobs.tasks = async () => {
    entered();
    await barrier;

    return [{
      intentId: '00000000-0000-4000-8000-000000000001',
      childId: 'child-a',
      modelId: 'model-a',
      versionId: 'v01-a',
      modelName: 'Прежняя библиотека',
      label: 'A',
      status: 'ready',
      updatedAt: new Date().toISOString(),
    }];
  };

  const reading = snapshot(f);

  await admitted;

  const changed = await f.plugin('PUT', '/settings', { values: {
    libraryDir: path.join(f.root, 'library-b'),
    autoImport: false,
    lowDiskGb: 10,
  } });

  assert.equal(changed.statusCode, 200, changed.body);
  assert.notEqual(f.runtime().context.library.libraryId, context.library.libraryId);
  release();

  const result = await reading;

  assert.equal(result.error, null);
  assert.deepEqual(result.items, []);
  assert.equal(live(f).length, 0);
});
