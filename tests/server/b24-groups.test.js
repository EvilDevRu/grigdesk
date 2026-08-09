// Справочник проектов Битрикс24 для селекта GROUP_ID задачи.
// Портал работает через браузерную сессию без REST-токена, поэтому список
// берётся штатным socialnetwork component action с sessid.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { B24Client } from '../../server/src/lib/b24/b24-client.js';
import b24Module from '../../server/src/modules/b24/index.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

test('нормализация проектов приводит id к числу, чистит мусор и сортирует имена', () => {
  assert.deepEqual(B24Client.normalizeGroups([
    { id: '32', name: 'arsenkin.ru', type: 'project' },
    { ID: '41', NAME: ' Магазин ', TYPE: 'PROJECT' },
    { id: '0', name: 'Все проекты', type: 'project' },
    { id: 'oops', name: 'Мусор' },
  ]), [
    { id: 41, name: 'Магазин', type: 'project' },
    { id: 32, name: 'arsenkin.ru', type: 'project' },
  ]);
});

test('список проектов читает страницы nav и кешируется на время жизни B24-клиента', async () => {
  const client = Object.create(B24Client.prototype);
  const paths = [];
  client.ensureAuth = async () => {};
  client.getSessid = async () => 'csrf-token';
  client.raw = async (path) => {
    paths.push(path);
    const page = path.match(/page-(\d+)-size/)?.[1];
    const workgroups = page === '1'
      ? Array.from({ length: 50 }, (_, index) => ({ id: String(index + 1), name: `Проект ${index + 1}`, type: 'project' }))
      : [{ id: '77', name: 'Последний', type: 'project' }];
    return { json: async () => ({ status: 'success', data: { workgroups } }) };
  };

  const first = await client.listGroups();
  assert.equal(first.length, 51);
  assert.ok(first.some((group) => group.id === 77 && group.name === 'Последний'));
  assert.deepEqual(paths.map((path) => path.match(/page-(\d+)-size/)?.[1]), ['1', '2']);

  await client.listGroups();
  assert.equal(paths.length, 2, 'повторное чтение должно прийти из кеша');

  await client.listGroups(true);
  assert.equal(paths.length, 4, 'force должен перечитать все страницы');
});

async function appWithGroups(t, listGroups) {
  const app = Fastify({ logger: false });
  app.register(b24Module, {
    b24: {
      listGroups,
      getDashboard: async () => ({}),
      taskDetail: async () => null,
      findUsers: async () => [],
    },
  });
  await app.ready();
  t.after(() => app.close());
  return app;
}

test('GET /api/b24/groups отдаёт узкий справочник id + имя', async (t) => {
  const groups = [{ id: 32, name: 'arsenkin.ru', type: 'project' }];
  const app = await appWithGroups(t, async () => groups);
  const response = await app.inject({ method: 'GET', url: '/api/b24/groups' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { groups });
});

test('ошибка портала у списка проектов остаётся именованным b24_error', async (t) => {
  const app = await appWithGroups(t, async () => { throw new Error('портал недоступен'); });
  const response = await app.inject({ method: 'GET', url: '/api/b24/groups' });

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), { error: 'b24_error', message: 'портал недоступен' });
});
