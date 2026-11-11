import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { createTripoAdapter } from '../../server/src/lib/executors/tripo.ts';
import providersModule from '../../server/src/modules/providers/index.ts';
import authPlugin from '../../server/src/plugins/auth.ts';

const KEY = 'fixture-secret-tripo-0123456789abcdef';
const Fastify = createRequire(new URL('../../server/package.json', import.meta.url))('fastify');

/**
 * Даёт сценарию явный контроль момента успеха или ошибки асинхронного чтения.
 * Порядок гонки задаётся сигналами, не предположениями о времени выполнения.
 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return {
    promise,
    resolve,
    reject
  };
}

/**
 * Изолирует HTTP/SSE, окружение и файл ключей; внешние адаптеры не загружаются.
 * Запись в журнал собирается строками, чтобы проверить отсутствие недоверенного секрета.
 */
async function routeFixture(t, { fetchImpl, patch = {}, modelsOf, neighbors = [], auth = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tripo-provider-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const envPath = path.join(root, '.env');
  const seenPath = path.join(root, 'seen.json');
  const env = { TRIPO_API_KEY: KEY, TRIPO_REGION: 'ov' };

  await fs.writeFile(envPath, `TRIPO_API_KEY=${KEY}\nTRIPO_REGION=ov\n`, { mode: 0o600 });

  const adapter = {
    ...createTripoAdapter({
      env,
      fetchImpl,
      sleep: async () => {}
    }),
    ...patch
  };
  const events = [];
  const logs = [];
  const app = Fastify({ logger: { stream: { write: (line) => logs.push(line) } } });

  t.after(() => app.close());
  app.decorate('sse', {
    broadcast: (event, payload) => events.push({ event, payload }),
    clientCount: () => 0,
  });

  if (auth) {
    await app.register(authPlugin, {
      authStore: { isConfigured: () => true, isValidSession: () => false },
    });
  }

  await app.register(providersModule, {
    prefs: { read: () => ({ providerUsageAutoRefresh: true }) },
    config: {
      modelsPath: path.join(root, 'models.json'),
      providerUsageSeenPath: seenPath,
      envPath
    },
    env,
    getProviderAdapters: async () => new Map([adapter, ...neighbors].map((item) => [item.id, item])),
    getModelsRegistry: modelsOf ?? (async () => ({})),
  });

  const save = (values) => app.inject({
    method: 'POST',
    url: '/api/providers/tripo/credentials',
    payload: { values },
  });

  return {
    app,
    env,
    events,
    logs,
    save,
    envPath,
    seenPath
  };
}

/**
 * Подменяет исключительно HTTP Tripo, оставляя production-разбор ответа.
 * Счётчик запросов отличает строгий отказ от случайного повтора API.
 */
function fixture(response, extra = {}) {
  const calls = [];
  const env = { TRIPO_API_KEY: KEY };
  const adapter = createTripoAdapter({
    env,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });

      return typeof response === 'function' ? response(calls.length, options) : response;
    },
    sleep: async () => {},
    ...extra,
  });

  return {
    adapter,
    env,
    calls
  };
}

function balance(balance = 215, frozen = 100) {
  return new Response(JSON.stringify({ code: 0, data: { balance, frozen } }));
}

test('без ключа нет HTTP, probe/bin не требуют CLI; один адаптер читает живое env', async () => {
  const f = fixture(() => balance());

  f.env.TRIPO_API_KEY = '   ';

  assert.equal(f.adapter.bin(), null);
  assert.deepEqual(await f.adapter.probe(), { ok: true, version: null });
  assert.equal((await f.adapter.auth()).available, false);
  assert.equal((await f.adapter.usage()).state, 'auth_required');
  assert.equal(f.calls.length, 0);
  f.env.TRIPO_API_KEY = ` ${KEY} `;
  f.env.TRIPO_REGION = ' cn ';
  assert.equal((await f.adapter.auth()).available, true);
  assert.equal((await f.adapter.usage()).state, 'ok');
  assert.equal(f.calls[0].url, 'https://openapi.tripo3d.com/v3/account/balance');
});

test('оба региона используют точный GET, заголовки и credits без повторного вычитания резерва', async () => {
  for (const region of ['ov', 'cn', 'unknown']) {
    const f = fixture(() => balance());

    f.env.TRIPO_REGION = region;

    const usage = await f.adapter.usage();
    const resource = usage.resources[0];

    assert.equal(usage.state, 'ok');
    assert.deepEqual(usage.bars, []);
    assert.equal(resource.summary, '215 кредитов · 100 в резерве');
    assert.equal(resource.kind, undefined);
    assert.equal(resource.tone, 'ok');
    assert.equal(f.calls[0].options.method, 'GET');
    assert.equal(f.calls[0].options.redirect, 'manual');
    assert.equal(f.calls[0].options.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(f.calls[0].options.headers.Accept, 'application/json');
    assert.equal(resource.controls[0].href, region === 'cn'
      ? 'https://developers.tripo3d.com/billing/recharge'
      : 'https://developers.tripo3d.ai/billing');
    assert.equal(f.calls[0].options.signal.aborted, false);
  }
});

test('показанное округление определяет склонение, ноль и отрицательный баланс допустимы', async () => {
  for (const [value, expected] of [
    [0, '0 кредитов'], [-0, '0 кредитов'], [-1, '-1 кредит'], [1.999, '2 кредита'],
    [1.5, '1,5 кредита'], [11, '11 кредитов'], [21, '21 кредит'], [24, '24 кредита'],
  ]) {
    const f = fixture(() => balance(value, 0));
    const resource = (await f.adapter.usage()).resources[0];

    assert.equal(resource.summary, expected);
    assert.equal(resource.tone, value <= 0 ? 'bad' : 'ok');
  }
});

test('оба обязательных числа и объекты проверяются строго, JSON-ошибка не повторяется', async () => {
  const invalid = [[], null, { code: '0', data: { balance: 1, frozen: 0 } }, { code: 0, data: [] }];

  for (const field of ['balance', 'frozen']) {
    for (const value of [undefined, null, '12', NaN, Infinity]) {
      invalid.push({
        code: 0,
        data: {
          balance: 1,
          frozen: 0,
          [field]: value
        }
      });
    }
  }

  invalid.push({ code: 0, data: { balance: 1, frozen: -1 } });

  for (const payload of invalid) {
    const f = fixture(() => new Response(JSON.stringify(payload)));
    const usage = await f.adapter.usage();

    assert.equal(usage.state, 'unavailable');
    assert.deepEqual(usage.resources, []);
    assert.equal(f.calls.length, 1);
  }

  for (const body of ['', '{invalid']) {
    const f = fixture(() => new Response(body));

    assert.equal((await f.adapter.usage()).state, 'unavailable');
    assert.equal(f.calls.length, 1);
  }
});

test('HTTP имеет приоритет; известный отказ не читает повреждённое или зависшее body', async () => {
  for (const [status, state] of [[401, 'auth_required'], [403, 'auth_required'], [429, 'rate_limited'],
    [500, 'unavailable'], [302, 'unavailable']]) {
    const f = fixture(() => ({
      status,
      headers: new Headers(),
      body: { cancel: async () => {} },
      text: () => assert.fail('HTTP-отказ не должен зависеть от body'),
    }));

    assert.equal((await f.adapter.usage()).state, state);
    assert.equal(f.calls.length, 1);
  }

  for (const [code, state] of [[1000, 'auth_required'], [1001, 'auth_required'],
    [1002, 'auth_required'], [1005, 'auth_required'], [1007, 'rate_limited'],
    [2000, 'rate_limited'], [9999, 'unavailable']]) {
    const f = fixture(() => new Response(JSON.stringify({
      code,
      message: KEY,
      suggestion: KEY
    })));
    const usage = await f.adapter.usage();

    assert.equal(usage.state, state);
    assert.equal(f.calls.length, 1);
    assert.equal(JSON.stringify(usage).includes(KEY), false);
  }
});

test('сеть до headers и в body повторяется до трёх раз с одним снимком ключа/региона', async () => {
  for (const bodyFailure of [false, true]) {
    const f = fixture((attempt) => {
      if (attempt > 1) {
        return balance();
      }

      f.env.TRIPO_API_KEY = 'another-key';
      f.env.TRIPO_REGION = 'cn';

      if (bodyFailure) {
        return { status: 200, text: async () => {
          throw new Error(KEY);
        } };
      }

      throw new Error(KEY);
    });

    assert.equal((await f.adapter.usage()).state, 'ok');
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls.every((call) => call.options.headers.Authorization === `Bearer ${KEY}`));
    assert.ok(f.calls.every((call) => call.url.includes('tripo3d.ai')));
  }

  const f = fixture(() => {
    const error = new Error(KEY);

    error.name = KEY;
    error.cause = { code: KEY };

    throw error;
  });
  const usage = await f.adapter.usage();

  assert.equal(usage.state, 'unavailable');
  assert.equal(f.calls.length, 3);
  assert.equal(JSON.stringify({ usage, auth: await f.adapter.auth() }).includes(KEY), false);
});

test('Retry-After и reset дают только будущее представимое время', async () => {
  const now = Date.UTC(2026, 0, 1);

  for (const [headers, expected] of [
    [{ 'Retry-After': '12' }, now + 12_000],
    [{ 'Retry-After': new Date(now + 30_000).toUTCString() }, now + 30_000],
    [{ 'Retry-After': 'bad', 'X-RateLimit-Reset': String(now / 1000 + 40) }, now + 40_000],
    [{ 'Retry-After': '-1' }, undefined], [{ 'Retry-After': '0' }, undefined],
    [{ 'Retry-After': '1e999' }, undefined], [{ 'X-RateLimit-Reset': '' }, undefined],
    [{ 'Retry-After': '8800000000000' }, undefined],
    [{ 'X-RateLimit-Reset': '8800000000000' }, undefined],
    [{ 'X-RateLimit-Reset': String(now / 1000 - 1) }, undefined],
  ]) {
    const f = fixture(() => new Response('', { status: 429, headers }), { now: () => now });

    assert.equal((await f.adapter.usage()).retryAt, expected);
  }
});

test('управляемые дедлайны охватывают headers/body, AbortSignal и общий срок; таймеры сняты', async () => {
  for (const phase of ['headers', 'body']) {
    let time = 0;
    let nextId = 0;
    const timers = new Map();
    const signals = [];
    const durations = [];
    const f = fixture((_, options) => {
      signals.push(options.signal);

      return phase === 'headers' ? new Promise(() => {}) : {
        status: 200,
        text: () => new Promise(() => {}),
      };
    }, {
      now: () => time,
      setTimer: (callback, ms) => {
        durations.push(ms);
        nextId += 1;
        timers.set(nextId, { callback, at: time + ms });

        return nextId;
      },
      clearTimer: (id) => timers.delete(id),
      // Дополнительное время здесь моделирует задержку event loop между попытками.
      sleep: async (ms) => {
        time += ms + 1_000;
      },
    });
    let finished = false;
    const reading = f.adapter.usage().then((usage) => {
      finished = true;

      return usage;
    });

    for (let step = 0; step < 100 && !finished; step += 1) {
      await Promise.resolve();

      const [id, timer] = timers.entries().next().value ?? [];

      if (timer) {
        time = timer.at;
        timers.delete(id);
        timer.callback();
      }
    }

    assert.equal(finished, true);
    assert.equal((await reading).state, 'unavailable');
    assert.deepEqual(durations, [8_000, 8_000, 6_250]);
    assert.equal(time, 25_000);
    assert.equal(signals.every((signal) => signal.aborted), true);
    assert.equal(timers.size, 0);
  }
});

test('commit не ждёт моделей/баланса, сразу сообщает credentials; отказ не инвалидирует', async (t) => {
  const models = deferred();
  const f = await routeFixture(t, {
    fetchImpl: async () => balance(),
    modelsOf: async (_, options) => options?.refresh ? models.promise : {},
  });
  const saved = await f.save({ TRIPO_API_KEY: 'second-secret', TRIPO_REGION: 'cn' });

  assert.equal(saved.statusCode, 200);
  assert.deepEqual(f.events, [{ event: 'providers-update', payload: { credentials: 'tripo' } }]);
  assert.equal(f.env.TRIPO_REGION, 'cn');
  assert.equal((await f.save({ TRIPO_REGION: 'elsewhere' })).statusCode, 400);
  assert.equal((await f.save({ FOREIGN_KEY: 'value' })).statusCode, 400);
  assert.equal(f.events.length, 1);
  await fs.writeFile(f.envPath, 'MULTI="first\nsecond"\n');
  assert.equal((await f.save({ TRIPO_API_KEY: 'conflict' })).statusCode, 409);
  assert.equal(f.env.TRIPO_API_KEY, 'second-secret');
  assert.equal(f.events.length, 1);
  models.reject(new Error('catalog unavailable'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.events.at(-1), { event: 'providers-update', payload: {} });
});

test('Tripo HTTP и credentials закрыты общим auth guard', async (t) => {
  const f = await routeFixture(t, { auth: true, fetchImpl: () => assert.fail('Запрос без входа') });

  for (const url of ['/api/providers', '/api/providers/usage']) {
    assert.equal((await f.app.inject({ url })).statusCode, 401);
  }

  assert.equal((await f.save({ TRIPO_API_KEY: 'other' })).statusCode, 401);
});

test('старый success/error/429 после смены не меняет HTTP, SSE, cache/backoff и seen', async (t) => {
  for (const outcome of ['success', 'error', '429']) {
    for (const entry of ['get', 'refresh', 'background']) {
      await t.test(`${outcome}/${entry}`, async (scenario) => {
        const old = deferred();
        const started = deferred();
        let reads = 0;
        const f = await routeFixture(scenario, {
          patch: {
            usage: async () => {
              reads += 1;

              if (reads === 1) {
                started.resolve();

                return old.promise;
              }

              return {
                state: 'ok',
                resources: [{
                  key: 'credits',
                  label: 'Кредиты',
                  summary: 'B'
                }]
              };
            },
          },
        });
        const pending = entry === 'background' ? f.app.refreshProvidersUsage() : f.app.inject({
          method: entry === 'get' ? 'GET' : 'POST',
          url: entry === 'get' ? '/api/providers/usage' : '/api/providers/usage/refresh',
          ...(entry === 'refresh' ? { payload: { providerId: 'tripo' } } : {}),
        });

        await started.promise;
        assert.equal((await f.save({ TRIPO_API_KEY: 'new-account' })).statusCode, 200);

        const newer = await f.app.inject({ url: '/api/providers/usage' });

        assert.equal(newer.json().usage.tripo.resources[0].summary, 'B');

        if (outcome === 'error') {
          old.reject(Object.assign(new Error(KEY), { name: KEY, cause: { code: KEY } }));
        } else {
          old.resolve(outcome === '429'
            ? {
              state: 'rate_limited',
              retryAt: Date.now() + 999_999,
              message: KEY
            }
            : {
              state: 'ok',
              bars: [{
                key: 'old',
                group: 'old-account'
              }],
              resources: [
              {
                key: 'credits',
                label: 'Кредиты',
                summary: 'A'
              },
            ]
            });
        }

        const response = await pending;

        if (entry !== 'background') {
          assert.equal(response.json().usage.tripo.resources[0].summary, 'B');
          assert.equal(response.json().usage.tripo.retryAt, undefined);
        }

        assert.equal(reads, 2, 'читатели нового поколения обязаны разделять запрос');
        assert.ok(f.events.filter((event) => event.event === 'providers-usage')
          .every((event) => event.payload.usage.tripo.resources[0].summary === 'B'));

        const fresh = await f.app.inject({ url: '/api/providers/usage' });

        assert.equal(fresh.json().usage.tripo.resources[0].summary, 'B');
        assert.equal(fresh.json().usage.tripo.retryAt, undefined);
        assert.equal(JSON.stringify({ events: f.events, logs: f.logs }).includes(KEY), false);

        const seen = await fs.readFile(f.seenPath, 'utf8').catch(() => '');

        assert.equal(seen.includes('old-account'), false);
      });
    }
  }
});

test('несколько смен разделяют последнее поколение и удаление не сохраняет прежние ресурсы', async (t) => {
  const first = deferred();
  const second = deferred();
  const starts = [deferred(), deferred()];
  let reads = 0;
  const f = await routeFixture(t, {
    patch: {
      usage: async () => {
        reads += 1;
        starts[reads - 1]?.resolve();

        return reads === 1 ? first.promise : reads === 2 ? second.promise
          : {
            state: 'auth_required',
            bars: [],
            resources: []
          };
      },
    },
  });
  const a = f.app.inject({ url: '/api/providers/usage' });

  await starts[0].promise;
  await f.save({ TRIPO_API_KEY: 'second' });

  const b = f.app.inject({ url: '/api/providers/usage' });

  await starts[1].promise;
  await f.save({ TRIPO_API_KEY: null });

  const c = await f.app.inject({ url: '/api/providers/usage' });

  first.resolve({
    state: 'ok',
    resources: [{
      key: 'credits',
      label: 'Кредиты',
      summary: 'A'
    }]
  });
  second.resolve({ state: 'rate_limited', retryAt: Date.now() + 999_999 });

  for (const response of [await a, await b, c]) {
    assert.equal(response.json().usage.tripo.state, 'auth_required');
    assert.deepEqual(response.json().usage.tripo.resources, []);
    assert.equal(response.json().usage.tripo.retryAt, undefined);
  }

  assert.equal(reads, 3);

  const card = (await f.app.inject({ url: '/api/providers' })).json().providers[0];

  assert.equal(card.available, false);
});

test('сброс паузы изменённого аккаунта сохраняет backoff и previous другого исполнителя', async (t) => {
  let neighborReads = 0;
  let tripoReads = 0;
  const neighbor = {
    ...createTripoAdapter({ env: {} }),
    id: 'neighbor',
    usage: async () => {
      neighborReads += 1;

      return {
        state: 'rate_limited',
        retryAt: Date.now() + 999_999,
        message: 'Сосед ждёт'
      };
    },
  };
  const f = await routeFixture(t, {
    neighbors: [neighbor],
    patch: { usage: async () => {
      tripoReads += 1;

      return { state: 'rate_limited', message: 'Tripo ждёт' };
    } },
  });
  const first = (await f.app.inject({ url: '/api/providers/usage' })).json().usage;

  await f.save({ TRIPO_REGION: 'cn' });

  const next = (await f.app.inject({ url: '/api/providers/usage' })).json().usage;

  assert.equal(tripoReads, 2);
  assert.equal(neighborReads, 1);
  assert.deepEqual(next.neighbor, first.neighbor);
  assert.ok(next.tripo.retryAt > Date.now() + 3 * 60_000);
});

test('поздний auth/probe не откатывает registry HTTP/cache и providerRegistry', async (t) => {
  const old = deferred();
  const started = deferred();
  let reads = 0;
  const f = await routeFixture(t, {
    patch: {
      auth: async () => {
        reads += 1;

        if (reads === 1) {
          started.resolve();

          return old.promise;
        }

        return {
          mode: 'env',
          available: false,
          label: 'Новый аккаунт'
        };
      },
    },
  });
  const pending = f.app.inject({ url: '/api/providers' });
  const decorator = f.app.providerRegistry();

  await started.promise;
  await f.save({ TRIPO_API_KEY: null });

  const next = await f.app.inject({ url: '/api/providers' });

  old.resolve({
    mode: 'env',
    available: true,
    label: 'Прежний аккаунт'
  });

  const previous = await pending;

  assert.equal(next.json().providers[0].available, false);
  assert.equal(previous.json().providers[0].authLabel, 'Новый аккаунт');
  assert.deepEqual(await decorator, {});
  assert.equal((await f.app.inject({ url: '/api/providers' })).json().providers[0].available, false);
});

test('недоверенные поля Tripo не попадают в HTTP/SSE/logs, ключ виден только штатным preview', async (t) => {
  const f = await routeFixture(t, {
    fetchImpl: async () => new Response(JSON.stringify({
      code: 1000,
      message: KEY,
      suggestion: KEY,
      request_id: KEY,
      error: {
        name: KEY,
        message: KEY,
        cause: {
          code: KEY
        }
      },
    })),
  });
  const list = await f.app.inject({ url: '/api/providers' });
  const usage = await f.app.inject({
    method: 'POST',
    url: '/api/providers/usage/refresh',
    payload: { providerId: 'tripo' },
  });

  assert.equal(list.json().providers[0].credentials[0].preview, '…cdef');
  assert.equal(usage.json().usage.tripo.state, 'auth_required');
  assert.equal(JSON.stringify({
    list: list.body,
    usage: usage.body,
    events: f.events,
    logs: f.logs
  })
    .includes(KEY), false);
});

test('ACK плюс SSE запускают два GET, разделяющие единственную проверку текущего аккаунта', async (t) => {
  const { createPinia, setActivePinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs');
  const { useProvidersStore } = await import('../../web/src/stores/providers.ts');
  const { api } = await import('../../web/src/shared/apiClient.ts');
  const response = deferred();
  const started = deferred();
  let reads = 0;
  const f = await routeFixture(t, {
    fetchImpl: async () => {
      reads += 1;
      started.resolve();

      return response.promise;
    },
  });
  const original = { get: api.get, post: api.post };
  const usageGets = [];

  t.after(() => {
    api.get = original.get;
    api.post = original.post;
  });
  api.get = (url) => {
    const reading = f.app.inject({ url }).then((reply) => reply.json());

    if (url === '/api/providers/usage') {
      usageGets.push(reading);
    }

    return reading;
  };
  api.post = (url, payload) => f.app.inject({
    method: 'POST',
    url,
    payload
  }).then((reply) => reply.json());
  setActivePinia(createPinia());

  const store = useProvidersStore();
  const broadcast = f.app.sse.broadcast;

  store.usage = { tripo: { resources: [{ summary: 'Прежний счёт' }] } };
  f.app.sse.broadcast = (event, payload) => {
    broadcast(event, payload);

    if (event === 'providers-update' && payload.credentials) {
      void store.invalidateCredentials(payload.credentials);
    }
  };
  assert.deepEqual(await store.saveCredentials('tripo', { TRIPO_REGION: 'cn' }), { ok: true });
  await started.promise;
  assert.equal(store.usage.tripo, undefined);
  assert.equal(usageGets.length, 2);
  response.resolve(balance());
  await Promise.all(usageGets);

  assert.equal(reads, 1);
  assert.equal(store.usage.tripo.resources[0].summary, '215 кредитов · 100 в резерве');
  assert.equal(store.usage.tripo.resources[0].controls[0].href,
    'https://developers.tripo3d.com/billing/recharge');
});
