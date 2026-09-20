// Прогноз лимитов: ряды из снимков тика, обнаружение сброса с его природой, вердикт
// «хватит ли до сброса» и связка модуля через ту же SSE-шину, что кормит окна.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  emptyForecastState,
  forecastSeries,
  ingestUsage,
} from '../../server/src/lib/usage-forecast/forecast.ts';
import { readForecastState, writeForecastState } from '../../server/src/lib/usage-forecast/store.ts';
import usageForecastModule from '../../server/src/modules/usage-forecast/index.ts';
import { parseUsageForecastSnapshot } from '../../shared/usageForecastContracts.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const HOUR = 60 * 60_000;
const T0 = Date.parse('2026-09-15T08:00:00.000Z');

// Снимок лимитов одного исполнителя с одной недельной полосой. Длина окна по умолчанию
// не передаётся: так ряд ведёт себя как короткое окно и судится по текущему темпу.
function usageOf(pct, { at, resetsAt = T0 + 4 * 24 * HOUR, key = 'codex:primary', windowMinutes } = {}) {
  return {
    codex: {
      state: 'ok',
      bars: [{
        key,
        label: 'Неделя (7д)',
        pct,
        resetsAt: new Date(resetsAt).toISOString(),
        ...(windowMinutes !== undefined && { windowMinutes }),
      }],
      dataCheckedAt: at,
    },
  };
}

// Ряд из равномерных замеров: процент растёт на `step` каждые `everyMs`.
function ramp(from, step, count, { start = T0, everyMs = 10 * 60_000 } = {}) {
  let state = emptyForecastState();

  for (let index = 0; index < count; index += 1) {
    const at = start + index * everyMs;

    ({ state } = ingestUsage(state, usageOf(from + step * index, { at }), { now: at }));
  }

  return state;
}

test('повтор того же снимка ряд не удлиняет, новый — удлиняет', () => {
  const first = ingestUsage(emptyForecastState(), usageOf(10, { at: T0 }), { now: T0 });
  const repeat = ingestUsage(first.state, usageOf(10, { at: T0 }), { now: T0 + HOUR });
  const next = ingestUsage(repeat.state, usageOf(12, { at: T0 + HOUR }), { now: T0 + HOUR });

  assert.equal(repeat.state.series[0].samples.length, 1);
  assert.equal(next.state.series[0].samples.length, 2);
  assert.deepEqual(next.resets, []);
});

test('падение процента при уехавшем окне — сброс, и его природа читается по срокам', () => {
  const resetsAt = T0 + 2 * HOUR;
  const base = ingestUsage(emptyForecastState(), usageOf(91, { at: T0, resetsAt }), { now: T0 });

  // Окно истекло само: прежний срок сброса уже позади.
  const scheduled = ingestUsage(
    base.state,
    usageOf(1, { at: T0 + 3 * HOUR, resetsAt: T0 + 9 * 24 * HOUR }),
    { now: T0 + 3 * HOUR },
  );

  assert.equal(scheduled.resets.length, 1);
  assert.equal(scheduled.resets[0].origin, 'scheduled');
  assert.equal(scheduled.resets[0].fromPct, 91);
  assert.equal(scheduled.resets[0].toPct, 1);

  // Срок сброса впереди, а за десять минут до падения нажали «сброс лимита» — наш.
  const own = ingestUsage(
    base.state,
    usageOf(0, { at: T0 + HOUR, resetsAt: T0 + 8 * 24 * HOUR }),
    { now: T0 + HOUR, ownActions: new Map([['codex', T0 + HOUR - 10 * 60_000]]) },
  );

  assert.equal(own.resets[0].origin, 'own');

  // Срок впереди, нажатия не было — окно открыл вендор.
  const external = ingestUsage(
    base.state,
    usageOf(0, { at: T0 + HOUR, resetsAt: T0 + 8 * 24 * HOUR }),
    { now: T0 + HOUR },
  );

  assert.equal(external.resets[0].origin, 'external');

  // Падение при том же сроке сброса — погрешность вендора, а не сброс.
  const wobble = ingestUsage(base.state, usageOf(84, { at: T0 + HOUR, resetsAt }), { now: T0 + HOUR });

  assert.deepEqual(wobble.resets, []);
});

test('вердикт: мало данных → unknown, стоит → idle, темп против срока → enough/short', () => {
  const short = ramp(10, 1, 2);

  assert.equal(forecastSeries(short.series[0], { now: T0 + 10 * 60_000 }).verdict, 'unknown');

  const idle = ramp(40, 0, 7);
  const idleForecast = forecastSeries(idle.series[0], { now: T0 + HOUR });

  assert.equal(idleForecast.verdict, 'idle');
  assert.equal(idleForecast.ratePerHour, 0);

  // +2 пункта каждые 10 минут = 12 пунктов в час; с 60 % остаток съедается за ~3 часа,
  // а сброс через четверо суток — не хватит.
  const fast = ramp(40, 2, 7);
  const fastForecast = forecastSeries(fast.series[0], { now: T0 + HOUR });

  assert.equal(fastForecast.verdict, 'short');
  assert.equal(fastForecast.ratePerHour, 12);
  assert.equal(fastForecast.pct, 52);
  assert.ok(fastForecast.exhaustAt);
  assert.ok(Date.parse(fastForecast.exhaustAt) < Date.parse(fastForecast.resetsAt));

  // Тот же темп, но сброс через час — хватит.
  let slow = emptyForecastState();

  for (let index = 0; index < 7; index += 1) {
    const at = T0 + index * 10 * 60_000;

    ({ state: slow } = ingestUsage(
      slow,
      usageOf(40 + 2 * index, { at, resetsAt: T0 + 2 * HOUR }),
      { now: at },
    ));
  }
  assert.equal(forecastSeries(slow.series[0], { now: T0 + HOUR }).verdict, 'enough');
});

test('окно от суток судится по среднему темпу с начала окна, а не по последним двум часам', () => {
  // Неделя: до сброса 65,5 ч, значит прошло 102,5 ч; 59 % за это время — 0,58 %/ч,
  // к сбросу выйдет ~97 % — впритык, но хватит. Текущий темп 1,7 %/ч обещал бы «не хватит».
  const resetsAt = T0 + 65.5 * HOUR;
  let state = emptyForecastState();

  for (let index = 0; index < 7; index += 1) {
    const at = T0 - HOUR + index * 10 * 60_000;

    ({ state } = ingestUsage(
      state,
      usageOf(57.3 + index * 0.283, { at, resetsAt, windowMinutes: 10_080 }),
      { now: at },
    ));
  }

  const weekly = forecastSeries(state.series[0], { now: T0 });

  assert.equal(weekly.basis, 'average');
  assert.equal(weekly.windowMinutes, 10_080);
  assert.equal(weekly.averagePerHour, 0.58);
  assert.equal(weekly.projectedPct, 97);
  assert.equal(weekly.verdict, 'enough');
  assert.equal(weekly.ratePerHour, 1.7);
  assert.ok(Date.parse(weekly.exhaustAt) > resetsAt);

  // 91 % за трое суток из семи — при среднем темпе к сбросу выйдет 212 %: не хватит.
  const burnt = ingestUsage(
    emptyForecastState(),
    usageOf(91, { at: T0, resetsAt: T0 + 4 * 24 * HOUR, windowMinutes: 10_080 }),
    { now: T0 },
  );
  const hot = forecastSeries(burnt.state.series[0], { now: T0 });

  assert.equal(hot.basis, 'average');
  assert.equal(hot.projectedPct, 212);
  assert.equal(hot.verdict, 'short');
  assert.equal(hot.ratePerHour, null);

  // Окно прожило два часа — среднее ещё ничего не значит, судим как короткое окно.
  const young = ingestUsage(
    emptyForecastState(),
    usageOf(2, { at: T0, resetsAt: T0 + 166 * HOUR, windowMinutes: 10_080 }),
    { now: T0 },
  );

  assert.equal(forecastSeries(young.state.series[0], { now: T0 }).basis, null);
  assert.equal(forecastSeries(young.state.series[0], { now: T0 }).verdict, 'unknown');

  // Сессия в пять часов — по текущему темпу, как и раньше.
  let session = emptyForecastState();

  for (let index = 0; index < 7; index += 1) {
    const at = T0 + index * 10 * 60_000;

    ({ state: session } = ingestUsage(
      session,
      usageOf(40 + 2 * index, { at, resetsAt: T0 + 2 * HOUR, key: 'codex:5h', windowMinutes: 300 }),
      { now: at },
    ));
  }

  const short = forecastSeries(session.series[0], { now: T0 + HOUR });

  assert.equal(short.basis, 'current');
  assert.equal(short.averagePerHour, null);
  assert.equal(short.verdict, 'enough');
});

test('темп после сброса внутри окна считается только по замерам после него', () => {
  let state = ramp(90, 2, 4);

  for (let index = 0; index < 4; index += 1) {
    const at = T0 + (4 + index) * 10 * 60_000;

    ({ state } = ingestUsage(
      state,
      usageOf(index * 3, { at, resetsAt: T0 + 10 * 24 * HOUR }),
      { now: at },
    ));
  }

  const forecast = forecastSeries(state.series[0], { now: T0 + 70 * 60_000 });

  assert.equal(forecast.ratePerHour, 18);
  assert.equal(forecast.spanMinutes, 30);
  assert.equal(forecast.verdict, 'short');
});

test('хранилище: отсутствие файла — чистый старт, мусор — чистый старт с предупреждением', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-forecast-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'nested', 'usage-forecast.json');

  assert.deepEqual(readForecastState(file), { state: emptyForecastState(), warning: null });

  const state = ramp(1, 1, 3);

  writeForecastState(file, state);
  assert.deepEqual(readForecastState(file), { state, warning: null });

  await fs.writeFile(file, '{oops');
  const broken = readForecastState(file);

  assert.deepEqual(broken.state, emptyForecastState());
  assert.match(broken.warning, /повреждён/);
});

// Шина SSE как в плагине: рассылка вкладкам подменена списком, подписка настоящая.
function sseBus({ clients = 0 } = {}) {
  const listeners = new Set();
  const sent = [];

  return {
    sent,
    clients,
    broadcast(name, payload) {
      sent.push({ name, payload });
      for (const listener of listeners) {
        listener(name, payload);
      }
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    clientCount() {
      return this.clients;
    },
  };
}

// Таймер короткий, но точности Node не обещает: ждём условие с запасом.
async function waitFor(check, limitMs = 3000) {
  const deadline = Date.now() + limitMs;

  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  return true;
}

test('без окон модуль сам зовёт хук перечитывания лимитов, при открытом окне — молчит', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-forecast-sampler-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  const bus = sseBus({ clients: 0 });
  let refreshes = 0;

  app.decorate('sse', bus);
  app.decorate('refreshProvidersUsage', async () => {
    refreshes += 1;
  });
  await app.register(usageForecastModule, {
    filePath: path.join(root, 'usage-forecast.json'),
    sampleTickMs: 20,
  });
  await app.ready();
  t.after(() => app.close());

  assert.ok(await waitFor(() => refreshes >= 2), 'таймер без окон не дёрнул хук');

  // Окно открылось — фон отдаёт замеры тику providers, свой хук больше не зовёт.
  bus.clients = 1;
  await new Promise((resolve) => setTimeout(resolve, 60));
  const seen = refreshes;

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(refreshes, seen);
});

test('выключенный плагин инертен: маршрут 404, снимки не копятся, фон молчит', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-forecast-disabled-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  const bus = sseBus();
  let enabled = false;
  let refreshes = 0;

  app.decorate('sse', bus);
  app.decorate('pluginEnabled', () => enabled);
  app.decorate('pluginSettings', () => ({}));
  app.decorate('refreshProvidersUsage', async () => {
    refreshes += 1;
  });
  await app.register(usageForecastModule, {
    filePath: path.join(root, 'usage-forecast.json'),
    sampleTickMs: 20,
    // Фиксированная дата снимков не должна протухать вместе с календарём запуска теста.
    now: () => T0 + 10 * 60_000,
  });
  await app.ready();
  t.after(() => app.close());

  bus.broadcast('providers-usage', { usage: usageOf(50, { at: T0 }) });
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal((await app.inject({ method: 'GET', url: '/api/usage-forecast' })).statusCode, 404);
  assert.equal(bus.sent.filter((event) => event.name === 'usage-forecast').length, 0);
  assert.equal(refreshes, 0);

  // Тумблер включили — без рестарта всё оживает.
  enabled = true;
  bus.broadcast('providers-usage', { usage: usageOf(52, { at: T0 + 10 * 60_000 }) });
  const response = await app.inject({ method: 'GET', url: '/api/usage-forecast' });

  assert.equal(response.statusCode, 200);
  assert.equal(parseUsageForecastSnapshot(response.json()).bars.length, 1);
  assert.ok(await waitFor(() => refreshes >= 1), 'фоновый замер не ожил');
});

test('область по исполнителям: чужие снимки не копятся', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-forecast-scope-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = Fastify({ logger: false });
  const bus = sseBus();
  let settings = { providers: ['claude'] };

  app.decorate('sse', bus);
  app.decorate('pluginEnabled', () => true);
  app.decorate('pluginSettings', () => settings);
  await app.register(usageForecastModule, {
    filePath: path.join(root, 'usage-forecast.json'),
    sampleTickMs: 0,
    // Держим retention и прогноз в той же шкале, что и синтетические события выше.
    now: () => T0 + 10 * 60_000,
  });
  await app.ready();
  t.after(() => app.close());

  bus.broadcast('providers-usage', {
    usage: {
      ...usageOf(50, { at: T0 }),
      claude: { state: 'ok', bars: [{ key: 'weekly', label: 'Неделя (7д)', pct: 20 }], dataCheckedAt: T0 },
    },
  });

  const scoped = parseUsageForecastSnapshot((await app.inject({ method: 'GET', url: '/api/usage-forecast' })).json());

  assert.deepEqual(scoped.bars.map((bar) => bar.providerId), ['claude']);

  // Область сняли — ряд Codex начнётся только со следующего снимка: прошлый не копился.
  settings = { providers: [] };
  const all = parseUsageForecastSnapshot((await app.inject({ method: 'GET', url: '/api/usage-forecast' })).json());

  assert.deepEqual(all.bars.map((bar) => bar.providerId), ['claude']);

  bus.broadcast('providers-usage', { usage: usageOf(52, { at: T0 + 10 * 60_000 }) });
  const later = parseUsageForecastSnapshot((await app.inject({ method: 'GET', url: '/api/usage-forecast' })).json());

  assert.deepEqual(later.bars.map((bar) => bar.providerId).sort(), ['claude', 'codex']);
});

test('без хука в приложении модуль без окон просто ждёт событий', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-forecast-nohook-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = Fastify({ logger: false });

  app.decorate('sse', sseBus());
  await app.register(usageForecastModule, {
    filePath: path.join(root, 'usage-forecast.json'),
    sampleTickMs: 20,
  });
  await app.ready();
  t.after(() => app.close());

  await new Promise((resolve) => setTimeout(resolve, 80));
  const response = await app.inject({ method: 'GET', url: '/api/usage-forecast' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(parseUsageForecastSnapshot(response.json()).bars, []);
});

test('модуль слушает тик providers, отдаёт снимок, помнит своё нажатие сброса и пишет файл', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-forecast-module-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'usage-forecast.json');
  let clock = T0;
  const app = Fastify({ logger: false });
  const bus = sseBus();

  app.decorate('sse', bus);
  // Маршрут сброса лимита принадлежит providers; здесь — его заглушка с тем же URL.
  app.post('/api/providers/:id/usage-actions/consume-rate-limit-reset', async () => ({ ok: true }));
  await app.register(usageForecastModule, { filePath, now: () => clock });
  await app.ready();
  t.after(() => app.close());

  for (let index = 0; index < 4; index += 1) {
    clock = T0 + index * 10 * 60_000;
    bus.broadcast('providers-usage', { usage: usageOf(80 + index * 2, { at: clock }) });
  }

  const response = await app.inject({ method: 'GET', url: '/api/usage-forecast' });

  assert.equal(response.statusCode, 200);
  const snapshot = parseUsageForecastSnapshot(response.json());

  assert.equal(snapshot.bars.length, 1);
  assert.equal(snapshot.bars[0].verdict, 'short');
  assert.equal(snapshot.bars[0].ratePerHour, 12);
  assert.deepEqual(snapshot.resets, []);
  assert.equal(bus.sent.filter((event) => event.name === 'usage-forecast').length, 4);

  // Нажатие сброса в кокпите, через пять минут — окно с нуля: сброс «свой».
  clock = T0 + 40 * 60_000;
  const pressed = await app.inject({
    method: 'POST',
    url: '/api/providers/codex/usage-actions/consume-rate-limit-reset',
  });

  assert.equal(pressed.statusCode, 200);
  clock = T0 + 45 * 60_000;
  bus.broadcast('providers-usage', {
    usage: usageOf(0, { at: clock, resetsAt: clock + 7 * 24 * HOUR }),
  });

  const after = parseUsageForecastSnapshot((await app.inject({ method: 'GET', url: '/api/usage-forecast' })).json());

  assert.equal(after.resets.length, 1);
  assert.equal(after.resets[0].origin, 'own');
  assert.equal(after.resets[0].fromPct, 86);

  const stored = readForecastState(filePath);

  assert.equal(stored.warning, null);
  assert.equal(stored.state.resets.length, 1);
  assert.equal(stored.state.series[0].samples.length, 5);
});
