import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import providersModule from '../../server/src/modules/providers/index.ts';
import settingsModule from '../../server/src/modules/settings/index.ts';
import authPlugin from '../../server/src/plugins/auth.ts';
import { PrefsStore } from '../../server/src/lib/prefsStore.ts';

const Fastify = createRequire(new URL('../../server/package.json', import.meta.url))('fastify');

/**
 * Явные сигналы задают порядок гонки вместо ожидания произвольного числа миллисекунд.
 * Освобождение регистрируется в cleanup, чтобы не оставить удержанный HTTP-запрос.
 */
function gate(t) {
  let enter;
  let release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise((resolve) => {
    release = resolve;
  });

  t.after(() => release());

  return {
    entered,
    waiting,
    enter,
    release,
  };
}

/**
 * Производственные HTTP и prefs связываются с двумя независимыми квотами.
 * Подменён только внешний источник; проверяется полный ответ и побочные эффекты.
 */
async function fixture(t, { enabled = false, auth = false, usageTickMs = 300000 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-policy-'));
  const prefs = new PrefsStore({ prefsPath: path.join(root, 'prefs.json') });
  const calls = { alpha: 0, beta: 0 };
  const values = { alpha: 10, beta: 20 };
  const failures = {};
  const holds = {};
  const events = [];
  const app = Fastify({ logger: false });

  t.after(async () => {
    for (const hold of Object.values(holds)) {
      hold.release();
    }

    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  if (enabled) {
    prefs.write({ providerUsageAutoRefresh: true });
  }

  app.decorate('sse', {
    broadcast: (event, data) => events.push({ event, data }),
    clientCount: () => 0,
  });

  if (auth) {
    await app.register(authPlugin, {
      authStore: { isConfigured: () => true, isValidSession: () => false },
    });
  }

  await app.register(settingsModule, {
    prefs,
    factoryDebug: {},
    modelJobs: null,
  });

  const adapters = new Map(['alpha', 'beta'].map((id) => [id, {
    id,
    name: id,
    kind: 'api',
    probe: async () => ({ ok: true, version: '1' }),
    auth: async () => ({ available: true }),
    seedModels: () => [],
    usage: async () => {
      calls[id] += 1;

      const value = values[id];
      const failure = failures[id];
      const hold = holds[id];

      if (hold) {
        hold.enter();
        await hold.waiting;
      }
      if (failure === 'throw') {
        throw new Error('fixture quota unavailable');
      }
      if (failure === '429') {
        return { state: 'rate_limited', retryAt: Date.now() + 3600000 };
      }

      return { state: 'ok', bars: [{
        key: 'week',
        pct: value,
        resetsAt: null,
      }] };
    },
  }]));

  await app.register(providersModule, {
    config: {
      modelsPath: path.join(root, 'models.json'),
      providerUsageSeenPath: path.join(root, 'seen.json'),
      envPath: path.join(root, 'fixture.env'),
    },
    prefs,
    env: {},
    usageTickMs,
    getProviderAdapters: async () => adapters,
    getModelsRegistry: async () => ({}),
  });
  await app.ready();

  return {
    app,
    prefs,
    calls,
    values,
    failures,
    holds,
    events,
    adapters,
    get: async () => (await app.inject('/api/providers/usage')).json(),
    refresh: (providerId) => app.inject({
      method: 'POST',
      url: '/api/providers/usage/refresh',
      payload: { providerId },
    }),
    set: (value) => app.inject({
      method: 'POST',
      url: '/api/settings/prefs',
      payload: { providerUsageAutoRefresh: value },
    }),
  };
}

test('S1: default false не измеряет при GET и фоновом hook', async (t) => {
  const f = await fixture(t);

  for (let index = 0; index < 3; index += 1) {
    const snapshot = await f.get();

    assert.deepEqual(snapshot.usage, {});
    await f.app.refreshProvidersUsage();
  }

  assert.deepEqual(f.calls, { alpha: 0, beta: 0 });
});

test('S2: ручной refresh адресный, сосед и его дата неизменны', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 2000000000000 });

  const f = await fixture(t);

  assert.equal((await f.refresh('beta')).statusCode, 200);

  const before = (await f.get()).usage.beta;

  t.mock.timers.setTime(Date.now() + 20000);
  f.values.alpha = 35;
  f.values.beta = 90;

  const updated = await f.refresh('alpha');
  const snapshot = updated.json();

  assert.equal(updated.statusCode, 200);
  assert.equal(snapshot.usage.alpha.bars[0].pct, 35);
  assert.deepEqual(snapshot.usage.beta, before);
  assert.deepEqual(f.calls, { alpha: 1, beta: 1 });

  for (const payload of [{}, { providerId: 1 }, { providerId: '' }]) {
    const bad = await f.app.inject({
      method: 'POST',
      url: '/api/providers/usage/refresh',
      payload,
    });

    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().message, /исполнител|обнов/u);
  }

  assert.equal((await f.refresh('unknown')).statusCode, 404);
  assert.deepEqual(f.calls, { alpha: 1, beta: 1 });
});

test('S2b: cached GET не измеряет даже при включённой автоматике', async (t) => {
  const f = await fixture(t, { enabled: true });
  const response = await f.app.inject('/api/providers/usage?cached=1');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().usage, {});
  assert.equal(response.json().autoRefresh, true);
  assert.deepEqual(f.calls, { alpha: 0, beta: 0 });
});

test('S3: одинаковые запросы делятся, сосед независим, TTL и 429 персональны',
  { timeout: 10000 }, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 2000000000000 });

  const f = await fixture(t);
  const hold = gate(t);

  f.holds.alpha = hold;

  const first = f.refresh('alpha');

  await hold.entered;

  const second = f.refresh('alpha');

  assert.equal((await f.refresh('beta')).statusCode, 200);
  hold.release();
  await Promise.all([first, second]);
  delete f.holds.alpha;
  assert.deepEqual(f.calls, { alpha: 1, beta: 1 });
  await f.refresh('alpha');
  assert.equal(f.calls.alpha, 1);
  t.mock.timers.setTime(Date.now() + 15000);
  f.failures.alpha = '429';
  await f.refresh('alpha');

  const paused = (await f.get()).usage.alpha;

  assert.equal(paused.state, 'rate_limited');
  assert.equal(paused.bars[0].pct, 10);
  t.mock.timers.setTime(Date.now() + 20000);
  await f.refresh('beta');
  await f.refresh('alpha');
  assert.equal(f.calls.alpha, 2);
  assert.equal(f.calls.beta, 2);
  assert.deepEqual((await f.get()).usage.alpha, paused);
});

test('S6: отказ ручного источника сохраняет прежнее измерение', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 2000000000000 });

  const f = await fixture(t);

  await f.refresh('alpha');

  const before = (await f.get()).usage.alpha;

  t.mock.timers.setTime(Date.now() + 20000);
  f.failures.alpha = 'throw';

  const failed = (await f.refresh('alpha')).json().usage.alpha;

  assert.equal(failed.state, 'unavailable');
  assert.equal(failed.stale, true);
  assert.deepEqual(failed.bars, before.bars);
  assert.equal(failed.dataCheckedAt, before.dataCheckedAt);
  assert.ok(failed.message);
});

test('S7: общий auth guard закрывает ручной refresh и prefs', async (t) => {
  const f = await fixture(t, { auth: true });

  assert.equal((await f.refresh('alpha')).statusCode, 401);
  assert.equal((await f.set(true)).statusCode, 401);
  assert.equal(f.prefs.read().providerUsageAutoRefresh, false);
  assert.deepEqual(f.calls, { alpha: 0, beta: 0 });
});

test('S4: выключение отзывает поздний auto и сохраняет измерение', async (t) => {
  for (const failure of [null, 'throw', '429']) {
    await t.test(`late ${failure ?? 'success'}`, async (scenario) => {
      scenario.mock.timers.enable({ apis: ['Date'], now: 2000000000000 });

      const f = await fixture(scenario, { enabled: true });

      await f.get();

      const before = (await f.get()).usage.alpha;
      const hold = gate(scenario);

      scenario.mock.timers.setTime(Date.now() + 300000);
      f.values.alpha = 88;
      f.holds.alpha = hold;
      f.failures.alpha = failure;

      const pending = f.app.refreshProvidersUsage();

      await hold.entered;
      assert.equal((await f.set(false)).statusCode, 200);
      hold.release();
      await pending;
      delete f.holds.alpha;
      await new Promise((resolve) => setImmediate(resolve));

      const frozen = await f.get();

      assert.deepEqual(frozen.usage.alpha, before);
      assert.equal(frozen.autoRefresh, false);
      assert.equal(f.events.at(-1).data.autoRefresh, false);

      const calls = { ...f.calls };

      await f.app.refreshProvidersUsage();
      assert.deepEqual(f.calls, calls);
      delete f.failures.alpha;
      scenario.mock.timers.setTime(Date.now() + 20000);
      await f.refresh('alpha');
      assert.equal((await f.get()).usage.alpha.bars[0].pct, 88);
      assert.equal((await f.get()).usage.alpha.retryAt, undefined);
      assert.equal(f.calls.beta, calls.beta);
    });
  }
});

test('S4b: ручной запрос, присоединённый к auto, переживает выключение', async (t) => {
  const f = await fixture(t, { enabled: true });
  const hold = gate(t);

  f.holds.alpha = hold;

  const automatic = f.app.refreshProvidersUsage();

  await hold.entered;

  const manual = f.refresh('alpha');

  await new Promise((resolve) => setImmediate(resolve));
  await f.set(false);
  hold.release();
  await Promise.all([automatic, manual]);
  assert.equal(f.calls.alpha, 1);
  assert.equal((await f.get()).usage.alpha.bars[0].pct, 10);
});

test('S5: live заморожен при false, прежний sink возвращается после включения', async (t) => {
  const f = await fixture(t, { enabled: true });

  await f.get();

  const sink = f.app.providerUsageSink('alpha');

  assert.equal(sink({ bars: [{
        key: 'week',
        pct: 30,
        resetsAt: null,
      }] }), true);
  await f.set(false);

  const frozen = (await f.get()).usage.alpha;
  const calls = { ...f.calls };

  assert.equal(frozen.bars[0].pct, 30);
  assert.equal(sink({ bars: [{
        key: 'week',
        pct: 70,
        resetsAt: null,
      }] }), false);
  assert.deepEqual((await f.get()).usage.alpha, frozen);
  assert.deepEqual(f.calls, calls);
  await f.set(true);
  assert.equal(sink({ bars: [{
        key: 'week',
        pct: 40,
        resetsAt: null,
      }] }), true);
  assert.equal((await f.get()).usage.alpha.bars[0].pct, 40);
});

test('S4c: поздний status и 429 после выключения не записывают паузу', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 2000000000000 });

  const status = gate(t);

  t.mock.method(globalThis, 'fetch', async () => {
    status.enter();
    await status.waiting;

    return new Response(JSON.stringify({
      status: { indicator: 'major', description: 'Synthetic outage' },
      components: [],
      incidents: [],
    }));
  });

  const f = await fixture(t, { enabled: true });

  await f.get();

  const before = (await f.get()).usage.alpha;

  f.adapters.get('alpha').statusPage = 'https://status.example.test';
  f.failures.alpha = '429';
  t.mock.timers.setTime(Date.now() + 300000);

  const pending = f.app.refreshProvidersUsage();

  await status.entered;
  await f.set(false);
  status.release();
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual((await f.get()).usage.alpha, before);
  delete f.failures.alpha;
  f.values.alpha = 65;
  await f.refresh('alpha');
  assert.equal((await f.get()).usage.alpha.bars[0].pct, 65);
  assert.equal((await f.get()).usage.alpha.retryAt, undefined);
});

test('S8: настоящий timer соблюдает общий выключатель', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });

  const f = await fixture(t, { usageTickMs: 20 });

  f.app.sse.clientCount = () => 1;
  t.mock.timers.tick(60);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls, { alpha: 0, beta: 0 });
  await f.set(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(f.calls.alpha > 0);
  assert.ok(f.calls.beta > 0);

  const resumed = { ...f.calls };

  await f.app.refreshProvidersUsage();
  assert.deepEqual(f.calls, resumed);
  await f.set(false);

  const before = { ...f.calls };

  t.mock.timers.tick(60);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls, before);
});

test('S9: отказ manual после выключения сохраняет запечатанный live-снимок', async (t) => {
  for (const failure of ['throw', '429']) {
    await t.test(failure, async (scenario) => {
      scenario.mock.timers.enable({ apis: ['Date'], now: 2000000000000 });

      const f = await fixture(scenario, { enabled: true });

      await f.get();
      assert.equal(f.app.providerUsageSink('alpha')({
        bars: [{
        key: 'week',
        pct: 30,
        resetsAt: null,
      }],
      }), true);
      scenario.mock.timers.setTime(Date.now() + 20000);

      const hold = gate(scenario);

      f.holds.alpha = hold;
      f.failures.alpha = failure;

      const manual = f.refresh('alpha');

      await hold.entered;
      await f.set(false);

      const frozen = (await f.get()).usage;

      assert.equal(frozen.alpha.bars[0].pct, 30);
      hold.release();
      await manual;

      const result = (await f.get()).usage;

      assert.equal(f.calls.alpha, 2);
      assert.equal(result.alpha.bars[0].pct, 30);
      assert.equal(result.alpha.dataCheckedAt, frozen.alpha.dataCheckedAt);
      assert.equal(result.alpha.stale, true);
      assert.deepEqual(result.beta, frozen.beta);
    });
  }
});
