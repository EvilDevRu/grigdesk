// Сторож страницы цен DeepSeek: часы пика и скидка зашиты константами, API тарифов нет, и
// единственный способ узнать о смене — перечитать публичную страницу и сверить её с
// константами. Проверяется разбор реального снимка, каждая ветка расхождения, суточная
// кадансность с приватным снимком и то, что ключ службы на чужой хост не уходит.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PRICING_CHECK_INTERVAL_MS,
  PRICING_RETRY_MS,
  compareDeepSeekPricing,
  deepSeekPricingStatus,
  fetchDeepSeekPricingPage,
  parseDeepSeekPricingPage,
  pricingSnapshotPath,
  watchDeepSeekPricing,
} from '../../server/src/lib/deepseek/pricingWatch.ts';
import { DEEPSEEK_PRICING_URL } from '../../server/src/lib/deepseek/tariff.ts';

const FIXTURE = new URL('../fixtures/deepseek-pricing-2026-09-21.html', import.meta.url);
const HOUR = 3_600_000;

async function pricingHtml() {
  return fs.readFile(FIXTURE, 'utf8');
}

function htmlResponse(status, body) {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } });
}

async function runtimeHome(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-deepseek-pricing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, 'runtime');
}

test('снимок страницы разбирается в окна, условие, долю скидки и пары цен', async () => {
  const page = parseDeepSeekPricingPage(await pricingHtml());

  assert.equal(
    page.peakSentence,
    'Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, '
      + 'excluding Chinese public holidays.',
  );
  assert.deepEqual(page.peakWindows, [{ start: 60, end: 240 }, { start: 360, end: 600 }]);
  assert.equal(page.peakQualifier, 'Monday through Friday, excluding Chinese public holidays');
  assert.equal(page.offPeakSentence, 'half of the peak rates');
  assert.equal(page.offPeakRatio, 0.5);
  assert.deepEqual(page.pricePairs, [
    { offPeak: 0.003, peak: 0.006 },
    { offPeak: 0.022, peak: 0.044 },
    { offPeak: 0.15, peak: 0.3 },
    { offPeak: 0.66, peak: 1.32 },
    { offPeak: 0.6, peak: 1.2 },
    { offPeak: 1.98, peak: 3.96 },
  ]);
  assert.deepEqual(compareDeepSeekPricing(page), { kind: 'verified' });
});

test('каждое расхождение с константами называется отдельной строкой для человека', async () => {
  const html = await pricingHtml();
  const changed = html
    .replace('06:00 - 10:00', '06:00 - 11:00')
    .replace('are half of', 'are 75% of')
    .replace('$0.3</td>', '$0.45</td>')
    .replace(', excluding Chinese public holidays', '');

  assert.deepEqual(compareDeepSeekPricing(parseDeepSeekPricingPage(changed)), {
    kind: 'mismatch',
    details: [
      'пик на сайте 01:00–04:00 и 06:00–11:00 UTC',
      'условие пика на сайте: «Monday through Friday»',
      'скидка на сайте: «Off-peak rates are 75% of the peak rates»',
      'в таблице цен пары не ×2: $0.15/$0.45',
    ],
  });

  // Формулировка без узнаваемых часов и пропавшая фраза о скидке — тоже расхождения,
  // а не «не разобрано»: сама фраза о пике на месте, значит, страница та же.
  const reworded = html
    .replace('01:00 - 04:00 and 06:00 - 10:00 UTC', 'working hours UTC')
    .replace('Off-peak rates are half of the peak rates. ', '');
  const observation = compareDeepSeekPricing(parseDeepSeekPricingPage(reworded));
  assert.equal(observation.kind, 'mismatch');
  assert.deepEqual(observation.details, [
    'пик на сайте описан иначе: «Peak hours are working hours UTC, Monday through Friday, '
      + 'excluding Chinese public holidays.»',
    'фраза о размере скидки на сайте не найдена',
  ]);

  // Переставленные окна и проценты «off» — то же самое расписание, тревоги нет.
  const equivalent = html
    .replace('01:00 - 04:00 and 06:00 - 10:00', '06:00–10:00 and 01:00–04:00')
    .replace('are half of', 'are 50% off');
  assert.deepEqual(compareDeepSeekPricing(parseDeepSeekPricingPage(equivalent)), { kind: 'verified' });
});

test('страница без фразы о пиковых часах — «не разобрано», а не выдуманные часы', () => {
  const page = parseDeepSeekPricingPage('<html><body><h1>Pricing</h1><p>See the console.</p></body></html>');

  assert.equal(page.peakSentence, null);
  assert.deepEqual(page.peakWindows, []);
  assert.deepEqual(compareDeepSeekPricing(page), { kind: 'unparsed' });
});

test('страница запрашивается без ключа службы, отказы описываются кодом причины', async () => {
  const requests = [];
  const html = await pricingHtml();
  const fetched = await fetchDeepSeekPricingPage({
    fetchImpl: async (url, init) => {
      requests.push({ url, headers: init.headers });
      return htmlResponse(200, html);
    },
  });

  assert.equal(fetched.ok, true);
  assert.deepEqual(requests, [{ url: DEEPSEEK_PRICING_URL, headers: { Accept: 'text/html' } }]);

  const denied = await fetchDeepSeekPricingPage({ fetchImpl: async () => htmlResponse(503, 'busy') });
  assert.deepEqual(denied, { ok: false, failure: 'HTTP 503' });

  const offline = await fetchDeepSeekPricingPage({
    fetchImpl: async () => {
      throw Object.assign(new TypeError('fetch failed https://secret'), { cause: { code: 'ENOTFOUND' } });
    },
  });
  assert.deepEqual(offline, { ok: false, failure: 'ENOTFOUND' });
});

test('сверка идёт раз в сутки через приватный снимок, а не на каждом тике', async (t) => {
  const home = await runtimeHome(t);
  const html = await pricingHtml();
  const start = Date.UTC(2026, 8, 21, 7, 0, 0);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return htmlResponse(200, html);
  };

  const first = await watchDeepSeekPricing({ runtimeHome: home, fetchImpl, now: start });
  assert.equal(calls, 1);
  assert.equal(first.checkedAt, start);
  assert.equal(first.fetchedAt, start);
  assert.equal(first.failure, null);
  assert.deepEqual(deepSeekPricingStatus(first), { kind: 'verified', at: start });

  const file = pricingSnapshotPath(home);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(home)).mode & 0o777, 0o700);

  // Тик через пять минут и через 23 часа читает снимок с диска; на сайт не ходит.
  for (const later of [start + 5 * 60_000, start + 23 * HOUR]) {
    const cached = await watchDeepSeekPricing({ runtimeHome: home, fetchImpl, now: later });
    assert.equal(calls, 1);
    assert.deepEqual(cached, first);
  }

  const daily = await watchDeepSeekPricing({
    runtimeHome: home,
    fetchImpl,
    now: start + PRICING_CHECK_INTERVAL_MS,
  });
  assert.equal(calls, 2);
  assert.equal(daily.fetchedAt, start + PRICING_CHECK_INTERVAL_MS);

  // Часы отмотали назад (снимок «из будущего») — недоверие снимку, новая сверка.
  await watchDeepSeekPricing({ runtimeHome: home, fetchImpl, now: start - HOUR });
  assert.equal(calls, 3);
});

test('отказ сети не стирает прошлую страницу и повторяется через час, а не через сутки', async (t) => {
  const home = await runtimeHome(t);
  const html = await pricingHtml();
  const start = Date.UTC(2026, 8, 21, 7, 0, 0);

  const first = await watchDeepSeekPricing({
    runtimeHome: home,
    now: start,
    fetchImpl: async () => htmlResponse(200, html),
  });
  assert.equal(deepSeekPricingStatus(first).kind, 'verified');

  const failing = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } });
  };
  const failed = await watchDeepSeekPricing({
    runtimeHome: home,
    now: start + PRICING_CHECK_INTERVAL_MS,
    fetchImpl: failing,
  });
  assert.equal(failed.failure, 'ETIMEDOUT');
  assert.equal(failed.fetchedAt, start);
  assert.deepEqual(failed.page, first.page);
  // Судим по прошлой странице, но её возраст — прежний.
  assert.deepEqual(deepSeekPricingStatus(failed), { kind: 'verified', at: start });

  let calls = 0;
  const counting = async () => {
    calls += 1;
    return htmlResponse(200, html);
  };
  await watchDeepSeekPricing({
    runtimeHome: home,
    now: start + PRICING_CHECK_INTERVAL_MS + PRICING_RETRY_MS - 60_000,
    fetchImpl: counting,
  });
  assert.equal(calls, 0);

  const recovered = await watchDeepSeekPricing({
    runtimeHome: home,
    now: start + PRICING_CHECK_INTERVAL_MS + PRICING_RETRY_MS,
    fetchImpl: counting,
  });
  assert.equal(calls, 1);
  assert.equal(recovered.failure, null);
  assert.equal(recovered.fetchedAt, start + PRICING_CHECK_INTERVAL_MS + PRICING_RETRY_MS);
});

test('без единой загруженной страницы статус — «недоступен», а битый снимок игнорируется', async (t) => {
  const home = await runtimeHome(t);
  const start = Date.UTC(2026, 8, 21, 7, 0, 0);

  const failed = await watchDeepSeekPricing({
    runtimeHome: home,
    now: start,
    fetchImpl: async () => htmlResponse(502, ''),
  });
  assert.deepEqual(deepSeekPricingStatus(failed), { kind: 'unreachable', reason: 'HTTP 502' });
  assert.equal(deepSeekPricingStatus(null), null);

  await fs.writeFile(pricingSnapshotPath(home), '{"checkedAt":"вчера","page":42}');
  let calls = 0;
  const html = await pricingHtml();
  const rebuilt = await watchDeepSeekPricing({
    runtimeHome: home,
    now: start + 60_000,
    fetchImpl: async () => {
      calls += 1;
      return htmlResponse(200, html);
    },
  });
  assert.equal(calls, 1);
  assert.equal(deepSeekPricingStatus(rebuilt).kind, 'verified');
});

test('снимок с расхождением судится заново: правка констант снимает тревогу без новой сверки', async (t) => {
  const home = await runtimeHome(t);
  const start = Date.UTC(2026, 8, 21, 7, 0, 0);
  const html = (await pricingHtml()).replace('06:00 - 10:00', '06:00 - 11:00');

  const snapshot = await watchDeepSeekPricing({
    runtimeHome: home,
    now: start,
    fetchImpl: async () => htmlResponse(200, html),
  });
  const status = deepSeekPricingStatus(snapshot);
  assert.equal(status.kind, 'mismatch');
  assert.deepEqual(status.details, ['пик на сайте 01:00–04:00 и 06:00–11:00 UTC']);

  // Снимок хранит факты страницы, а не вывод: вывод строится при чтении против констант.
  const stored = JSON.parse(await fs.readFile(pricingSnapshotPath(home), 'utf8'));
  assert.equal(Object.hasOwn(stored, 'observation'), false);
  assert.deepEqual(stored.page.peakWindows, [{ start: 60, end: 240 }, { start: 360, end: 660 }]);
});
