import assert from 'node:assert/strict';
import test from 'node:test';

import { protocolList, protocolReconcile } from './helpers/chat-protocol.js';

import { api as realApi } from '../../web/src/shared/apiClient.ts';
import { chatStoreFixture, sseOf } from './helpers/chat-store.js';
import {
  drain, loadApi, loadClock, memoryStorage, streamFetch,
  SERVER_CHAT, SNAPSHOT_KEY, LEGACY_KEY,
} from './helpers/chat-load.js';

test('LOAD-01', async (t) => {
  await t.test('ожидание ответа', async (sub) => {
    memoryStorage(sub);

    const gate = Promise.withResolvers();
    const { api } = loadApi(() => gate.promise);
    const chat = await chatStoreFixture({}, { api, unloaded: true });
    const loading = chat._load();

    sub.after(async () => {
      chat.$dispose();
      gate.resolve({ sessions: [SERVER_CHAT], archived: [] });
      await loading;
    });
    await drain();
    assert.equal(chat.loaded, false);
    assert.equal(chat.loading, true, 'ожидание не выдаёт загруженную пустоту');
  });

  const cases = [
    ['сеть', new TypeError('Сети нет'), 'network'],
    ['тишина', new DOMException('Нет данных', 'TimeoutError'), 'timeout'],
    ['непреднамеренная отмена', new DOMException('Обрыв', 'AbortError'), 'timeout'],
    ['HTTP 503', Object.assign(new Error('HTTP 503'), { status: 503 }), 'server'],
    ['invalid JSON', new SyntaxError('Unexpected token'), 'server'],
    ['обрезанный JSON', new SyntaxError('Unexpected end of JSON input'), 'server'],
    ['нет списков', { compactWindow: 123 }, 'server'],
    ['чужой тип ответа', '<html>Ошибка</html>', 'server'],
    ['HTTP 401', Object.assign(new Error('HTTP 401'), { status: 401 }), 'access'],
    ['HTTP 403', Object.assign(new Error('HTTP 403'), { status: 403 }), 'access'],
  ];

  for (const [name, response, category] of cases) {
    await t.test(name, async (sub) => {
      memoryStorage(sub);

      const { api } = loadApi(async () => {
        if (response instanceof Error) {
          throw response;
        }

        return response;
      });
      const chat = await chatStoreFixture({}, { api, unloaded: true });

      sub.after(() => chat.$dispose());
      await assert.doesNotReject(chat._load());
      assert.equal(chat.loaded, false, 'ошибка GET не считается успешным пустым списком');
      assert.equal(chat.loading, false);
      assert.equal(chat.loadError, category);
      assert.deepEqual(chat.sessions, []);
    });
  }
});

test('LOAD-02', async (t) => {
  const storage = memoryStorage(t);
  const gate = Promise.withResolvers();
  const { api, calls } = loadApi(() => gate.promise);
  const originalGet = api.get;
  const originalPost = api.post;

  api.post = async (url, body, options) => {
    if (url === '/api/chat/store/reconcile') {
      calls.push(['POST', url, body, options]);

      return protocolReconcile({ pending: [{
        id: 'pending-1',
        chatKey: SERVER_CHAT.id,
        reply: 'Поздний ответ',
        at: 400,
      }] }, body.loadedIds);
    }

    return originalPost(url, body, options);
  };

  api.get = async (url, options) => {
    if (url.startsWith('/api/chat/turns?')) {
      calls.push(['GET', url, options]);

      return { turns: {} };
    }

    return originalGet(url, options);
  };

  const chat = await chatStoreFixture({}, { api, unloaded: true });
  const clock = loadClock(t);
  const ensuring = chat.ensure();

  t.after(async () => {
    chat.$dispose();
    gate.reject(new TypeError('Сети нет'));
    await ensuring;
  });
  await drain();

  const before = JSON.stringify({
    sessions: chat.sessions,
    activeId: chat.activeId,
    defModel: chat.defModel,
  });
  const newId = chat.newSession();
  const after = JSON.stringify({
    sessions: chat.sessions,
    activeId: chat.activeId,
    defModel: chat.defModel,
  });

  chat.sessions = [{
    ...SERVER_CHAT,
    workdirInitializing: true,
    workdir: { kind: 'grigdesk' },
    messages: [{
      role: 'user',
      text: 'Вопрос',
      turnId: 'turn-1',
      delivery: 'sending',
    }],
  }];
  chat.workdirProtocol = 1;
  chat.turnProtocol = 1;
  chat.defModel = 'локальный-дефолт';
  chat._persist(true);
  chat._persist();

  const writer = await chat._writeChat(SERVER_CHAT.id, { force: true }).then(() => null, (error) => error);
  const putter = await chat._putChat(SERVER_CHAT.id, true).then(() => null, (error) => error);

  await chat._collectPending();
  await chat._loadActive();
  await chat._reconcileDeliveries();
  sseOf(chat)('hello', {});
  await clock.tick(500);
  gate.reject(new TypeError('Сеть оборвалась'));
  await ensuring;
  await clock.tick(500);

  assert.deepEqual(calls.filter(([method]) => method !== 'GET'), [],
    'до загрузки нет PUT/DELETE истории, меты, pending и POST workdir');
  assert.equal(newId, null);
  assert.equal(after, before, 'создание не меняет локальную историю и мету');
  assert.ok(writer instanceof Error, 'writer обязан отклониться, а не подтвердить запись');
  assert.ok(putter instanceof Error, 'прямой PUT обязан отклониться');
  assert.equal(storage.calls.some(([kind]) => kind !== 'get'), false, 'копия не перезаписывается');
});

test('LOAD-02: уже запланированная запись повторно проверяет ready', async (t) => {
  const storage = memoryStorage(t);
  const { api, calls } = loadApi();
  const chat = await chatStoreFixture({ sessions: [{ ...SERVER_CHAT }] }, { api });
  const clock = loadClock(t);

  t.after(() => chat.$dispose());
  chat.sessions[0].draft = 'Новая правка';
  chat._persist();
  chat.loaded = false;
  await clock.tick(500);
  assert.deepEqual(calls.filter(([method]) => method !== 'GET'), []);
  assert.equal(storage.calls.some(([kind]) => kind !== 'get'), false);
});

test('LOAD-03', async (t) => {
  const snapshot = JSON.stringify({ sessions: [{ ...SERVER_CHAT }], archived: [] });
  const legacy = JSON.stringify({ sessions: [{ ...SERVER_CHAT, id: 'legacy' }], archived: [] });
  const storage = memoryStorage(t, { [SNAPSHOT_KEY]: snapshot, [LEGACY_KEY]: legacy });
  let failed = true;
  const { api } = loadApi(async () => {
    if (failed) {
      throw new TypeError('Нет связи');
    }

    return { sessions: [{ ...SERVER_CHAT, updatedAt: 1000 }], archived: [] };
  });
  const chat = await chatStoreFixture({}, { api, unloaded: true });

  t.after(() => chat.$dispose());
  await chat._load();
  assert.deepEqual(chat.sessions, [], 'неподтверждённая копия скрыта');
  assert.deepEqual(chat.archived, []);
  assert.deepEqual(storage.calls.filter(([, key]) => [SNAPSHOT_KEY, LEGACY_KEY].includes(key)), []);
  assert.equal(storage.values.get(SNAPSHOT_KEY), snapshot);
  assert.equal(storage.values.get(LEGACY_KEY), legacy);
  failed = false;
  await chat._load();
  assert.equal(chat.loaded, true);
  assert.equal(chat.loadError, null);
  assert.deepEqual(chat.sessions.map((item) => item.id), [SERVER_CHAT.id]);
});

test('LOAD-04', async (t) => {
  memoryStorage(t);

  let gate = Promise.withResolvers();
  const { api, calls } = loadApi(() => gate.promise);
  const chat = await chatStoreFixture({}, { api, unloaded: true });
  const jobs = [chat.ensure(), chat.revealChat(SERVER_CHAT.id), chat._load(), chat._load()];

  t.after(async () => {
    gate.resolve({ sessions: [SERVER_CHAT], archived: [] });
    await Promise.all(jobs);
    await drain();
    chat.loaded = false;
    chat.$dispose();
  });
  await drain();
  assert.equal(calls.filter(([, url]) => url === '/api/chat/store/list').length, 1);
  gate.reject(new TypeError('Нет связи'));
  await Promise.all(jobs);
  gate = Promise.withResolvers();
  jobs.push(chat.ensure(), chat.revealChat(SERVER_CHAT.id), chat._load(), chat._load());
  await drain();
  assert.equal(calls.filter(([, url]) => url === '/api/chat/store/list').length, 2,
    'после отказа single-flight освобождается для новой попытки');
  gate.resolve({ sessions: [SERVER_CHAT], archived: [] });
  await Promise.all(jobs);
  assert.equal(chat.loaded, true);
  assert.equal(chat.activeId, SERVER_CHAT.id);
  assert.equal(chat.revealRequest, SERVER_CHAT.id);
  assert.equal(calls.filter(([, url]) => url === '/api/chat/store/reconcile').length, 1);
  assert.equal(calls.filter(([, url]) => url === '/api/chat/waiting?include=ssh,db').length, 1);
  assert.equal(calls.filter(([, url]) => url === '/api/chat/active').length, 1);
});

test('LOAD-05', async (t) => {
  await t.test('список и сверка с watchdog, соседние чтения без него', async (sub) => {
    memoryStorage(sub);

    const { api, calls } = loadApi();
    const chat = await chatStoreFixture({}, { api, unloaded: true });
    const clock = loadClock(sub);

    sub.after(() => chat.$dispose());
    await chat._load();
    await clock.tick(2001);
    await chat._resyncStore();

    const full = calls.filter(([method, url]) => (method === 'GET' && url === '/api/chat/store/list')
      || (method === 'POST' && url === '/api/chat/store/changes'));

    assert.equal(full.length, 2);

    for (const [method, , bodyOrOptions, postOptions] of full) {
      const options = method === 'POST' ? postOptions : bodyOrOptions;

      assert.equal(options?.idleTimeoutMs, 30000);
      assert.equal(options?.retry, false);
      assert.ok(options?.signal instanceof AbortSignal);
    }

    for (const [method, url, options] of calls) {
      if (method === 'GET' && url !== '/api/chat/store/list') {
        assert.equal(options?.idleTimeoutMs, undefined);
      }
    }
  });

  await t.test('настоящий apiClient загружает дольше 30 секунд', async (sub) => {
    memoryStorage(sub);

    const harness = loadApi();
    const ordinaryGet = harness.api.get;

    harness.api.get = (url, options) => url === '/api/chat/store/list'
      ? realApi.get(url, options) : ordinaryGet(url, options);

    const chat = await chatStoreFixture({}, { api: harness.api, unloaded: true });
    const clock = loadClock(sub);
    const requests = streamFetch(sub);
    const loading = chat._load();
    const envelope = protocolList({ sessions: [SERVER_CHAT], archived: [] });
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));

    sub.after(() => chat.$dispose());
    requests[0].push(bytes.slice(0, 20));
    await clock.tick(20000);
    requests[0].push(bytes.slice(20, 40));
    await clock.tick(20000);
    requests[0].push(bytes.slice(40));
    await clock.tick(20000);
    requests[0].end();
    await drain();
    await clock.tick(31000);
    await loading;
    assert.deepEqual(chat.sessions.map((item) => item.id), [SERVER_CHAT.id]);
    assert.equal(chat.loaded, true);
    assert.equal(requests.length, 1);
  });
});

test('LOAD-06', async (t) => {
  for (const error of ['offline', 'disconnected', 'no_machine', 'connecting', 'internal']) {
    await t.test(error, async (sub) => {
      memoryStorage(sub);

      const { api } = loadApi(async () => {
        throw Object.assign(new Error('HTTP 503'), {
          name: 'ApiError',
          status: 503,
          data: { error },
        });
      });
      const chat = await chatStoreFixture({}, { api, unloaded: true });

      sub.after(() => chat.$dispose());
      await chat._load();
      assert.equal(chat.loaded, false);
      assert.equal(chat.loadError, error === 'internal' ? 'server' : 'network');
    });
  }
});
