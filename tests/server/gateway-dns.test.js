// Публичная DNS-проверка шлюза. Сеть полностью подменена: фиксируем DoH-контракт и главное
// различие между доказанным отсутствием записи и сбоем резолвера.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dnsAnswersAbsent,
  dnsAnswersMatch,
  forcedVpnGateEnv,
  resolvePublic,
} from '../../server/src/lib/gateway/installer.js';

const DOMAIN = 'cockpit.example.com';
const IP = '203.0.113.17';
const ENDPOINTS = ['https://resolver-one.test/dns-query', 'https://resolver-two.test/resolve'];

test('GW-VPN-01: диагностика туннеля форсирует gate поверх opt-out сервера', () => {
  const source = { COCKPIT_REQUIRE_VPN: '0', KEEP: 'value' };
  assert.deepEqual(forcedVpnGateEnv(source), { COCKPIT_REQUIRE_VPN: '1', KEEP: 'value' });
  assert.equal(source.COCKPIT_REQUIRE_VPN, '0');
});

function dohResponse({ Status = 0, Answer } = {}, { status = 200 } = {}) {
  return new Response(JSON.stringify({ Status, ...(Answer === undefined ? {} : { Answer }) }), {
    status,
    headers: { 'content-type': 'application/dns-json' },
  });
}

function answer(type, data) {
  return { name: `${DOMAIN}.`, type, TTL: 60, data };
}

test('GW-DNS-01: DoH читает A у двух провайдеров и не принимает чужие типы', async () => {
  const calls = [];
  const result = await resolvePublic(DOMAIN, 'A', {
    endpoints: ENDPOINTS,
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return dohResponse({ Answer: [answer(28, '2001:db8::1'), answer(1, IP)] });
    },
  });

  assert.deepEqual(result, [IP, IP]);
  assert.equal(dnsAnswersMatch(result, IP), true);
  assert.equal(calls.length, 2);
  for (const { url, options } of calls) {
    assert.equal(url.searchParams.get('name'), DOMAIN);
    assert.equal(url.searchParams.get('type'), 'A');
    assert.equal(options.headers.accept, 'application/dns-json');
    assert.equal(options.cache, 'no-store');
  }
});

test('GW-DNS-02: NOERROR без AAAA и NXDOMAIN означают доказанное отсутствие', async () => {
  const noData = await resolvePublic(DOMAIN, 'AAAA', {
    endpoints: ENDPOINTS,
    fetchImpl: async () => dohResponse(),
  });
  assert.deepEqual(noData, []);
  assert.equal(dnsAnswersAbsent(noData), true);

  const notFound = await resolvePublic(DOMAIN, 'A', {
    endpoints: ENDPOINTS,
    fetchImpl: async () => dohResponse({ Status: 3 }),
  });
  assert.deepEqual(notFound, []);
  assert.equal(dnsAnswersMatch(notFound, IP), false);
});

test('GW-DNS-03: актуальный ответ одного DoH побеждает старый NXDOMAIN второго', async () => {
  const result = await resolvePublic(DOMAIN, 'A', {
    endpoints: ENDPOINTS,
    fetchImpl: async (url) => (new URL(url).hostname === 'resolver-one.test'
      ? dohResponse({ Status: 3 })
      : dohResponse({ Answer: [answer(1, IP)] })),
  });

  assert.deepEqual(result, [IP]);
  assert.equal(dnsAnswersMatch(result, IP), true);
});

test('GW-DNS-04: транспортный, HTTP, DNS и повреждённый ответы остаются ошибкой', async (t) => {
  const cases = [
    { name: 'transport', fetchImpl: async () => { throw new Error('offline'); } },
    { name: 'http', fetchImpl: async () => dohResponse({}, { status: 503 }) },
    { name: 'servfail', fetchImpl: async () => dohResponse({ Status: 2 }) },
    { name: 'bad envelope', fetchImpl: async () => dohResponse({ Status: '0' }) },
    { name: 'bad address', fetchImpl: async () => dohResponse({ Answer: [answer(1, 'not-an-ip')] }) },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const result = await resolvePublic(DOMAIN, 'A', {
        endpoints: [ENDPOINTS[0]],
        fetchImpl: item.fetchImpl,
      });
      assert.equal(result, null);
      assert.equal(dnsAnswersAbsent(result), false);
    });
  }
});

test('GW-DNS-05: ошибка одного из двух DoH не маскируется успехом второго', async () => {
  const result = await resolvePublic(DOMAIN, 'AAAA', {
    endpoints: ENDPOINTS,
    fetchImpl: async (url) => (new URL(url).hostname === 'resolver-one.test'
      ? dohResponse()
      : dohResponse({}, { status: 503 })),
  });

  assert.equal(result, null);
  assert.equal(dnsAnswersAbsent(result), false);
});
