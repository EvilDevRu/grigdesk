import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { B24Adapter } from '../../server/src/adapters/b24.ts';
import { TaskFavoritesStore } from '../../server/src/lib/taskFavoritesStore.ts';
import {
  favoriteScopeFor,
  TaskFavoritesService,
} from '../../server/src/lib/taskFavoritesService.ts';
import taskFavoritesModule from '../../server/src/modules/task-favorites/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function fixture(t, { identity, identityError } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-task-favorites-api-'));
  const filePath = path.join(root, 'task-favorites.json');
  t.after(() => rm(root, { recursive: true, force: true }));

  const calls = [];
  let currentIdentity = identity || { baseUrl: 'https://portal.example.test/', userId: 77 };
  const b24 = {
    async accountIdentity() {
      calls.push('accountIdentity');
      if (identityError) throw identityError;
      return currentIdentity;
    },
  };
  const store = new TaskFavoritesStore({ filePath });
  const favorites = new TaskFavoritesService({ store, b24 });
  const app = Fastify({ logger: false });
  app.register(taskFavoritesModule, { favorites });
  t.after(() => app.close());

  return {
    app,
    calls,
    filePath,
    setIdentity(value) { currentIdentity = value; },
  };
}

test('API-01: GET возвращает server-derived scope и не раскрывает identity', async (t) => {
  const { app, calls } = await fixture(t);
  const response = await app.inject({ method: 'GET', url: '/api/b24/task-favorites' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    scope: favoriteScopeFor({ baseUrl: 'https://portal.example.test/', userId: 77 }),
    revision: 0,
    taskIds: [],
  });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(calls, ['accountIdentity']);
  assert.doesNotMatch(response.body, /portal\.example|userId|baseUrl/);
});

test('API-02/03: PUT и DELETE возвращают канон, одинаковая мутация идемпотентна', async (t) => {
  const { app } = await fixture(t);

  const add = await app.inject({ method: 'PUT', url: '/api/b24/task-favorites/0042' });
  const repeat = await app.inject({ method: 'PUT', url: '/api/b24/task-favorites/42' });
  const remove = await app.inject({ method: 'DELETE', url: '/api/b24/task-favorites/42' });
  const repeatRemove = await app.inject({ method: 'DELETE', url: '/api/b24/task-favorites/42' });

  assert.equal(add.statusCode, 200);
  assert.deepEqual(add.json().taskIds, ['42']);
  assert.equal(add.json().revision, 1);
  assert.equal(repeat.json().revision, 1);
  assert.deepEqual(remove.json().taskIds, []);
  assert.equal(remove.json().revision, 2);
  assert.equal(repeatRemove.json().revision, 2);
});

test('API-04: смена портала или B24-пользователя создаёт другой scope', async (t) => {
  const { app, setIdentity } = await fixture(t);
  const first = await app.inject({ method: 'PUT', url: '/api/b24/task-favorites/11' });

  setIdentity({ baseUrl: 'https://other.example.test', userId: 77 });
  const otherPortal = await app.inject({ method: 'GET', url: '/api/b24/task-favorites' });
  setIdentity({ baseUrl: 'https://portal.example.test', userId: 78 });
  const otherUser = await app.inject({ method: 'GET', url: '/api/b24/task-favorites' });

  assert.notEqual(first.json().scope, otherPortal.json().scope);
  assert.notEqual(first.json().scope, otherUser.json().scope);
  assert.notEqual(otherPortal.json().scope, otherUser.json().scope);
  assert.deepEqual(otherPortal.json().taskIds, []);
  assert.deepEqual(otherUser.json().taskIds, []);
});

test('API-05: query и body не позволяют клиенту выбрать чужой scope', async (t) => {
  const { app } = await fixture(t);
  const response = await app.inject({
    method: 'PUT',
    url: '/api/b24/task-favorites/9?scope=attacker',
    payload: { scope: 'attacker', taskIds: ['999'] },
  });

  assert.equal(response.statusCode, 200);
  assert.notEqual(response.json().scope, 'attacker');
  assert.deepEqual(response.json().taskIds, ['9']);
});

test('API-06: неверный task id получает стабильный 400', async (t) => {
  const { app, calls } = await fixture(t);
  const response = await app.inject({
    method: 'PUT',
    url: '/api/b24/task-favorites/not-a-number',
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: 'bad_task_id',
    message: 'Некорректный номер задачи.',
  });
  assert.deepEqual(calls, []);
});

test('API-07: ошибка B24 identity имеет отдельный безопасный 503-контракт', async (t) => {
  const secret = 'private B24 login failure';
  const { app } = await fixture(t, { identityError: new Error(secret) });
  const response = await app.inject({ method: 'GET', url: '/api/b24/task-favorites' });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error, 'b24_identity_unavailable');
  assert.doesNotMatch(response.body, new RegExp(secret));
});

test('API-07: повреждённое хранилище имеет отдельный безопасный 503-контракт', async (t) => {
  const { app, filePath } = await fixture(t);
  await writeFile(filePath, '{"schemaVersion":1', { mode: 0o600 });

  const response = await app.inject({ method: 'GET', url: '/api/b24/task-favorites' });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error, 'task_favorites_unavailable');
  assert.doesNotMatch(response.body, /schemaVersion/);
});

test('B24 identity кешируется после первого определения и сбрасывается с credentials', async () => {
  let discoveries = 0;
  const client = {
    baseUrl: 'https://portal.example.test/',
    async discoverUserId() {
      discoveries += 1;
      return 77;
    },
  };
  const adapter = new B24Adapter({
    credsStore: { read: () => ({ baseUrl: client.baseUrl, login: 'user', password: 'secret' }) },
    cookiePath: '/tmp/not-used-task-favorites-cookie',
  });
  adapter.client = () => client;

  assert.deepEqual(await adapter.accountIdentity(), {
    baseUrl: 'https://portal.example.test/',
    userId: 77,
  });
  assert.deepEqual(await adapter.accountIdentity(), {
    baseUrl: 'https://portal.example.test/',
    userId: 77,
  });
  assert.equal(discoveries, 1);

  adapter.invalidate();
  await adapter.accountIdentity();
  assert.equal(discoveries, 2);
});
