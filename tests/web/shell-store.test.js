import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { useShellStore } from '../../web/src/stores/shell.ts';

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
    new Response('', { status: 503 }), new Response('<!doctype html>')]) {
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

test('W11: HTTP401/503 означает отсутствие оболочки и не повторяется через секунду', async (t) => {
  const saved = globalThis.fetch;

  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => globalThis.fetch = saved);

  for (const status of [401, 503]) {
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
