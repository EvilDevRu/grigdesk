import assert from 'node:assert/strict';
import test from 'node:test';

import { pluginCore, runtimeFixture } from './helpers/pluginRuntimeFixture.js';

const notification = {
  action: 'show',
  id: 'ready-1',
  dedupKey: 'library:intent:child:ready',
  topic: 'model:1',
  title: { ru: 'Модель готова', en: 'Model ready' },
  body: { ru: 'Описание', en: 'Description' },
  params: { model: 'модель 1', version: 'β' },
};

test('PN-SNAPSHOT: auth, enabled loaded panel, closed DTO и независимые ошибки hooks', async (t) => {
  let calls = 0;
  const f = await runtimeFixture(t, [
    {
      id: 'good',
      web: true,
      hooks: {
        notifications: async () => {
          calls += 1;

          return [notification];
        },
      },
    },
    {
      id: 'bad',
      web: true,
      hooks: { notifications: async () => [{ ...notification, url: 'https://evil' }] },
    },
    {
      id: 'off',
      web: true,
      hooks: { notifications: () => assert.fail('Выключенный hook') },
    },
    {
      id: 'server',
      hooks: { notifications: () => assert.fail('Нет панели') },
    },
  ], { prefs: { plugins: { off: false } } });

  assert.equal((await f.request('GET', '/api/plugins/notifications', undefined, {})).statusCode, 401);

  const response = await f.request('GET', '/api/plugins/notifications');

  assert.equal(response.statusCode, 200);

  const rows = response.json().plugins;

  assert.deepEqual(rows.map((row) => row.pluginId).sort(), ['bad', 'good']);
  assert.deepEqual(rows.find((row) => row.pluginId === 'good').items, [notification]);
  assert.equal(rows.find((row) => row.pluginId === 'good').error, null);
  assert.equal(typeof rows.find((row) => row.pluginId === 'bad').error, 'string');
  assert.equal(rows.find((row) => row.pluginId === 'good').generation,
    (await f.card('good')).runtimeGeneration);
  assert.equal(calls, 1);
  assert.equal(await f.imported('off'), false);
});

for (const enabled of [false, true]) {
  test(`PN-GENERATION: boot=${enabled}, тот же core после on/off/on выдаёт текущий UUID`, async (t) => {
    const f = await runtimeFixture(t, [{
      id: 'demo',
      web: true,
      hooks: { notifications: async () => [notification] },
    }], { prefs: { plugins: { demo: enabled } }, sse: true });
    const frames = [];

    t.mock.method(f.app.sse, 'broadcast', (name, data) => frames.push({ name, data }));

    if (!enabled) {
      assert.equal(await f.imported('demo'), false);
      assert.equal((await f.toggle('demo', true)).statusCode, 200);
    }

    const core = pluginCore(f);
    const first = (await f.card('demo')).runtimeGeneration;

    assert.equal(typeof first, 'string');
    assert.deepEqual((await f.request('GET', '/api/plugins/notifications')).json().plugins[0].items,
      [notification]);
    core.emit('notification', notification);
    assert.equal(frames.at(-1).data.generation, first);
    assert.equal((await f.toggle('demo', false)).statusCode, 200);

    const count = frames.length;

    core.emit('notification', notification);
    assert.equal(frames.length, count);
    assert.equal((await f.toggle('demo', true)).statusCode, 200);
    assert.equal(pluginCore(f), core);

    const next = (await f.card('demo')).runtimeGeneration;

    assert.notEqual(next, first);
    core.emit('notification', {
      ...notification,
      id: 'failed',
      tone: 'danger',
      sticky: true,
    });
    assert.equal(frames.at(-1).data.generation, next);
    assert.equal(frames.at(-1).data.pluginId, 'demo');
    assert.equal(frames.at(-1).data.event, 'notification');
  });
}

test('PN-LATE: удержанный snapshot до off/on не публикует старое поколение', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await runtimeFixture(t, [{
    id: 'demo',
    web: true,
    hooks: {
      notifications: async (signal) => {
        entered.resolve(signal);
        await release.promise;

        return [notification];
      },
    },
  }]);
  const pending = f.request('GET', '/api/plugins/notifications');

  await Promise.race([
    entered.promise,
    pending.then((response) => assert.equal(response.statusCode, 200)),
  ]);
  await f.toggle('demo', false);
  await f.toggle('demo', true);
  release.resolve();
  assert.deepEqual((await pending).json().plugins, []);
});

test('PN-REPLACEMENT: старый core и удержанный hook не публикуются после замены entry', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let blocked = true;
  const f = await runtimeFixture(t, [{
    id: 'demo',
    web: true,
    hooks: {
      notifications: async () => {
        if (blocked) {
          entered.resolve();
          await release.promise;
        }

        return [notification];
      },
    },
  }], { sse: true });
  const frames = [];

  t.mock.method(f.app.sse, 'broadcast', (name, data) => frames.push({ name, data }));

  const oldCore = pluginCore(f);
  const before = (await f.card('demo')).runtimeGeneration;
  const pending = f.request('GET', '/api/plugins/notifications');

  await entered.promise;

  const lease = await f.port.runtime.prepareReplace('demo', new AbortController().signal);

  oldCore.emit('notification', notification);
  assert.equal(frames.filter(({ name }) => name === 'plugin-event').length, 0);
  await lease.finish('installed');
  await f.port.runtime.refresh();
  blocked = false;
  release.resolve();
  assert.deepEqual((await pending).json().plugins, []);
  assert.notEqual(pluginCore(f), oldCore);
  assert.notEqual((await f.card('demo')).runtimeGeneration, before);
  oldCore.emit('notification', notification);
  assert.equal(frames.filter(({ name }) => name === 'plugin-event').length, 0);
  pluginCore(f).emit('notification', notification);
  assert.equal(frames.filter(({ name }) => name === 'plugin-event').length, 1);
});

test('PN-LIMITS: собственные сигналы, concurrency=2, timeout и поздний исход игнорируются', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const signals = [];
  const started = [];
  let active = 0;
  let peak = 0;
  const definitions = ['one', 'two', 'three'].map((id) => ({
    id,
    web: true,
    hooks: {
      notifications: async (signal) => {
        signals.push(signal);
        started.push(id);
        active += 1;
        peak = Math.max(peak, active);

        let admitted = true;
        const finish = () => {
          if (admitted) {
            admitted = false;
            active -= 1;
          }
        };

        signal.addEventListener('abort', finish, { once: true });

        if (started.length === 2) {
          entered.resolve();
        }

        await release.promise;
        finish();
        signal.removeEventListener('abort', finish);

        return [{ ...notification, id }];
      },
    },
  }));
  const f = await runtimeFixture(t, definitions);

  t.mock.timers.enable({ apis: ['setTimeout'] });

  const pending = f.request('GET', '/api/plugins/notifications');

  await entered.promise;
  assert.equal(started.length, 2);
  assert.notEqual(signals[0], signals[1]);
  t.mock.timers.tick(5000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, true);
  release.resolve();

  const rows = (await pending).json().plugins;

  assert.equal(rows.length, 3);

  for (const id of started.slice(0, 2)) {
    const row = rows.find(({ pluginId }) => pluginId === id);

    assert.equal(row.error, 'plugin_notifications_timeout');
    assert.deepEqual(row.items, []);
  }

  assert.equal(rows.find(({ pluginId }) => pluginId === started[2]).error, null);
  assert.equal(peak, 2);
  assert.equal(active, 0);
});

test('PN-BOUNDS: последние 500 show, лимит 1MiB и отсутствие raw exception', async (t) => {
  const many = Array.from({ length: 501 }, (_, index) => ({
    ...notification,
    id: `ready-${index}`,
    dedupKey: `key-${index}`,
  }));
  const tooLarge = Array.from({ length: 500 }, (_, index) => ({
    ...notification,
    id: `large-${index}`,
    body: { ru: 'я'.repeat(2000), en: 'a'.repeat(2000) },
  }));
  const f = await runtimeFixture(t, [
    {
      id: 'many',
      web: true,
      hooks: { notifications: async () => many },
    },
    {
      id: 'large',
      web: true,
      hooks: { notifications: async () => tooLarge },
    },
    {
      id: 'failed',
      web: true,
      hooks: {
        notifications: async () => {
          throw new Error('PRIVATE provider credentials');
        },
      },
    },
    {
      id: 'dismiss',
      web: true,
      hooks: { notifications: async () => [{ action: 'clear' }] },
    },
  ]);
  const response = await f.request('GET', '/api/plugins/notifications');
  const rows = response.json().plugins;
  const items = rows.find(({ pluginId }) => pluginId === 'many').items;

  assert.equal(items.length, 500);
  assert.equal(items[0].id, 'ready-1');
  assert.equal(items.at(-1).id, 'ready-500');
  assert.equal(rows.find(({ pluginId }) => pluginId === 'large').error, 'plugin_notifications_too_large');
  assert.equal(rows.find(({ pluginId }) => pluginId === 'failed').error, 'plugin_notifications_failed');
  assert.equal(rows.find(({ pluginId }) => pluginId === 'dismiss').error, 'plugin_notifications_invalid');
  assert.equal(response.body.includes('PRIVATE'), false);
});

test('PN-DECODER: строгие типы, own required fields и отсутствие побочного SSE', async (t) => {
  const f = await runtimeFixture(t, [{
    id: 'demo',
    web: true,
  }], { sse: true });
  const frames = [];

  t.mock.method(f.app.sse, 'broadcast', (name, data) => frames.push({ name, data }));

  const core = pluginCore(f);
  const inherited = Object.assign(Object.create(notification), { id: 'inherited' });
  const inheritedTitle = Object.assign(Object.create({ ru: 'RU', en: 'EN' }), {});
  const invalid = [
    { ...notification, tone: { toString: () => 'accent' } },
    { ...notification, title: inheritedTitle },
    { ...notification, sticky: 'true' },
    { ...notification, params: { constructor: 'forbidden' } },
    { ...notification, scope: 'other-plugin' },
    { ...notification, dedupKey: 'a'.repeat(513) },
    inherited,
    Object.create({ action: 'clear' }),
    Object.assign(Object.create({ id: 'inherited-id' }), { action: 'dismiss' }),
  ];

  for (const payload of invalid) {
    assert.throws(() => core.emit('notification', payload), TypeError);
  }

  assert.deepEqual(frames, []);
  core.emit('notification', notification);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data.data.action, 'show');
});
