import assert from 'node:assert/strict';
import test from 'node:test';

import { protocolReconcile } from './helpers/chat-protocol.js';

import { chatStoreFixture } from './helpers/chat-store.js';
import { drain, loadApi, loadClock, memoryStorage, SERVER_CHAT, SNAPSHOT_KEY } from './helpers/chat-load.js';

const fullReads = (calls) => calls.filter(([method, url]) => (
  method === 'GET' && url === '/api/chat/store/list'
));

/**
 * События браузера проходят через настоящий lifecycle стора, без нового SSE.
 * Подмена восстанавливается после dispose, чтобы поздние listeners были обнаружимы.
 */
function lifecycle(t) {
  const browser = new EventTarget();
  const document = new EventTarget();

  document.visibilityState = 'visible';
  Object.defineProperty(document, 'hidden', { get: () => document.visibilityState === 'hidden' });

  for (const [key, value] of Object.entries({ window: browser, document })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);

    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) {
        Object.defineProperty(globalThis, key, previous);
      } else {
        delete globalThis[key];
      }
    });
  }

  return { browser, document };
}

test('LOAD-RETRY-01', async (t) => {
  memoryStorage(t);

  let attempts = 0;
  const { api, calls } = loadApi(async () => {
    attempts += 1;

    if (attempts < 7) {
      throw new TypeError('Нет связи');
    }

    return { sessions: [SERVER_CHAT], archived: [] };
  });
  const chat = await chatStoreFixture({}, { api, unloaded: true });
  const clock = loadClock(t);

  t.after(() => chat.$dispose());
  await chat.ensure();

  for (const [index, delay] of [1000, 2000, 4000, 8000, 16000, 30000].entries()) {
    await clock.tick(delay - 1);
    assert.equal(fullReads(calls).length, index + 1, 'пауза не сокращена');
    await clock.tick(1);
    assert.equal(fullReads(calls).length, index + 2, 'следующая попытка после растущей паузы');
  }

  assert.equal(chat.loaded, true);
  assert.equal(chat.loadError, null);
  assert.deepEqual(chat.sessions.map((item) => item.id), [SERVER_CHAT.id]);
  await clock.tick(120000);
  assert.equal(fullReads(calls).length, 7, 'успех останавливает автоповтор');
});

test('LOAD-RETRY-02', async (t) => {
  for (const trigger of ['hello', 'online', 'visible', 'manual']) {
    await t.test(trigger, async (sub) => {
      memoryStorage(sub);

      const { browser, document } = lifecycle(sub);
      const gate = Promise.withResolvers();
      let attempts = 0;
      const { api, calls } = loadApi(async () => {
        attempts += 1;

        if (attempts === 1) {
          throw new TypeError('Нет связи');
        }

        return gate.promise;
      });
      const chat = await chatStoreFixture({}, { api, unloaded: true });
      const clock = loadClock(sub);

      sub.after(async () => {
        chat.$dispose();
        gate.resolve({ sessions: [SERVER_CHAT], archived: [] });
        await drain();
      });
      await chat.ensure();
      document.visibilityState = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      await drain();
      assert.equal(fullReads(calls).length, 1, 'hidden сам не начинает попытку');
      document.visibilityState = 'visible';

      if (trigger === 'hello') {
        globalThis.__chatSse('hello', {});
      } else if (trigger === 'online') {
        browser.dispatchEvent(new Event('online'));
      } else if (trigger === 'visible') {
        document.dispatchEvent(new Event('visibilitychange'));
      } else {
        assert.equal(typeof chat.retryLoad, 'function', 'ручной повтор доступен в API стора');
        void chat.retryLoad();
      }

      await drain();
      assert.equal(fullReads(calls).length, 2, 'триггер опережает таймер');
      browser.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      globalThis.__chatSse('hello', {});
      void chat.retryLoad();
      await clock.tick(1000);
      assert.equal(fullReads(calls).length, 2, 'triggers и старый таймер разделяют один job');
      gate.resolve({ sessions: [SERVER_CHAT], archived: [] });
      await drain();
      assert.equal(chat.loaded, true);
      assert.equal(chat.loadError, null);
      await clock.tick(60000);
      assert.equal(fullReads(calls).length, 2);
    });
  }

  await t.test('access не повторяется таймером, новый ensure восстанавливает', async (sub) => {
    memoryStorage(sub);

    let access = false;
    const { api, calls } = loadApi(async () => {
      if (!access) {
        throw Object.assign(new Error('Нет доступа'), { status: 401 });
      }

      return { sessions: [SERVER_CHAT], archived: [] };
    });
    const chat = await chatStoreFixture({}, { api, unloaded: true });
    const clock = loadClock(sub);

    sub.after(() => chat.$dispose());
    await chat.ensure();
    await clock.tick(120000);
    assert.equal(fullReads(calls).length, 1);
    access = true;
    await chat.ensure();
    assert.equal(fullReads(calls).length, 2);
    assert.equal(chat.loaded, true);
  });
});

test('LOAD-RETRY-03', async (t) => {
  memoryStorage(t);

  const { browser, document } = lifecycle(t);
  const gate = Promise.withResolvers();
  const { api, calls } = loadApi(() => gate.promise);
  const chat = await chatStoreFixture({}, { api, unloaded: true });
  const clock = loadClock(t);
  const ensuring = chat.ensure();

  t.after(async () => {
    gate.resolve({ sessions: [SERVER_CHAT], archived: [] });
    await ensuring;
    chat.$dispose();
  });
  await drain();

  const signal = fullReads(calls)[0][2]?.signal;

  chat.$dispose();
  gate.resolve({ sessions: [SERVER_CHAT], archived: [] });
  await ensuring;
  browser.dispatchEvent(new Event('online'));
  document.dispatchEvent(new Event('visibilitychange'));
  globalThis.__chatSse?.('hello', {});
  await clock.tick(120000);
  assert.equal(chat.loaded, false, 'поздний ответ не применяется после dispose');
  assert.deepEqual(chat.sessions, []);
  assert.equal(signal?.aborted, true, 'dispose отменяет запрос');
  assert.equal(fullReads(calls).length, 1);
});

test('LOAD-RETRY-04', async (t) => {
  const storage = memoryStorage(t);

  let online = false;
  const { api, calls } = loadApi(async () => {
    if (!online) {
      throw new TypeError('Нет связи');
    }

    return {
      sessions: [{
        ...SERVER_CHAT,
        messages: [{
          role: 'user',
          text: 'Вопрос',
          turnId: 'turn-check',
          delivery: 'sending',
        }],
      }],
      archived: [],
      turnProtocol: 1,
    };
  });
  const originalGet = api.get;
  const originalPost = api.post;

  api.post = async (url, body, options) => {
    if (url === '/api/chat/store/reconcile') {
      calls.push(['POST', url, body, options]);

      return protocolReconcile({ pending: [{
        id: 'pending-check',
        chatKey: SERVER_CHAT.id,
        role: 'assistant',
        reply: 'Доставлен',
        at: 500,
      }] }, body.loadedIds);
    }

    return originalPost(url, body, options);
  };

  api.get = async (url, options) => {
    if (url.startsWith('/api/chat/turns?')) {
      calls.push(['GET', url, options]);

      return { turns: { 'turn-check': { state: 'done' } } };
    }

    return originalGet(url, options);
  };

  const chat = await chatStoreFixture({}, { api, unloaded: true });

  t.after(() => chat.$dispose());
  await chat.ensure();
  assert.deepEqual(calls.filter(([method]) => method !== 'GET'), [], 'нет ACK до успешного GET');
  assert.equal(calls.some(([, url]) => url === '/api/chat/store/reconcile'), false);
  // Прежний барьер работал с полной лентой. Страховка открывает ту же ленту до pending,
  // включая адресную сверку доставки и подготовительный PUT страховки.
  storage.values.set(SNAPSHOT_KEY, JSON.stringify({
    sessions: [{
      ...SERVER_CHAT,
      updatedAt: 300,
      messages: [{
        role: 'user',
        text: 'Вопрос',
        turnId: 'turn-check',
        delivery: 'sending',
      }],
    }],
    archived: [],
  }));
  online = true;
  await chat.ensure();
  await drain();

  const sequence = calls.filter(([, url]) => url === '/api/chat/store/reconcile'
    || url === '/api/chat/store/chat' || url === '/api/chat/pending/pending-check'
    || url === '/api/chat/waiting?include=ssh,db'
    || url === '/api/chat/active' || url.startsWith('/api/chat/turns?'));

  assert.deepEqual(sequence.map(([method, url]) => [method, url]), [
    ['GET', '/api/chat/turns?ids=turn-check'],
    ['PUT', '/api/chat/store/chat'],
    ['POST', '/api/chat/store/reconcile'],
    ['PUT', '/api/chat/store/chat'],
    ['DELETE', '/api/chat/pending/pending-check'],
    ['GET', '/api/chat/waiting?include=ssh,db'],
    ['GET', '/api/chat/active'],
  ]);
  assert.equal(chat.sessions[0].messages.at(-1).text, 'Доставлен');
  assert.equal(chat.sessions[0].messages[0].delivery, undefined);
});

test('страховки не задерживают ensure и восстанавливаются максимум по две одновременно', async (t) => {
  const sessions = Array.from({ length: 5 }, (_, index) => ({ ...SERVER_CHAT, id: `snapshot-${index}` }));
  const snapshot = JSON.stringify({
    sessions: sessions.map((chat) => ({
      ...chat,
      updatedAt: 300,
      draft: 'Спасённый черновик',
    })),
    archived: [],
  });

  memoryStorage(t, { [SNAPSHOT_KEY]: snapshot });

  const { api } = loadApi(async () => ({ sessions, archived: [] }));
  const gates = [];
  let active = 0;
  let maximum = 0;

  api.put = async (url) => {
    if (url !== '/api/chat/store/chat') {
      return { ok: true };
    }

    const gate = Promise.withResolvers();

    gates.push(gate);
    active += 1;
    maximum = Math.max(maximum, active);
    await gate.promise;
    active -= 1;

    return { ok: true };
  };

  const chat = await chatStoreFixture({}, { api, unloaded: true });

  loadClock(t);
  t.after(() => {
    chat.$dispose();
    gates.forEach((gate) => gate.resolve());
  });
  await chat.ensure();
  await drain();
  assert.equal(chat.loaded, true);
  assert.equal(chat.loading, false);
  assert.equal(chat.sessions.length, 5);
  assert.equal(gates.length, 2, 'ensure завершён при двух ещё не подтверждённых PUT');

  for (let index = 0; index < 5; index += 1) {
    gates[index].resolve();
    await drain();
  }

  assert.equal(gates.length, 5);
  assert.equal(maximum, 2);
  assert.deepEqual(chat.snapshotRecovery, {});
});

test('отказ PUT страховки виден в state, повторяется с паузой и выключается при dispose', async (t) => {
  const snapshot = JSON.stringify({
    sessions: [{
      ...SERVER_CHAT,
      updatedAt: 300,
      draft: 'Единственная копия',
    }],
    archived: [],
  });
  const storage = memoryStorage(t, { [SNAPSHOT_KEY]: snapshot });
  const { api } = loadApi();
  let puts = 0;
  const drafts = [];

  api.put = async (_url, body) => {
    puts += 1;
    drafts.push(body.chat.draft);

    if (puts <= 2) {
      throw new TypeError('PUT страховки недоступен');
    }

    return { ok: true };
  };

  const chat = await chatStoreFixture({}, { api, unloaded: true });
  const clock = loadClock(t);

  t.after(() => chat.$dispose());
  await chat.ensure();
  await drain();
  assert.equal(chat.snapshotRecovery[SERVER_CHAT.id].state, 'error');
  assert.match(chat.snapshotRecovery[SERVER_CHAT.id].error, /PUT страховки недоступен/);
  assert.equal(storage.values.get(SNAPSHOT_KEY), snapshot);
  chat.session(SERVER_CHAT.id).draft = 'Правка человека после отказа';
  await clock.tick(999);
  assert.equal(puts, 1);
  await clock.tick(1);
  assert.equal(puts, 2);
  await clock.tick(1999);
  assert.equal(puts, 2);
  await clock.tick(1);
  assert.equal(puts, 3);
  assert.equal(drafts.at(-1), 'Правка человека после отказа');
  assert.deepEqual(chat.snapshotRecovery, {});

  const stopped = await chatStoreFixture({}, { api, unloaded: true });

  puts = 0;
  await stopped.ensure();
  await drain();
  assert.equal(puts, 1);
  stopped.$dispose();
  await clock.tick(60000);
  assert.equal(puts, 1);
});

test('debounce старого стора после dispose не перезаписывает страховку нового окна', async (t) => {
  const storage = memoryStorage(t);
  const clock = loadClock(t);
  const { api, calls } = loadApi();
  const chat = await chatStoreFixture({ sessions: [{ ...SERVER_CHAT }] }, { api });

  t.after(() => chat.$dispose());
  chat.session(SERVER_CHAT.id).draft = 'Поздняя запись закрытого стора';
  chat._persist();
  chat.$dispose();

  const fresh = JSON.stringify({ sessions: [{ ...SERVER_CHAT, draft: 'Свежая страховка' }], archived: [] });

  storage.values.set(SNAPSHOT_KEY, fresh);
  await clock.tick(300);
  assert.equal(storage.values.get(SNAPSHOT_KEY), fresh);
  assert.equal(calls.some(([method]) => method === 'PUT'), false);
});
