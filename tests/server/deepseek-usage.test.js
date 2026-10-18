// Состояние счёта DeepSeek во всплывашке: у предоплаты нет окон лимитов, поэтому вместо
// «CLI не отдаёт лимиты» адаптер отдаёт остаток, текущую фазу тарифа и темп расхода по
// своим снимкам. Ключ службы наружу не попадает — ни в тексты, ни на публичную страницу
// цен; пополнение не считается расходом.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendBalanceLog,
  balanceLogPath,
  deepSeekUsage,
  forecastDeepSeekSpend,
  parseDeepSeekBalance,
} from '../../server/src/lib/deepseek/balance.ts';
import { pricingSnapshotPath } from '../../server/src/lib/deepseek/pricingWatch.ts';
import { DEEPSEEK_PRICING_URL } from '../../server/src/lib/deepseek/tariff.ts';
import deepseek from '../../server/src/lib/executors/deepseek.ts';
import { normalizeProviderUsage } from '../../server/src/lib/providerUsage.ts';

const KEY = 'synthetic-deepseek-balance-key';
const HOUR = 3_600_000;
const PRICING_FIXTURE = new URL('../fixtures/deepseek-pricing-2026-09-21.html', import.meta.url);

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Заглушка вендора целиком: баланс по API и публичная страница цен по её адресу.
function vendorFetch(balanceResponse, { requests = [] } = {}) {
  return async (url, init = {}) => {
    requests.push({ url, auth: init.headers?.Authorization ?? null });
    if (url === DEEPSEEK_PRICING_URL) {
      return new Response(await fs.readFile(PRICING_FIXTURE, 'utf8'), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    return balanceResponse();
  };
}

function vendorBalance(total, { currency = 'USD', available = true } = {}) {
  return {
    is_available: available,
    balance_infos: [{
      currency,
      total_balance: total,
      granted_balance: '0.00',
      topped_up_balance: total,
    }],
  };
}

async function runtimeHome(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-deepseek-usage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, 'runtime');
}

test('ответ вендора разбирается в числа по валютам без выдуманных нулей', () => {
  assert.equal(parseDeepSeekBalance(null), null);
  assert.equal(parseDeepSeekBalance({ is_available: true }), null);
  const parsed = parseDeepSeekBalance({
    is_available: true,
    balance_infos: [
      { currency: 'usd', total_balance: '1.96', granted_balance: '0.00', topped_up_balance: '1.96' },
      { currency: 'CNY', total_balance: '12.50', granted_balance: '2.50', topped_up_balance: '10.00' },
    ],
  });
  assert.deepEqual(parsed, {
    available: true,
    balances: [
      { currency: 'USD', total: 1.96, granted: 0, toppedUp: 1.96 },
      { currency: 'CNY', total: 12.5, granted: 2.5, toppedUp: 10 },
    ],
  });
});

test('без ключа службы usage честно просит ключ, а не идёт к вендору', async (t) => {
  let called = false;
  const usage = normalizeProviderUsage(await deepSeekUsage({
    config: { deepseekRuntimeHome: await runtimeHome(t) },
    env: {},
    fetchImpl: async () => { called = true; return jsonResponse(200, vendorBalance('1.00')); },
  }), { providerName: 'DeepSeek' });
  assert.equal(called, false);
  assert.equal(usage.state, 'auth_required');
  assert.match(usage.message, /DEEPSEEK_API_KEY/u);
});

test('отказы API переводятся в состояния общего контракта, ключ не утекает в текст', async (t) => {
  const home = await runtimeHome(t);
  const cases = [
    [() => jsonResponse(401, { error: 'bad key' }), 'auth_required'],
    [() => jsonResponse(429, {}), 'rate_limited'],
    [() => jsonResponse(500, {}), 'unavailable'],
    [() => { throw Object.assign(new TypeError(`fetch failed ${KEY}`), { cause: { code: 'ETIMEDOUT' } }); }, 'unavailable'],
  ];
  for (const [respond, state] of cases) {
    const usage = normalizeProviderUsage(await deepSeekUsage({
      config: { deepseekRuntimeHome: home },
      env: { DEEPSEEK_API_KEY: KEY },
      fetchImpl: async () => respond(),
    }), { providerName: 'DeepSeek' });
    assert.equal(usage.state, state);
    assert.equal(usage.resources.length, 0);
    assert.equal(usage.message.includes(KEY), false);
  }
  const network = normalizeProviderUsage(await deepSeekUsage({
    config: { deepseekRuntimeHome: home },
    env: { DEEPSEEK_API_KEY: KEY },
    fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); },
  }), { providerName: 'DeepSeek' });
  assert.equal(network.message, 'API DeepSeek не ответил (ECONNRESET).');
});

test('первый снимок даёт баланс со ссылкой на пополнение и прогноз без темпа', async (t) => {
  const home = await runtimeHome(t);
  const requests = [];
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const raw = await deepSeekUsage({
    config: { deepseekRuntimeHome: home },
    env: { DEEPSEEK_API_KEY: KEY },
    now: () => now,
    timeZone: 'Asia/Novosibirsk',
    fetchImpl: vendorFetch(() => jsonResponse(200, vendorBalance('1.96')), { requests }),
  });
  const usage = normalizeProviderUsage(raw, { providerName: 'DeepSeek' });

  // Страница цен публичная — ключ службы уходит только на API счёта.
  assert.deepEqual(requests, [
    { url: 'https://api.deepseek.com/user/balance', auth: `Bearer ${KEY}` },
    { url: DEEPSEEK_PRICING_URL, auth: null },
  ]);
  assert.equal(usage.state, 'ok');
  assert.deepEqual(usage.bars, []);
  assert.deepEqual(
    usage.resources.map((resource) => resource.key),
    ['balance-usd', 'tariff', 'forecast'],
  );

  const [balance, tariff, forecast] = usage.resources;
  assert.equal(balance.label, 'Баланс USD');
  assert.match(balance.summary, /1,96/u);
  assert.equal(balance.tone, 'ok');
  assert.equal(Object.hasOwn(balance, 'percent'), false);
  assert.deepEqual(balance.controls.map((control) => [control.kind, control.href]), [
    ['link', 'https://platform.deepseek.com/top_up'],
  ]);
  assert.equal(tariff.label, 'Тариф');
  assert.equal(tariff.tone, 'ok');
  assert.equal(tariff.summary, 'скидка 50 % до завтра 08:00');
  assert.match(tariff.note, / · сверено с сайтом сегодня 19:00$/u);
  assert.equal(forecast.tone, 'muted');
  assert.match(forecast.summary, /после двух часов/u);
  assert.equal(JSON.stringify(raw).includes(KEY), false);

  const log = JSON.parse(await fs.readFile(balanceLogPath(home), 'utf8'));
  assert.deepEqual(log.samples, [{ at: now, currency: 'USD', total: 1.96 }]);
  assert.equal((await fs.stat(balanceLogPath(home))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(home)).mode & 0o777, 0o700);

  // Следующий тик через пять минут: баланс перечитан, страница цен взята из снимка.
  await deepSeekUsage({
    config: { deepseekRuntimeHome: home },
    env: { DEEPSEEK_API_KEY: KEY },
    now: () => now + 5 * 60_000,
    timeZone: 'Asia/Novosibirsk',
    fetchImpl: vendorFetch(() => jsonResponse(200, vendorBalance('1.95')), { requests }),
  });
  assert.deepEqual(
    requests.slice(2).map((request) => request.url),
    ['https://api.deepseek.com/user/balance'],
  );
  assert.equal(JSON.parse(await fs.readFile(pricingSnapshotPath(home), 'utf8')).checkedAt, now);
});

test('темп считается по убыли за сутки, пополнение и шум округления расходом не считаются', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const samples = [
    { at: now - 30 * HOUR, currency: 'USD', total: 9 }, // вне суточного окна
    { at: now - 12 * HOUR, currency: 'USD', total: 5 },
    { at: now - 8 * HOUR, currency: 'USD', total: 4.5 },
    { at: now - 6 * HOUR, currency: 'USD', total: 10 }, // пополнение
    { at: now - 2 * HOUR, currency: 'CNY', total: 1 }, // чужая валюта
    { at: now, currency: 'USD', total: 9.5 },
  ];
  const forecast = forecastDeepSeekSpend(samples, 'USD', now);
  assert.equal(forecast.kind, 'rate');
  assert.equal(forecast.hoursObserved, 12);
  // Убыль: 5 → 4.5 и 10 → 9.5 = 1.0 за 12 ч → 2.0 в сутки → 9.5 хватит на 4.75 дня.
  assert.equal(Math.round(forecast.spentPerDay * 100) / 100, 2);
  assert.equal(Math.round(forecast.daysLeft * 100) / 100, 4.75);

  const stalled = forecastDeepSeekSpend([
    { at: now - 5 * HOUR, currency: 'USD', total: 3.001 },
    { at: now, currency: 'USD', total: 3 },
  ], 'USD', now);
  assert.deepEqual(stalled, { kind: 'stalled', hoursObserved: 5 });

  const short = forecastDeepSeekSpend([
    { at: now - HOUR, currency: 'USD', total: 3 },
    { at: now, currency: 'USD', total: 2 },
  ], 'USD', now);
  assert.deepEqual(short, { kind: 'insufficient', hoursObserved: 1 });
});

test('журнал снимков переживает тики, обрезается по сроку и питает прогноз во всплывашке', async (t) => {
  const home = await runtimeHome(t);
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  await appendBalanceLog(home, [
    { at: now - 8 * 24 * HOUR, currency: 'USD', total: 50 }, // старше недели — уйдёт
    { at: now - 10 * HOUR, currency: 'USD', total: 4 },
    { at: now - 5 * HOUR, currency: 'USD', total: 3.5 },
  ], now - 5 * HOUR);

  const usage = normalizeProviderUsage(await deepSeekUsage({
    config: { deepseekRuntimeHome: home },
    env: { DEEPSEEK_API_KEY: KEY },
    now: () => now,
    timeZone: 'Asia/Novosibirsk',
    fetchImpl: vendorFetch(() => jsonResponse(200, vendorBalance('3.00'))),
  }), { providerName: 'DeepSeek' });

  const forecast = usage.resources.find((resource) => resource.key === 'forecast');
  // Убыль 4 → 3.5 → 3 = 1.0 за 10 ч → 2.4 в сутки → 3.00 хватит на 1.25 дня.
  assert.equal(forecast.summary, 'хватит на ~1 дн.');
  assert.equal(forecast.tone, 'bad');
  assert.match(forecast.note, /за сутки −2,40/u);
  assert.match(forecast.note, /наблюдений 10 ч/u);

  const log = JSON.parse(await fs.readFile(balanceLogPath(home), 'utf8'));
  assert.deepEqual(log.samples.map((sample) => sample.total), [4, 3.5, 3]);
});

test('пустой или заблокированный счёт подсвечивается как беда, а не как норма', async (t) => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const usage = normalizeProviderUsage(await deepSeekUsage({
    config: { deepseekRuntimeHome: await runtimeHome(t) },
    env: { DEEPSEEK_API_KEY: KEY },
    now: () => now,
    timeZone: 'Asia/Novosibirsk',
    fetchImpl: vendorFetch(() => jsonResponse(200, vendorBalance('0.00', { available: false }))),
  }), { providerName: 'DeepSeek' });
  const balance = usage.resources.find((resource) => resource.key === 'balance-usd');
  assert.equal(balance.tone, 'bad');
  assert.match(balance.note, /недостаточным/u);
});

test('адаптер объявляет usage и страницу состояния вендора', () => {
  assert.equal(typeof deepseek.usage, 'function');
  assert.equal(deepseek.statusPage, 'https://status.deepseek.com');
});
