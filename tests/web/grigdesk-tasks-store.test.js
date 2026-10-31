import assert from 'node:assert/strict';
import test from 'node:test';

import { loadMigrationModule, migrationHarness } from './helpers/compile-vue.js';

const { createPinia, setActivePinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs');
const OWN = {
  id: '100000000001',
  source: 'grigdesk',
  title: 'Своя задача',
  description: '<текст>&',
  projectId: 'beta',
  projectTitle: 'Проект Бета',
  sourceUrl: 'http://client.test/#/board?openTask=100000000001',
  createdAt: '2026-10-24T00:00:00.000Z',
};

/**
 * Настоящий кеш получает управляемый HTTP-транспорт с тем же классом ApiError.
 * Подменный ответ Б24 валиден: RED показывает ошибку выбора источника, а не фикстуры.
 */
async function fixture(reply) {
  setActivePinia(createPinia());

  const calls = [];

  migrationHarness.api = {
    async get(url) {
      calls.push(url);

      return reply(url);
    },
  };

  const { useTasksStore } = await loadMigrationModule('src/stores/tasks.js', 'src/stores/tasks.ts');

  return { store: useTasksStore(), calls };
}

test('LOCAL-LOAD-01: собственная запись читается один раз и кешируется без Б24', async () => {
  const { store, calls } = await fixture((url) => (
    url.startsWith('/api/grigdesk-tasks/') ? OWN : { id: OWN.id, title: 'Чужая задача портала' }
  ));
  const loaded = await store.load(OWN.id);

  assert.equal(loaded.source, 'grigdesk');
  assert.equal(loaded.description, OWN.description);
  assert.equal(loaded.projectId, 'beta');
  assert.deepEqual(await store.load(OWN.id), loaded);
  assert.deepEqual(calls, [`/api/grigdesk-tasks/${OWN.id}`]);
});

test('LOCAL-LOAD-01: точный own 404 в своём диапазоне разрешает Б24 GET и Telegram', async () => {
  const portal = {
    id: Number(OWN.id),
    title: 'Портальная задача',
    telegram: { links: [] }
  };
  const { store, calls } = await fixture((url) => {
    if (url.startsWith('/api/grigdesk-tasks/')) {
      throw new migrationHarness.ApiError('Нет своей задачи', 404, { error: 'grigdesk_task_not_found' });
    }

    return portal;
  });
  const loaded = await store.load(OWN.id);

  assert.equal(loaded.title, portal.title);
  assert.deepEqual(loaded.telegram, portal.telegram);
  assert.deepEqual(await store.load(OWN.id), loaded);
  assert.deepEqual(calls, [`/api/grigdesk-tasks/${OWN.id}`, `/api/tracker/task/${OWN.id}`]);
});

test('LOCAL-LOAD-02: короткий номер читает Б24 без own API, номер диапазона проверяет источник', async () => {
  const portal = {
    id: 42,
    title: 'Портальная задача',
    telegram: { links: [] },
  };
  const { store, calls } = await fixture((url) => {
    if (url === `/api/grigdesk-tasks/${OWN.id}`) {
      throw new migrationHarness.ApiError('Нет своей задачи', 404, { error: 'grigdesk_task_not_found' });
    }

    if (url.startsWith('/api/grigdesk-tasks/')) {
      throw new migrationHarness.ApiError('Хранилище недоступно', 503, { error: 'unavailable' });
    }

    return url === '/api/tracker/task/42' ? portal : { ...portal, id: Number(OWN.id) };
  });
  const short = await store.load('42');

  assert.equal(short.title, portal.title);
  assert.deepEqual(short.telegram, portal.telegram);
  assert.deepEqual(calls, ['/api/tracker/task/42']);

  const ranged = await store.load(OWN.id);

  assert.equal(ranged.title, portal.title);
  assert.deepEqual(ranged.telegram, portal.telegram);
  assert.deepEqual(calls, [
    '/api/tracker/task/42',
    `/api/grigdesk-tasks/${OWN.id}`,
    `/api/tracker/task/${OWN.id}`,
  ]);
});

for (const [name, failure] of [
  ...[401, 403, 503].map((status) => [String(status),
    new migrationHarness.ApiError('Отказ', status, { error: 'unavailable' })]),
  ['другой 404', new migrationHarness.ApiError('Нет маршрута', 404, { error: 'not_found' })],
  ['сеть', new Error('Обрыв сети')],
  ['битый DTO', { ...OWN, source: 'b24' }],
  ['чужой id', { ...OWN, id: '100000000002' }],
]) {
  test(`LOCAL-LOAD-01: ${name} не разрешает Б24 и не заменяет кеш`, async () => {
    let broken = false;
    const { store, calls } = await fixture((url) => {
      if (!url.startsWith('/api/grigdesk-tasks/')) {
        return { id: OWN.id, title: 'Чужой портал' };
      }

      if (!broken) {
        return OWN;
      }

      if (failure instanceof Error) {
        throw failure;
      }

      return failure;
    });

    await store.load(OWN.id);

    const previous = store.details[OWN.id];

    broken = true;
    await assert.rejects(store.load(OWN.id, true));
    assert.equal(store.details[OWN.id], previous);
    assert.deepEqual(calls, [`/api/grigdesk-tasks/${OWN.id}`, `/api/grigdesk-tasks/${OWN.id}`]);
  });
}
