import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

let modules;
let modulesError;
try {
  const [storeModule, serviceModule, apiModule] = await Promise.all([
    import('../../server/src/lib/task-shelf-store.js'),
    import('../../server/src/lib/task-shelf-service.js'),
    import('../../server/src/modules/task-shelf/index.js'),
  ]);
  modules = { storeModule, serviceModule, apiModule };
} catch (error) {
  modulesError = error;
}

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

function requireModules() {
  assert.ok(
    modules,
    `Сервис и API полки ещё не реализованы: ${modulesError?.message || 'нет экспортов'}`,
  );
  return modules;
}

function payload(overrides = {}) {
  return {
    title: 'Задача на полке',
    reason: 'analysis',
    snapshot: {
      analysis: {
        state: 'queued',
        queuedAt: '2026-08-26T08:00:00.000Z',
        startedAt: null,
        finishedAt: null,
        generatedAt: null,
      },
      pipeline: null,
      b24: null,
    },
    createIfMissing: true,
    ...overrides,
  };
}

async function fixture(t, { enabled = true, identityError = null } = {}) {
  const { storeModule, serviceModule, apiModule } = requireModules();
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-task-shelf-api-'));
  const filePath = path.join(root, 'task-shelf.json');
  t.after(() => rm(root, { recursive: true, force: true }));

  let pluginEnabled = enabled;
  let identity = { baseUrl: 'https://portal.example.test/', userId: 77 };
  const events = [];
  const b24 = {
    async accountIdentity() {
      if (identityError) throw identityError;
      return identity;
    },
  };
  const store = new storeModule.TaskShelfStore({ filePath });
  const shelf = new serviceModule.TaskShelfService({ store, b24 });
  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', (id) => id === 'shelf' && pluginEnabled);
  app.decorate('sse', { broadcast: (event) => events.push(event) });
  app.register(apiModule.default, { shelf });
  t.after(() => app.close());

  return {
    app,
    events,
    filePath,
    setEnabled(value) { pluginEnabled = value; },
    setIdentity(value) { identity = value; },
  };
}

test('GET выводит opaque scope из текущей B24-сессии и запрещает кеш', async (t) => {
  const { app } = await fixture(t);
  const response = await app.inject({
    method: 'GET',
    url: '/api/b24/task-shelf?scope=attacker',
  });

  assert.deepEqual({
    statusCode: response.statusCode,
    cacheControl: response.headers['cache-control'],
    revision: response.json().revision,
    entries: response.json().entries,
    opaqueScope: /^[a-f0-9]{16,}$/i.test(response.json().scope),
    leaksIdentity: /portal\.example|userId|baseUrl/.test(response.body),
  }, {
    statusCode: 200,
    cacheControl: 'no-store',
    revision: 0,
    entries: [],
    opaqueScope: true,
    leaksIdentity: false,
  });
});

test('PUT и DELETE всегда возвращают полный снимок с revision', async (t) => {
  const { app } = await fixture(t);
  const added = await app.inject({
    method: 'PUT',
    url: '/api/b24/task-shelf/0042',
    payload: payload(),
  });
  const removed = await app.inject({
    method: 'DELETE',
    url: '/api/b24/task-shelf/42',
  });

  assert.deepEqual({
    addedStatus: added.statusCode,
    addedRevision: added.json().revision,
    addedIds: added.json().entries?.map((entry) => entry.taskId),
    removedStatus: removed.statusCode,
    removedRevision: removed.json().revision,
    removedEntries: removed.json().entries,
  }, {
    addedStatus: 200,
    addedRevision: 1,
    addedIds: ['42'],
    removedStatus: 200,
    removedRevision: 2,
    removedEntries: [],
  });
});

test('Полка принимает фактическое состояние done завершённого триажа', async (t) => {
  const { app } = await fixture(t);
  const done = await app.inject({
    method: 'PUT',
    url: '/api/b24/task-shelf/42',
    payload: payload({
      snapshot: {
        analysis: {
          state: 'done',
          queuedAt: null,
          startedAt: '2026-08-26T08:00:00.000Z',
          finishedAt: '2026-08-26T08:10:00.000Z',
          generatedAt: '2026-08-26T08:10:01.000Z',
        },
        pipeline: null,
        b24: null,
      },
    }),
  });

  assert.deepEqual({
    statusCode: done.statusCode,
    state: done.json().entries?.[0]?.snapshot?.analysis?.state,
  }, {
    statusCode: 200,
    state: 'done',
  });
});

test('Клиент не может выбрать чужой scope через query или body', async (t) => {
  const { app } = await fixture(t);
  const response = await app.inject({
    method: 'PUT',
    url: '/api/b24/task-shelf/9?scope=attacker',
    payload: { ...payload(), scope: 'attacker', revision: 900, addedAt: '2000-01-01' },
  });

  assert.deepEqual({
    scopeIsClientValue: response.json().scope === 'attacker',
    revision: response.json().revision,
    addedAtIsClientValue: response.json().entries?.[0]?.addedAt === '2000-01-01',
  }, {
    scopeIsClientValue: false,
    revision: 1,
    addedAtIsClientValue: false,
  });
});

test('Смена портала или пользователя переключает изолированный снимок', async (t) => {
  const { app, setIdentity } = await fixture(t);
  const first = await app.inject({
    method: 'PUT',
    url: '/api/b24/task-shelf/11',
    payload: payload(),
  });
  setIdentity({ baseUrl: 'https://other.example.test/', userId: 77 });
  const other = await app.inject({ method: 'GET', url: '/api/b24/task-shelf' });
  setIdentity({ baseUrl: 'https://portal.example.test/', userId: 77 });
  const restored = await app.inject({ method: 'GET', url: '/api/b24/task-shelf' });

  assert.deepEqual({
    scopesDiffer: first.json().scope !== other.json().scope,
    otherEntries: other.json().entries,
    restoredIds: restored.json().entries?.map((entry) => entry.taskId),
  }, {
    scopesDiffer: true,
    otherEntries: [],
    restoredIds: ['11'],
  });
});

test('Выключение плагина закрывает API, но не удаляет сохранённые записи', async (t) => {
  const { app, setEnabled } = await fixture(t);
  await app.inject({ method: 'PUT', url: '/api/b24/task-shelf/42', payload: payload() });
  setEnabled(false);
  const disabled = await app.inject({ method: 'GET', url: '/api/b24/task-shelf' });
  setEnabled(true);
  const restored = await app.inject({ method: 'GET', url: '/api/b24/task-shelf' });

  assert.deepEqual({
    disabledStatus: disabled.statusCode,
    disabledError: disabled.json().error,
    restoredIds: restored.json().entries?.map((entry) => entry.taskId),
  }, {
    disabledStatus: 404,
    disabledError: 'plugin_disabled',
    restoredIds: ['42'],
  });
});

test('Невалидный body получает именованный отказ без изменения полки', async (t) => {
  const { app } = await fixture(t);
  const invalid = await app.inject({
    method: 'PUT',
    url: '/api/b24/task-shelf/42',
    payload: { title: 'Без снимка' },
  });
  const current = await app.inject({ method: 'GET', url: '/api/b24/task-shelf' });

  assert.deepEqual({
    statusCode: invalid.statusCode,
    error: invalid.json().error,
    revision: current.json().revision,
    entries: current.json().entries,
  }, {
    statusCode: 400,
    error: 'bad_request',
    revision: 0,
    entries: [],
  });
});

test('Недоступная B24 identity получает безопасный именованный отказ', async (t) => {
  const secret = 'private identity failure';
  const { app } = await fixture(t, { identityError: new Error(secret) });
  const response = await app.inject({ method: 'GET', url: '/api/b24/task-shelf' });

  assert.deepEqual({
    statusCode: response.statusCode,
    error: response.json().error,
    leaksSecret: response.body.includes(secret),
  }, {
    statusCode: 503,
    error: 'b24_identity_unavailable',
    leaksSecret: false,
  });
});

test('Повреждённое хранилище получает task_shelf_unavailable и сохраняет файл', async (t) => {
  const { app, filePath } = await fixture(t);
  const corrupt = '{"schemaVersion":1';
  await writeFile(filePath, corrupt, { mode: 0o600 });
  const response = await app.inject({ method: 'GET', url: '/api/b24/task-shelf' });

  assert.deepEqual({
    statusCode: response.statusCode,
    error: response.json().error,
    source: await readFile(filePath, 'utf8'),
  }, {
    statusCode: 503,
    error: 'task_shelf_unavailable',
    source: corrupt,
  });
});

test('SSE-инвалидация уходит только после изменения revision', async (t) => {
  const { app, events } = await fixture(t);
  await app.inject({ method: 'PUT', url: '/api/b24/task-shelf/42', payload: payload() });
  await app.inject({ method: 'PUT', url: '/api/b24/task-shelf/42', payload: payload() });
  await app.inject({ method: 'DELETE', url: '/api/b24/task-shelf/777' });
  await app.inject({ method: 'DELETE', url: '/api/b24/task-shelf/42' });

  assert.deepEqual(events, ['task-shelf-changed', 'task-shelf-changed']);
});

test('Поздний acknowledge после DELETE не воскрешает запись', async (t) => {
  const { app } = await fixture(t);
  await app.inject({ method: 'PUT', url: '/api/b24/task-shelf/42', payload: payload() });
  await app.inject({ method: 'DELETE', url: '/api/b24/task-shelf/42' });
  const response = await app.inject({
    method: 'PUT',
    url: '/api/b24/task-shelf/42',
    payload: payload({ createIfMissing: false }),
  });

  assert.deepEqual({
    revision: response.json().revision,
    entries: response.json().entries,
  }, {
    revision: 2,
    entries: [],
  });
});

test('Приложение регистрирует account-scoped полку после живого plugin gate', async () => {
  const [config, app] = await Promise.all([
    readFile(new URL('../../server/src/config.js', import.meta.url), 'utf8'),
    readFile(new URL('../../server/src/app.js', import.meta.url), 'utf8'),
  ]);
  const pluginsPosition = app.lastIndexOf('register(pluginsModule');
  const shelfPosition = app.lastIndexOf('register(taskShelfModule');

  assert.deepEqual({
    configPath: /taskShelfPath[\s\S]*COCKPIT_TASK_SHELF_PATH/.test(config),
    store: /TaskShelfStore/.test(app),
    service: /TaskShelfService/.test(app),
    module: /taskShelfModule/.test(app),
    registeredAfterPlugins: pluginsPosition >= 0 && shelfPosition > pluginsPosition,
  }, {
    configPath: true,
    store: true,
    service: true,
    module: true,
    registeredAfterPlugins: true,
  });
});
