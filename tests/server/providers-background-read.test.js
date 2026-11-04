import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate, setTimeout as sleep } from 'node:timers/promises';

import providersModule from '../../server/src/modules/providers/index.ts';
import { createUsageReadCache } from '../../server/src/lib/providerUsage.ts';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = require('fastify');

/**
 * Проба удерживается тестом вместо настоящего пятисекундного внешнего вызова.
 * Синтетический адаптер и временные пути исключают доступ к пользовательскому состоянию.
 */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'providers-background-'));
  const app = Fastify();
  const events = [];
  const modelReads = [];
  let pending = null;
  let builds = 0;
  let version = '1.0.0';
  const adapter = {
    id: 'background-fixture',
    name: 'Fixture',
    bin: () => '/bin/true',
    latestVersion: async () => '',
    auth: async () => ({
      mode: 'none',
      label: 'ok',
      available: true,
    }),
    probe: async () => {
      builds += 1;

      if (pending) {
        await pending;
      }

      return { ok: true, version };
    },
  };

  app.decorate('sse', { broadcast: (name) => events.push(name) });
  await app.register(providersModule, {
    config: {
      modelsPath: path.join(root, 'models.json'),
      providerUsageSeenPath: path.join(root, 'usage.json'),
    },
    getProviderAdapters: async () => new Map([[adapter.id, adapter]]),
    getModelsRegistry: async (_config, options) => {
      modelReads.push(!!options?.refresh);

      return {};
    },
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  return {
    app,
    adapter,
    events,
    modelReads,
    builds: () => builds,
    hold() {
      let finish;

      pending = new Promise((resolve) => {
        finish = resolve;
      });

      return () => {
        version = '2.0.0';
        pending = null;
        finish();
      };
    },
  };
}

test('холодный /api/providers: p95 < 1,5 с, один сбор для вкладок и поздний SSE', async (t) => {
  const own = await fixture(t);
  const release = own.hold();

  t.after(release);

  const responses = await Promise.all(Array.from({ length: 20 }, async () => {
    const start = performance.now();
    const response = await own.app.inject('/api/providers');

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().providers, []);

    return performance.now() - start;
  }));
  const p95 = responses.sort((a, b) => a - b)[18];

  t.diagnostic(`недоступная проба: p95=${Math.round(p95)} мс, запросов=20`);
  assert.ok(p95 < 1500, `p95=${p95}`);
  assert.equal(own.builds(), 1);
  release();
  await setImmediate();
  await setImmediate();
  assert.deepEqual(own.events, ['providers-update']);
  assert.equal((await own.app.inject('/api/providers')).json().providers[0].version, '2.0.0');
});

test('wait ждёт холодный общий сбор без refresh каталога и сохраняет быстрый обычный GET', async (t) => {
  const own = await fixture(t);
  const release = own.hold();
  let settled = false;

  t.after(release);

  const strict = own.app.inject('/api/providers?wait=1').then((response) => {
    settled = true;

    return response;
  });
  const ordinary = await own.app.inject('/api/providers');

  assert.equal(ordinary.statusCode, 200);
  assert.deepEqual(ordinary.json().providers, []);
  assert.equal(settled, false, 'строгое чтение не принимает холодный fallback');
  assert.equal(own.builds(), 1);
  release();

  const ready = await strict;

  assert.equal(ready.statusCode, 200);
  assert.equal(ready.json().providers[0].version, '2.0.0');
  assert.deepEqual(own.modelReads, [false], 'ожидание не пересобирает каталог моделей');
  await own.app.inject('/api/providers?wait=1');
  assert.equal(own.builds(), 1, 'готовый снимок переиспользуется без сброса');
});

test('просроченный снимок отдаётся сразу; refresh ждёт общий сбор и не получает stale', async (t) => {
  const own = await fixture(t);
  const first = (await own.app.inject('/api/providers')).json();
  const now = Date.now();

  t.mock.method(Date, 'now', () => now + 61_000);

  const release = own.hold();

  t.after(release);

  const start = performance.now();
  const stale = (await own.app.inject('/api/providers')).json();

  assert.ok(performance.now() - start < 250);
  assert.deepEqual(stale, first);

  let settled = false;
  const explicit = own.app.inject('/api/providers?refresh=1').then((response) => {
    settled = true;

    return response;
  });

  await sleep(1300);
  assert.equal(settled, false);
  release();
  assert.equal((await explicit).json().providers[0].version, '2.0.0');
});

test('отказ фонового сбора сохраняет успешный снимок, следующий успех уведомляет читателей', async () => {
  let now = 0;
  let reject;
  let value = ['A'];
  let ready = 0;
  const cache = createUsageReadCache(() => value, { now: () => now });

  await cache.read();
  now = 61_000;
  value = new Promise((_resolve, fail) => {
    reject = fail;
  });

  assert.deepEqual(await cache.readStale(10, [], () => ready += 1), ['A']);
  reject(new Error('Сервис недоступен'));
  await setImmediate();
  assert.equal(ready, 0);
  value = ['B'];
  assert.deepEqual(await cache.readStale(10, [], () => ready += 1), ['A']);
  await setImmediate();
  assert.deepEqual(await cache.read(), ['B']);
  assert.equal(ready, 1);
});

test('проверка версий сохраняет карточки во время повторного сбора', async (t) => {
  const own = await fixture(t);
  const first = (await own.app.inject('/api/providers')).json();

  own.adapter.latestVersion = async () => '2.0.0';
  await own.app.inject({ method: 'POST', url: '/api/providers/check-updates' });

  const release = own.hold();

  t.after(release);

  const start = performance.now();
  const stale = (await own.app.inject('/api/providers')).json();

  assert.deepEqual(stale, first, 'Проверка версий убрала уже загруженные карточки');
  assert.ok(performance.now() - start < 250);
  assert.deepEqual(own.events, ['providers-update']);
  release();
  await setImmediate();
  await setImmediate();

  const current = (await own.app.inject('/api/providers')).json().providers[0];

  assert.equal(current.version, '2.0.0');
  assert.equal(current.latest, '2.0.0');
  assert.equal(current.updateAvailable, true);
  assert.deepEqual(own.events, ['providers-update', 'providers-update']);
});

test('инвалидация не возвращает старый fallback и не рассылает старый поздний сбор', async () => {
  const gates = [];
  let ready = 0;
  const cache = createUsageReadCache(() => new Promise((resolve) => gates.push(resolve)));

  assert.deepEqual(await cache.readStale(10, [], () => ready += 1), []);
  cache.clear();

  const current = cache.read();

  await setImmediate();
  gates[1](['current']);
  assert.deepEqual(await current, ['current']);
  gates[0](['old']);
  await setImmediate();
  assert.deepEqual(await cache.read(), ['current']);
  assert.equal(ready, 0);
});

test('expire сохраняет снимок и отсекает предыдущий незавершённый сбор', async () => {
  const gates = [];
  let ready = 0;
  const cache = createUsageReadCache(() => new Promise((resolve) => gates.push(resolve)));
  const initial = cache.read();

  await setImmediate();
  gates[0](['initial']);
  await initial;
  cache.expire();
  assert.deepEqual(await cache.readStale(10, [], () => ready += 1), ['initial']);
  cache.expire();
  assert.deepEqual(await cache.readStale(10, [], () => ready += 1), ['initial']);
  gates[1](['obsolete']);
  await setImmediate();
  assert.equal(ready, 0);

  const current = cache.read();

  gates[2](['current']);
  assert.deepEqual(await current, ['current']);
  await setImmediate();
  assert.equal(ready, 1);
});

test('быстрый отказ без снимка сохраняет исходную ошибку', async () => {
  const error = new Error('Сборка реестра отказала');
  const cache = createUsageReadCache(() => Promise.reject(error));

  await assert.rejects(cache.readStale(1200, [], () => {}), (actual) => actual === error);
});
