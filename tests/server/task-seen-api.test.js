import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TaskSeenStore } from '../../server/src/lib/taskSeenStore.ts';
import { seenScopeFor, TaskSeenService } from '../../server/src/lib/taskSeenService.ts';
import taskSeenModule from '../../server/src/modules/task-seen/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

async function fixture(t, { identity, identityError } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-task-seen-api-'));
  const filePath = path.join(root, 'task-seen.json');
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
  const store = new TaskSeenStore({ filePath });
  const seen = new TaskSeenService({ store, tracker: b24 });
  const app = Fastify({ logger: false });
  app.register(taskSeenModule, { seen });
  t.after(() => app.close());

  return {
    app,
    calls,
    filePath,
    setIdentity(value) { currentIdentity = value; },
  };
}

test('SEEN-API-01: GET отдаёт server-derived scope и не раскрывает identity', async (t) => {
  const { app, calls } = await fixture(t);
  const response = await app.inject({ method: 'GET', url: '/api/tracker/task-seen' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    scope: seenScopeFor({ baseUrl: 'https://portal.example.test/', userId: 77 }),
    revision: 0,
    initialized: false,
    taskIds: [],
  });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(calls, ['accountIdentity']);
  assert.doesNotMatch(response.body, /portal\.example|userId|baseUrl/);
});

test('SEEN-API-02: POST помечает задачи и повтор идемпотентен', async (t) => {
  const { app } = await fixture(t);

  const first = await app.inject({
    method: 'POST',
    url: '/api/tracker/task-seen',
    payload: { taskIds: ['0042', 43] },
  });
  const repeat = await app.inject({
    method: 'POST',
    url: '/api/tracker/task-seen',
    payload: { taskIds: ['42'] },
  });

  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json().taskIds, ['42', '43']);
  assert.equal(first.json().revision, 1);
  assert.equal(first.json().initialized, false);
  assert.equal(repeat.json().revision, 1);
});

test('SEEN-API-03: initialized поднимает только baseline', async (t) => {
  const { app } = await fixture(t);

  // Открытая из конвейера задача не должна объявлять набор базовым: доска ещё не грузилась.
  const early = await app.inject({
    method: 'POST',
    url: '/api/tracker/task-seen',
    payload: { taskIds: ['5'] },
  });
  assert.equal(early.json().initialized, false);

  const baseline = await app.inject({
    method: 'POST',
    url: '/api/tracker/task-seen',
    payload: { taskIds: ['5', '6'], baseline: true },
  });
  assert.equal(baseline.json().initialized, true);
  assert.deepEqual(baseline.json().taskIds, ['5', '6']);

  const after = await app.inject({ method: 'GET', url: '/api/tracker/task-seen' });
  assert.equal(after.json().initialized, true);
});

test('SEEN-API-04: смена портала или B24-пользователя даёт другой scope', async (t) => {
  const { app, setIdentity } = await fixture(t);
  const first = await app.inject({
    method: 'POST',
    url: '/api/tracker/task-seen',
    payload: { taskIds: ['11'], baseline: true },
  });

  setIdentity({ baseUrl: 'https://other.example.test', userId: 77 });

  const otherPortal = await app.inject({ method: 'GET', url: '/api/tracker/task-seen' });
  setIdentity({ baseUrl: 'https://portal.example.test', userId: 78 });

  const otherUser = await app.inject({ method: 'GET', url: '/api/tracker/task-seen' });

  assert.notEqual(first.json().scope, otherPortal.json().scope);
  assert.notEqual(first.json().scope, otherUser.json().scope);
  assert.notEqual(otherPortal.json().scope, otherUser.json().scope);
  // Чужая учётка не наследует ни отметки, ни базовую линию.
  assert.deepEqual(otherPortal.json().taskIds, []);
  assert.equal(otherPortal.json().initialized, false);
  assert.equal(otherUser.json().initialized, false);
});

test('SEEN-API-05: клиент не может выбрать чужой scope через query или body', async (t) => {
  const { app } = await fixture(t);
  const response = await app.inject({
    method: 'POST',
    url: '/api/tracker/task-seen?scope=attacker',
    payload: { scope: 'attacker', taskIds: ['9'] },
  });

  assert.equal(response.statusCode, 200);
  assert.notEqual(response.json().scope, 'attacker');
  assert.deepEqual(response.json().taskIds, ['9']);
});

test('SEEN-API-06: кривое тело получает стабильный 400 и до B24 не доходит', async (t) => {
  const { app, calls } = await fixture(t);

  const badId = await app.inject({
    method: 'POST',
    url: '/api/tracker/task-seen',
    payload: { taskIds: ['not-a-number'] },
  });
  assert.equal(badId.statusCode, 400);
  assert.deepEqual(badId.json(), {
    error: 'bad_task_id',
    message: 'Некорректный номер задачи.',
  });

  for (const payload of [
    { baseline: true },
    { taskIds: '42' },
    { taskIds: ['1'], baseline: 'yes' },
    { taskIds: Array.from({ length: 1001 }, (_, index) => String(index + 1)) },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tracker/task-seen',
      payload,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload).slice(0, 60));
    assert.equal(response.json().error, 'bad_request');
  }

  assert.deepEqual(calls, []);
});

test('SEEN-API-07: ошибка B24 identity имеет отдельный безопасный 503-контракт', async (t) => {
  const secret = 'private B24 login failure';
  const { app } = await fixture(t, { identityError: new Error(secret) });
  const response = await app.inject({ method: 'GET', url: '/api/tracker/task-seen' });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error, 'b24_identity_unavailable');
  assert.doesNotMatch(response.body, new RegExp(secret));
});

test('SEEN-API-07: повреждённое хранилище имеет отдельный безопасный 503-контракт', async (t) => {
  const { app, filePath } = await fixture(t);
  await writeFile(filePath, '{"schemaVersion":1', { mode: 0o600 });

  const response = await app.inject({ method: 'GET', url: '/api/tracker/task-seen' });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error, 'task_seen_unavailable');
  assert.doesNotMatch(response.body, /schemaVersion/);
});
