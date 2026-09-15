// Фоновая свежесть лимитов: сервер сам перечитывает их раз в период и рассылает по SSE,
// пока хотя бы одно окно держит поток. Пустой зал вендора не тревожит, а снимок, который
// только что принёс запрос окна, второй раз подряд не читается.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import providersModule from '../../server/src/modules/providers/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

// Исполнитель с API лимитов: каждое чтение считается, чтобы отличить «тик сходил»
// от «тик промолчал».
function tickingAdapter(onUsage) {
  return {
    id: 'ticking-provider',
    name: 'Ticking Provider',
    vendor: 'Test',
    color: '#123456',
    bin: () => '/bin/true',
    probe: async () => ({ ok: true, version: '1.0' }),
    auth: async () => ({ mode: 'none', label: 'ok', available: true }),
    seedModels: () => [],
    run: async () => ({ reply: 'ok' }),
    usage: async () => {
      onUsage();

      return { state: 'ok', bars: [{ key: 'week', label: 'Неделя', pct: 42 }] };
    },
  };
}

// Исполнитель, чей вендор просит стучаться реже. `retryAfterMs` — названный им срок:
// без него кокпит считает паузу своей шкалой.
function rateLimitedAdapter(onUsage, { retryAfterMs = 0 } = {}) {
  return {
    ...tickingAdapter(onUsage),
    usage: async () => {
      onUsage();

      return {
        state: 'rate_limited',
        message: 'Вендор временно ограничил запрос проверки лимитов.',
        ...(retryAfterMs ? { retryAt: Date.now() + retryAfterMs } : {}),
      };
    },
  };
}

async function tickFixture(t, { clients, usageTickMs, adapter }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-usage-tick-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const events = [];
  let usageReads = 0;
  const app = Fastify({ logger: false });

  app.decorate('sse', {
    broadcast(event, data) {
      events.push({ event, data });
    },
    clientCount: () => clients,
  });
  await app.register(providersModule, {
    config: {
      modelsPath: path.join(root, 'models.json'),
      providerUsageSeenPath: path.join(root, 'usage-seen.json'),
    },
    claudeAuth: null,
    usageTickMs,
    getProviderAdapters: async () => new Map([[
      'ticking-provider',
      (adapter ?? tickingAdapter)(() => { usageReads += 1; }),
    ]]),
  });
  t.after(() => app.close());

  return { app, events, reads: () => usageReads };
}

// Тик короткий, но таймеры Node точности не обещают: ждём условие с запасом.
async function waitFor(check, limitMs = 3000) {
  const deadline = Date.now() + limitMs;

  while (!check()) {
    if (Date.now() > deadline) return false;
    await sleep(5);
  }

  return true;
}

test('каталог объявляет поддержку порога только по контракту адаптера', async (t) => {
  for (const capability of [{}, { chatAutoCompact: true }, { autoCompactEnv: 'FIXTURE_COMPACT_WINDOW' }]) {
    const fixture = await tickFixture(t, {
      clients: 0,
      usageTickMs: 20,
      adapter: (onUsage) => ({ ...tickingAdapter(onUsage), ...capability }),
    });
    const response = await fixture.app.inject({ method: 'GET', url: '/api/providers' });
    assert.equal(response.statusCode, 200);
    const supported = response.json().providers[0].capabilities.chatAutoCompact;

    assert.equal(supported, Object.keys(capability).length > 0);
  }
});

test('без окон на потоке тик к вендору не ходит и ничего не рассылает', async (t) => {
  const fixture = await tickFixture(t, { clients: 0, usageTickMs: 20 });

  await sleep(150);
  assert.equal(fixture.reads(), 0);
  assert.deepEqual(fixture.events, []);
});

test('хук refreshProvidersUsage перечитывает и рассылает снимок без окон, но не чаще полупериода', async (t) => {
  const fixture = await tickFixture(t, { clients: 0, usageTickMs: 60_000 });

  await fixture.app.refreshProvidersUsage();
  assert.equal(fixture.reads(), 1);
  assert.equal(fixture.events.length, 1);
  assert.equal(fixture.events[0].event, 'providers-usage');
  assert.equal(fixture.events[0].data.usage['ticking-provider'].bars[0].pct, 42);

  // Снимок свежий — второй вызов подряд к вендору не идёт и события не даёт.
  await fixture.app.refreshProvidersUsage();
  assert.equal(fixture.reads(), 1);
  assert.equal(fixture.events.length, 1);
});

test('при открытом окне тик перечитывает лимиты и рассылает снимок событием providers-usage', async (t) => {
  const fixture = await tickFixture(t, { clients: 1, usageTickMs: 20 });

  assert.ok(await waitFor(() => fixture.events.length >= 1), 'тик не дал ни одного события');
  const [first] = fixture.events;
  assert.equal(first.event, 'providers-usage');
  assert.equal(first.data.usage['ticking-provider'].state, 'ok');
  assert.equal(first.data.usage['ticking-provider'].bars[0].pct, 42);
  assert.ok(fixture.reads() >= 1);
});

test('снимок, который только что принёс запрос окна, тик второй раз подряд не читает', async (t) => {
  const fixture = await tickFixture(t, { clients: 1, usageTickMs: 1000 });

  await sleep(700);
  const response = await fixture.app.inject({ method: 'GET', url: '/api/providers/usage' });
  assert.equal(response.statusCode, 200);
  assert.equal(fixture.reads(), 1);

  await sleep(400);
  assert.equal(fixture.reads(), 1, 'тик перечитал снимок моложе половины периода');
  assert.deepEqual(fixture.events, []);
});

// Фон стучится круглосуточно, а не пока водят мышью, поэтому «стучитесь реже» — единственная
// беда, на которую кокпит отвечает молчанием: повтор в прежнем темпе держал бы аккаунт
// в отказе сам. Тики при этом продолжают идти — они просто не ходят к вендору.
test('после отказа по частоте кокпит пропускает свои тики, а не стучится снова', async (t) => {
  const fixture = await tickFixture(t, {
    clients: 1,
    usageTickMs: 30,
    adapter: (onUsage) => rateLimitedAdapter(onUsage),
  });

  assert.ok(await waitFor(() => fixture.events.length >= 1), 'тик не дал ни одного события');
  assert.equal(fixture.reads(), 1);
  assert.equal(fixture.events[0].data.usage['ticking-provider'].state, 'rate_limited');

  // Пауза — три своих тика: за 70 мс их прошло бы два, и без паузы чтений было бы три.
  await sleep(70);
  assert.equal(fixture.reads(), 1, 'кокпит постучался к вендору внутри паузы');
  assert.ok(fixture.events.length >= 2, 'тики внутри паузы обязаны продолжаться');

  // По истечении паузы чтение возобновляется само, без вмешательства окна.
  assert.ok(await waitFor(() => fixture.reads() >= 2), 'после паузы чтение не возобновилось');
});

// Заголовок Retry-After вендора длиннее нашей шкалы: своя пауза не вправе сделать
// отступление короче, чем попросили.
test('названный вендором срок продлевает паузу сверх собственной шкалы', async (t) => {
  const fixture = await tickFixture(t, {
    clients: 1,
    usageTickMs: 20,
    adapter: (onUsage) => rateLimitedAdapter(onUsage, { retryAfterMs: 5_000 }),
  });

  assert.ok(await waitFor(() => fixture.events.length >= 1), 'тик не дал ни одного события');
  assert.equal(fixture.reads(), 1);

  // Своя пауза — три тика (60 мс) — давно истекла бы, а названный срок ещё идёт.
  await sleep(200);
  assert.equal(fixture.reads(), 1, 'кокпит постучался раньше названного вендором срока');
});

// Кнопка «проверить сейчас» обходит TTL кэша, но не пределы вендора: свежий снимок
// отдаётся как есть, а итог рассылается всем окнам — полосы общие.
test('принудительная проверка перечитывает лимиты, рассылает снимок и не дробит клики', async (t) => {
  const fixture = await tickFixture(t, { clients: 1, usageTickMs: 60_000 });

  const first = await fixture.app.inject({ method: 'POST', url: '/api/providers/usage/refresh' });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().usage['ticking-provider'].bars[0].pct, 42);
  assert.equal(fixture.reads(), 1);
  assert.deepEqual(fixture.events.map((event) => event.event), ['providers-usage']);

  const second = await fixture.app.inject({ method: 'POST', url: '/api/providers/usage/refresh' });
  assert.equal(second.statusCode, 200);
  assert.equal(fixture.reads(), 1, 'снимок моложе 15 секунд перечитан второй раз подряд');
});

// Срок паузы едет в снимок: по нему всплывашка гасит кнопку и называет время вместо
// того, чтобы клик молча возвращал прошлые цифры.
test('после отказа вендора снимок называет срок, до которого проверять не будем', async (t) => {
  const before = Date.now();
  const fixture = await tickFixture(t, {
    clients: 1,
    usageTickMs: 60_000,
    adapter: (onUsage) => rateLimitedAdapter(onUsage),
  });

  const response = await fixture.app.inject({ method: 'POST', url: '/api/providers/usage/refresh' });
  const snapshot = response.json().usage['ticking-provider'];

  assert.equal(snapshot.state, 'rate_limited');
  // Своя пауза — три тика по минуте: срок лежит между «через 3 минуты от начала» и «сейчас + 3».
  assert.ok(snapshot.retryAt >= before + 3 * 60_000, 'срок короче собственной паузы');
  assert.ok(snapshot.retryAt <= Date.now() + 3 * 60_000, 'срок длиннее собственной паузы');
});
