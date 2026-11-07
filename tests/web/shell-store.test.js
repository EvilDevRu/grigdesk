import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { useShellStore } from '../../web/src/stores/shell.ts';
import { readShellState } from '../../web/src/shared/shellClient.ts';

const state = {
  rev: 3,
  status: 'offline',
  detail: null,
  profile: null,
  profiles: [],
  localAvailable: true,
  appApi: { major: 0, minor: 1 },
  serverApi: null,
  capabilities: [],
};

test('оболочка: 404 и HTML не запускают цикл, JSON запускает long-poll с rev', async (t) => {
  const saved = globalThis.fetch;

  t.after(() => globalThis.fetch = saved);

  for (const response of [new Response('', { status: 404 }), new Response('', { status: 401 }),
    new Response('', { status: 403 }), new Response('<!doctype html>')]) {
    let calls = 0;

    globalThis.fetch = async () => {
      calls += 1;

      return response;
    };
    setActivePinia(createPinia());

    const store = useShellStore();

    await store.start();
    assert.equal(store.present, false);
    assert.equal(calls, 1);
    store.stop();
  }

  const calls = [];

  globalThis.fetch = async (url) => {
    calls.push(String(url));

    return calls.length === 1 ? Response.json(state) : new Promise(() => {});
  };
  setActivePinia(createPinia());

  const store = useShellStore();

  t.after(() => store.stop());
  await store.start();
  assert.equal(store.present, true);
  assert.equal(store.status, 'offline');
  assert.deepEqual(calls, ['/__shell/state', '/__shell/state?rev=3']);
});

test('оболочка: ошибка long-poll выдерживает секунду и действия используют точные пути', async (t) => {
  const saved = globalThis.fetch;
  const calls = [];

  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => globalThis.fetch = saved);
  setActivePinia(createPinia());

  const store = useShellStore();

  t.after(() => store.stop());

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });

    if (calls.length === 1) {
      return Response.json(state);
    }

    throw new TypeError('test network failure');
  };

  await store.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  t.mock.timers.tick(999);
  await Promise.resolve();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 3);
  store.stop();
  calls.length = 0;

  globalThis.fetch = async (url, options) => {
    calls.push({
      url,
      method: options.method,
      body: options.body ? JSON.parse(options.body) : undefined,
    });

    return Response.json(url === '/__shell/unlock' ? {
      ...state,
      rev: 4,
      status: 'connecting',
    } : { ok: true });
  };

  await store.addMachine('secret-test-pairing');
  await store.addLocal();
  await store.editProfile('a/b', { address: 'machine:443' });
  await store.removeProfile('id');
  await store.selectProfile('id');
  await store.connect();
  await store.disconnect();
  await store.unlock();
  assert.equal(store.status, 'connecting');
  store.apply({ ...state, status: 'locked' });
  assert.equal(store.status, 'connecting', 'Старый long-poll не возвращает экран блокировки');
  await store.scan();

  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ['POST', '/__shell/profiles'], ['POST', '/__shell/profiles'],
    ['PATCH', '/__shell/profiles/' + encodeURIComponent('a/b')], ['DELETE', '/__shell/profiles/' + 'id'],
    ['POST', '/__shell/select'], ['POST', '/__shell/connect'], ['POST', '/__shell/disconnect'],
    ['POST', '/__shell/unlock'], ['POST', '/__shell/scan'],
  ]);
  assert.deepEqual(calls[0].body, { pairing: 'secret-test-pairing' });
});

test('W5: окно настроек проверяет оболочку один раз без long-poll', async (t) => {
  const saved = globalThis.fetch;
  let calls = 0;

  t.after(() => globalThis.fetch = saved);
  globalThis.fetch = async () => {
    calls += 1;

    return calls === 1 ? Response.json(state) : new Promise(() => {});
  };
  setActivePinia(createPinia());

  const store = useShellStore();

  t.after(() => store.stop());
  await store.start({ poll: false });
  assert.equal(store.present, true);
  assert.equal(store.initialized, true);
  assert.equal(calls, 1);
});

test('W11: первоначальный HTTP401/403 означает отсутствие оболочки и не повторяется', async (t) => {
  const saved = globalThis.fetch;

  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => globalThis.fetch = saved);

  for (const status of [401, 403]) {
    let calls = 0;

    globalThis.fetch = async () => {
      calls += 1;

      return new Response('', { status });
    };
    setActivePinia(createPinia());

    const store = useShellStore();

    await store.start();
    t.mock.timers.tick(1000);
    await new Promise((resolve) => setImmediate(resolve));
    store.stop();
    assert.equal(calls, 1);
  }
});

test('обнаруженная оболочка переживает HTTP-отказ и получает следующий снимок', async (t) => {
  const saved = globalThis.fetch;

  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => globalThis.fetch = saved);

  for (const response of [new Response('{}', { status: 400 }), new Response('', { status: 403 }),
    new Response('', { status: 503 }), new Response('<!doctype html>'), Response.json({ ok: true })]) {
    let calls = 0;
    const store = useShellStore(createPinia());

    t.after(() => store.stop());
    globalThis.fetch = async () => {
      calls += 1;

      if (calls === 1) {
        return Response.json({ ...state, status: 'online' });
      }
      if (calls === 2) {
        return response;
      }
      if (calls === 3) {
        return Response.json({
          ...state,
          rev: 4,
          status: 'locked',
        });
      }

      return new Promise(() => {});
    };

    await store.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.present, true);
    assert.equal(store.status, 'online');
    assert.equal(store.unavailable, true);
    t.mock.timers.tick(999);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    t.mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 4);
    assert.equal(store.present, true);
    assert.equal(store.status, 'locked');
    assert.equal(store.unavailable, false);
    store.stop();
  }
});

test('503 при старте повторяется с ростом паузы; ручной повтор будит единственную цепочку', async (t) => {
  const saved = globalThis.fetch;
  const store = useShellStore(createPinia());
  let calls = 0;

  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    store.stop();
    globalThis.fetch = saved;
  });
  globalThis.fetch = async () => {
    calls += 1;

    return new Response('', { status: 503 });
  };

  await store.start();

  for (const delay of [1000, 1000, 1000, 2000, 4000, 8000, 16000, 30000]) {
    const before = calls;

    t.mock.timers.tick(delay - 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, before);
    t.mock.timers.tick(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, before + 1);
  }

  const before = calls;

  store.retryNow();
  store.retryNow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, before + 1);
  store.stop();
  t.mock.timers.tick(60000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, before + 1);
});

test('неудачный refresh не стирает ранее обнаруженную оболочку', async (t) => {
  const saved = globalThis.fetch;
  const store = useShellStore(createPinia());

  t.after(() => globalThis.fetch = saved);
  store.apply(state);
  globalThis.fetch = async () => new Response('', { status: 403 });
  await store.refresh();
  assert.equal(store.present, true);
  assert.equal(store.snapshot.rev, state.rev);
});

test('разблокировка старого APK перечитывает снимок после ответа ok', async (t) => {
  const saved = globalThis.fetch;
  const store = useShellStore(createPinia());
  const profile = {
    id: 'fixture',
    name: 'Фикстура',
    kind: 'remote',
    address: 'https://machine.example',
    status: 'locked',
  };
  const locked = {
    ...state,
    status: 'locked',
    profile,
    profiles: [profile],
  };
  const calls = [];

  t.after(() => globalThis.fetch = saved);
  store.apply(locked);
  globalThis.fetch = async (url) => {
    calls.push(url);

    return Response.json(url === '/__shell/unlock' ? { ok: true } : {
      ...locked,
      rev: 4,
      status: 'online',
    });
  };
  await store.unlock();
  assert.equal(store.status, 'online');
  assert.equal(store.profile.id, profile.id);
  assert.equal(store.snapshot.rev, 4);
  assert.deepEqual(calls, ['/__shell/unlock', '/__shell/state']);
});

test('подтверждение действия не может заменить снимок обнаруженной оболочки', () => {
  const store = useShellStore(createPinia());

  store.apply(state);
  assert.throws(() => store.apply({ ok: true }), /состояние оболочки/);
  assert.equal(store.snapshot.rev, state.rev);
  assert.equal(store.status, state.status);
  assert.equal(store.present, true);
});

test('зависший опрос оболочки отменяется и получает актуальную блокировку', async (t) => {
  for (const phase of ['headers', 'body']) {
    await t.test(phase, async (t) => {
      const saved = globalThis.fetch;
      const store = useShellStore(createPinia());
      let calls = 0;
      let stalledSignal;

      t.mock.timers.enable({ apis: ['setTimeout'] });
      t.after(() => {
        store.stop();
        globalThis.fetch = saved;
      });
      globalThis.fetch = async (_url, options) => {
        calls += 1;

        if (calls === 1) {
          return Response.json({ ...state, status: 'online' });
        }
        if (calls === 2) {
          stalledSignal = options.signal;

          const stalled = new Promise((_resolve, reject) => {
            stalledSignal.addEventListener('abort', () => reject(stalledSignal.reason), { once: true });
          });

          return phase === 'headers' ? stalled : {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: () => stalled,
          };
        }
        if (calls === 3) {
          return Response.json({
            ...state,
            rev: 4,
            status: 'locked',
          });
        }

        return new Promise(() => {});
      };

      await store.start();
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(34_999);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(stalledSignal.aborted, false);
      assert.equal(calls, 2);
      t.mock.timers.tick(1);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(stalledSignal.aborted, true, 'Зависшее чтение должно иметь конечный срок');
      assert.equal(store.present, true);
      assert.equal(store.status, 'online');
      assert.equal(store.unavailable, true);
      t.mock.timers.tick(1000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, 4, 'После таймаута продолжается одна цепочка long-poll');
      assert.equal(store.status, 'locked');
      assert.equal(store.unavailable, false);
    });
  }
});

test('штатный long-poll успевает ответить, завершённое чтение освобождает таймер', async (t) => {
  const saved = globalThis.fetch;
  let signal;

  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => globalThis.fetch = saved);
  globalThis.fetch = (_url, options) => {
    signal = options.signal;

    return new Promise((resolve) => setTimeout(() => resolve(Response.json(state)), 25_000));
  };

  const reading = readShellState(state.rev);

  t.mock.timers.tick(25_000);
  assert.deepEqual(await reading, state);
  t.mock.timers.tick(10_000);
  assert.equal(signal.aborted, false, 'Таймер завершённого чтения больше не срабатывает');
});

test('закрытие документа отменяет зависший опрос до срока и не запускает повтор', async (t) => {
  const saved = globalThis.fetch;
  const store = useShellStore(createPinia());
  let calls = 0;
  let signal;

  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    store.stop();
    globalThis.fetch = saved;
  });
  globalThis.fetch = async (_url, options) => {
    calls += 1;

    if (calls === 1) {
      return Response.json(state);
    }

    signal = options.signal;

    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };

  await store.start();
  store.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  t.mock.timers.tick(60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(store.unavailable, false);
});
