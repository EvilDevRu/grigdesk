// Reconciliation DNS шлюза: сеть полностью подменена, чтобы зафиксировать точную область
// удаления, атомарный batch и обязательную проверку постусловия без живой зоны Cloudflare.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CloudflareError,
  buildGatewayDnsPlan,
  ensureGatewayDns,
  findZone,
  listGatewayDnsRecords,
  zoneCandidates,
} from '../../server/src/lib/gateway/cloudflare.js';
import {
  dnsAnswersAbsent,
  dnsAnswersMatch,
  GatewaySetupError,
  parseSetupInput,
} from '../../server/src/lib/gateway/installer.js';

const TOKEN = 'cloudflare-secret-token-1234';
const DOMAIN = 'cockpit.example.com';
const IP = '203.0.113.17';

function jsonResponse(result, { status = 200, resultInfo } = {}) {
  return new Response(JSON.stringify({
    success: status >= 200 && status < 300,
    result,
    errors: status >= 400 ? [{ code: 1000, message: 'provider rejected' }] : [],
    ...(resultInfo ? { result_info: resultInfo } : {}),
  }), { status, headers: { 'content-type': 'application/json' } });
}

function record(id, type, name, content, extra = {}) {
  return { id, type, name, content, ttl: 300, proxied: false, ...extra };
}

test('CF-DNS-01: зона ищется от самого специфичного имени к родительскому', () => {
  assert.deepEqual(zoneCandidates('Cockpit.Dev.Example.COM.'), [
    'cockpit.dev.example.com',
    'dev.example.com',
    'example.com',
  ]);
});

test('CF-DNS-02: план оставляет одну правильную A, удаляет дубли/AAAA/CNAME и сохраняет TXT', () => {
  const plan = buildGatewayDnsPlan({
    domain: DOMAIN,
    ip: IP,
    records: [
      record('base-ok', 'A', DOMAIN, IP, { ttl: 60 }),
      record('base-old', 'A', DOMAIN, '198.51.100.2'),
      record('base-v6', 'AAAA', DOMAIN, '2001:db8::2'),
      record('base-txt', 'TXT', DOMAIN, 'verification=keep-me'),
      record('wild-cname', 'CNAME', `*.${DOMAIN}`, 'old.example.net'),
      record('sibling', 'A', `api.${DOMAIN}`, '198.51.100.9'),
    ],
  });

  assert.deepEqual(plan.desired, [
    { name: DOMAIN, action: 'unchanged', id: 'base-ok', wasProxied: false },
    { name: `*.${DOMAIN}`, action: 'created', wasProxied: false },
  ]);
  assert.deepEqual(plan.batch.deletes.map(({ id }) => id).sort(), ['base-old', 'base-v6', 'wild-cname']);
  assert.deepEqual(plan.batch.patches, []);
  assert.deepEqual(plan.batch.posts, [{
    type: 'A', name: `*.${DOMAIN}`, content: IP, ttl: 60, proxied: false,
  }]);
  assert.deepEqual(plan.preserved.map(({ id }) => id), ['base-txt']);
  assert.ok(!plan.removed.some(({ id }) => id === 'sibling'));
});

test('CF-DNS-03: survivor выбирается детерминированно и PATCH не стирает comment/tags', () => {
  const plan = buildGatewayDnsPlan({
    domain: DOMAIN,
    ip: IP,
    records: [
      record('z-last', 'A', DOMAIN, '198.51.100.1', { comment: 'old' }),
      record('a-first', 'A', DOMAIN, '198.51.100.2', { tags: ['keep:value'] }),
      record('wild', 'A', `*.${DOMAIN}`, IP, { ttl: 60 }),
    ],
  });

  assert.deepEqual(plan.batch.patches, [{
    id: 'a-first', type: 'A', name: DOMAIN, content: IP, ttl: 60, proxied: false,
  }]);
  assert.deepEqual(plan.batch.deletes, [{ id: 'z-last' }]);
  assert.ok(!Object.hasOwn(plan.batch.patches[0], 'comment'));
  assert.ok(!Object.hasOwn(plan.batch.patches[0], 'tags'));
});

test('CF-DNS-04: делегации, HTTPS/SVCB и exact-имя стенда блокируют план до удаления', async (t) => {
  const cases = [
    { code: 'cloudflare_dns_blocked', item: record('ns', 'NS', DOMAIN, 'ns1.example.net') },
    { code: 'cloudflare_dns_blocked', item: record('https', 'HTTPS', DOMAIN, '1 . alpn=h3') },
    { code: 'cloudflare_dns_blocked', item: record('svcb', 'SVCB', `*.${DOMAIN}`, '1 svc.example.net') },
    { code: 'cloudflare_wildcard_shadowed', item: record('p-txt', 'TXT', `p5191.${DOMAIN}`, 'blocks wildcard') },
  ];
  for (const { code, item } of cases) {
    await t.test(`${item.type} ${item.name}`, () => {
      assert.throws(
        () => buildGatewayDnsPlan({ domain: DOMAIN, ip: IP, records: [item] }),
        (error) => error instanceof CloudflareError && error.code === code,
      );
    });
  }
});

test('CF-DNS-05: пагинация читается полностью, а ложные совпадения фильтруются локально', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const page = new URL(url).searchParams.get('page');
    if (page === '1') {
      return jsonResponse([
        record('base', 'A', DOMAIN, IP),
        record('foreign', 'A', `${DOMAIN}.evil.test`, '198.51.100.8'),
      ], { resultInfo: { page: 1, total_pages: 2 } });
    }
    return jsonResponse([
      record('wild', 'A', `*.${DOMAIN}`, IP),
      record('child', 'TXT', `note.${DOMAIN}`, 'keep'),
    ], { resultInfo: { page: 2, total_pages: 2 } });
  };

  const records = await listGatewayDnsRecords(TOKEN, 'zone-id', DOMAIN, { fetchImpl });
  assert.deepEqual(records.map(({ id }) => id), ['base', 'wild', 'child']);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0]).searchParams.get('name.endswith'), DOMAIN);
  assert.ok(calls.every((url) => !url.includes(TOKEN)));
});

test('CF-DNS-06: две записи меняются одним batch и затем перечитываются', async () => {
  const calls = [];
  let records = [
    record('base-old', 'A', DOMAIN, '198.51.100.4', { proxied: true, ttl: 1 }),
    record('base-dup', 'A', DOMAIN, '198.51.100.5'),
    record('wild-cname', 'CNAME', `*.${DOMAIN}`, 'old.example.net'),
    record('txt', 'TXT', DOMAIN, 'keep-this'),
  ];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    if (parsed.pathname === '/client/v4/zones') {
      if (parsed.searchParams.get('name') === DOMAIN) return jsonResponse([]);
      return jsonResponse([{ id: 'zone-1', name: 'example.com' }]);
    }
    if (parsed.pathname.endsWith('/dns_records/batch')) {
      const body = JSON.parse(options.body);
      assert.deepEqual(body, {
        deletes: [{ id: 'base-old' }, { id: 'wild-cname' }],
        patches: [{ id: 'base-dup', type: 'A', name: DOMAIN, content: IP, ttl: 60, proxied: false }],
        posts: [{ type: 'A', name: `*.${DOMAIN}`, content: IP, ttl: 60, proxied: false }],
      });
      records = [
        record('base-dup', 'A', DOMAIN, IP, { ttl: 60 }),
        record('wild-new', 'A', `*.${DOMAIN}`, IP, { ttl: 60 }),
        record('txt', 'TXT', DOMAIN, 'keep-this'),
      ];
      return jsonResponse({ deletes: [], patches: [], posts: [] });
    }
    if (parsed.pathname.endsWith('/dns_records')) {
      return jsonResponse(records, { resultInfo: { page: 1, total_pages: 1 } });
    }
    throw new Error(`unexpected ${url}`);
  };

  const result = await ensureGatewayDns({ token: TOKEN, domain: DOMAIN, ip: IP, fetchImpl });
  assert.equal(result.zone.name, 'example.com');
  assert.equal(result.removed.length, 2);
  assert.equal(calls.filter(({ url }) => url.endsWith('/dns_records/batch')).length, 1);
  assert.equal(calls.filter(({ url }) => url.includes('/dns_records?')).length, 2, 'до и после batch');
  for (const { url, options } of calls) {
    assert.ok(!url.includes(TOKEN));
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
  }
});

test('CF-DNS-07: success batch без постусловия считается отказом', async () => {
  let listCalls = 0;
  const stale = [
    record('base', 'A', DOMAIN, '198.51.100.2'),
    record('wild', 'A', `*.${DOMAIN}`, IP, { ttl: 60 }),
  ];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/client/v4/zones') {
      if (parsed.searchParams.get('name') === DOMAIN) return jsonResponse([]);
      return jsonResponse([{ id: 'zone-1', name: 'example.com' }]);
    }
    if (parsed.pathname.endsWith('/dns_records/batch')) return jsonResponse({});
    if (parsed.pathname.endsWith('/dns_records')) {
      listCalls += 1;
      return jsonResponse(stale, { resultInfo: { page: 1, total_pages: 1 } });
    }
    throw new Error(`unexpected ${url}`);
  };

  await assert.rejects(
    () => ensureGatewayDns({ token: TOKEN, domain: DOMAIN, ip: IP, fetchImpl }),
    (error) => error instanceof CloudflareError && error.code === 'cloudflare_reconcile_failed',
  );
  assert.equal(listCalls, 2);
});

test('CF-DNS-08: токен обязателен на сервере, а DNS принимает только единственный текущий IP', () => {
  assert.throws(
    () => parseSetupInput({ domain: DOMAIN, gateway: IP, useCloudflare: true }),
    (error) => error instanceof GatewaySetupError && error.code === 'cloudflare_token_required',
  );
  assert.equal(dnsAnswersMatch([IP], IP), true);
  assert.equal(dnsAnswersMatch([IP, '198.51.100.2'], IP), false);
  assert.equal(dnsAnswersMatch([], IP), false);
  assert.equal(dnsAnswersMatch(null, IP), false);
  assert.equal(dnsAnswersMatch([IP, IP], IP), true, 'дубль одного адреса не меняет множество ответа');
  assert.equal(dnsAnswersAbsent([]), true);
  assert.equal(dnsAnswersAbsent(null), false, 'сбой резолвера — не доказательство отсутствия AAAA');
  assert.equal(dnsAnswersAbsent(['2001:db8::1']), false);
  assert.throws(
    () => parseSetupInput({
      domain: DOMAIN,
      gateway: IP,
      useCloudflare: true,
      cloudflareToken: TOKEN,
    }, { requireCloudflarePlan: true }),
    (error) => error instanceof GatewaySetupError && error.code === 'cloudflare_plan_required',
  );
});

test('CF-DNS-09: транспортная ошибка не раскрывает токен', async () => {
  await assert.rejects(
    () => ensureGatewayDns({
      token: TOKEN,
      domain: DOMAIN,
      ip: IP,
      fetchImpl: async () => { throw new Error(`connect with ${TOKEN} failed`); },
    }),
    (error) => {
      assert.ok(!error.message.includes(TOKEN));
      assert.match(error.message, /…1234/);
      return true;
    },
  );
});

test('CF-DNS-10: ошибка провайдера и её поля не раскрывают токен', async () => {
  await assert.rejects(
    () => findZone(TOKEN, DOMAIN, {
      fetchImpl: async () => new Response(JSON.stringify({
        success: false,
        result: null,
        errors: [{ code: `provider-${TOKEN}`, message: `bad credential ${TOKEN}` }],
      }), { status: 400, headers: { 'content-type': 'application/json' } }),
    }),
    (error) => {
      assert.ok(!error.message.includes(TOKEN));
      assert.ok(!JSON.stringify(error.errors).includes(TOKEN));
      assert.match(error.message, /…1234/);
      return true;
    },
  );
});

test('CF-DNS-10a: отказ в правах называет отличие DNS:Edit от похожего Zone:Edit', async () => {
  await assert.rejects(
    () => findZone(TOKEN, DOMAIN, {
      fetchImpl: async () => jsonResponse(null, { status: 403 }),
    }),
    (error) => {
      assert.ok(error instanceof CloudflareError);
      assert.equal(error.code, 'cloudflare_forbidden');
      assert.match(error.message, /Zone → DNS → Edit/);
      assert.match(error.message, /Zone → Zone → Edit/);
      assert.match(error.message, /среднюю колонку/);
      return true;
    },
  );
});

test('CF-DNS-11: неожиданный ответ поиска зоны останавливает установку', async () => {
  await assert.rejects(
    () => findZone(TOKEN, DOMAIN, {
      fetchImpl: async () => jsonResponse({ id: 'not-an-array' }),
    }),
    (error) => error instanceof CloudflareError && error.code === 'cloudflare_bad_response',
  );
});

test('CF-DNS-12: план не дробится сверх атомарного лимита Free-тарифа', () => {
  const duplicates = Array.from({ length: 202 }, (_, index) => (
    record(`base-${String(index).padStart(3, '0')}`, 'A', DOMAIN, IP, { ttl: 60 })
  ));
  assert.throws(
    () => buildGatewayDnsPlan({
      domain: DOMAIN,
      ip: IP,
      records: [...duplicates, record('wild', 'A', `*.${DOMAIN}`, IP, { ttl: 60 })],
    }),
    (error) => error instanceof CloudflareError
      && error.code === 'cloudflare_batch_too_large'
      && error.limit === 200,
  );
});

test('CF-DNS-13: изменившийся после подтверждения план не доходит до batch', async () => {
  let batchCalls = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/client/v4/zones') {
      if (parsed.searchParams.get('name') === DOMAIN) return jsonResponse([]);
      return jsonResponse([{ id: 'zone-1', name: 'example.com' }]);
    }
    if (parsed.pathname.endsWith('/dns_records/batch')) {
      batchCalls += 1;
      return jsonResponse({});
    }
    if (parsed.pathname.endsWith('/dns_records')) {
      return jsonResponse([
        record('base-new-conflict', 'A', DOMAIN, '198.51.100.9'),
        record('wild', 'A', `*.${DOMAIN}`, IP, { ttl: 60 }),
      ], { resultInfo: { page: 1, total_pages: 1 } });
    }
    throw new Error(`unexpected ${url}`);
  };

  await assert.rejects(
    () => ensureGatewayDns({
      token: TOKEN,
      domain: DOMAIN,
      ip: IP,
      expectedFingerprint: '0'.repeat(64),
      fetchImpl,
    }),
    (error) => error instanceof CloudflareError && error.code === 'cloudflare_plan_changed',
  );
  assert.equal(batchCalls, 0);
});
