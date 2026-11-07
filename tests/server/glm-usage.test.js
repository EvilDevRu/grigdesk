import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import { normalizeUsageResources } from '../../server/src/lib/providerUsage.ts';
import { glmUsage } from '../../server/src/lib/glm/usage.ts';

const API_KEY = 'synthetic-zai-api';
const CODING_KEY = 'synthetic-zai-coding';
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

/**
 * Фейк служебных адресов Z.ai: отвечает по пути, записывает метод, ключ и тело.
 * Сценарий может уронить первые запросы сетью, как сорванное TLS-рукопожатие.
 */
function fakeZai(routes, { networkFailures = 0 } = {}) {
  const calls = [];
  let failures = networkFailures;

  /**
   * fetch фейка: сначала заданное число сетевых срывов, затем ответ маршрута по пути.
   * Незнакомый путь — 404, как у изменившегося адреса кабинета.
   */
  const fetchImpl = async (url, init = {}) => {
    if (failures > 0) {
      failures -= 1;

      throw Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ECONNRESET' },
      });
    }

    const { pathname, hostname } = new URL(url);
    const headers = new Headers(init.headers);

    calls.push({
      hostname,
      pathname,
      method: init.method || 'GET',
      authorization: headers.get('authorization'),
      cookie: headers.get('cookie'),
      body: init.body ? JSON.parse(init.body) : null,
    });

    const route = routes[pathname];

    if (!route) {
      return new Response('{}', { status: 404 });
    }

    const { status = 200, json, text } = typeof route === 'function' ? await route(calls.at(-1)) : route;

    return new Response(text ?? JSON.stringify(json), {
      status,
      headers: { 'content-type': text === undefined ? 'application/json' : 'text/markdown' },
    });
  };

  return { calls, fetchImpl };
}

/**
 * Адаптер с окружением режима и фейком Z.ai; home счёта — временный каталог теста.
 * Возвращает состояние счёта и корень, чтобы тест проверил журнал снимков.
 */
async function usageOf(t, env, fake) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-usage-'));
  const adapter = createGlmAdapter({
    env: { PATH: process.env.PATH, ...env },
    admission: [],
    usageFetch: fake.fetchImpl,
    usageNow: () => NOW,
  });

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(typeof adapter.usage, 'function', 'карточка GLM отдаёт состояние счёта');

  return {
    root,
    usage: await adapter.usage({ glmRuntimeHome: path.join(root, 'glm') }),
  };
}

const USER = { json: { code: 200, data: { customerNumber: 'C-1', email: 'x@example.test' } } };

/**
 * Баланс отвечает только на номер клиента из zaiUserInfo — как настоящий адрес страницы оплаты.
 */
function balanceRoute(accountList, totalBalance) {
  return (call) => (call.body?.customerId === 'C-1'
    ? {
      json: {
        code: 200,
        data: {
          totalBalance,
          accountList,
          isKa: false,
        },
      },
    }
    : { json: { code: 500, msg: 'The current user can only view their own data！' } });
}

test('api: баланс счёта Z.ai по ключу — наличные, бонус, ссылка на пополнение и прогноз', async (t) => {
  const fake = fakeZai({
    '/api/biz/customerService/zaiUserInfo': USER,
    '/api/platform-charge-zai/business/accountBalance': balanceRoute([
      { type: 10, balance: 2.47 },
      { type: 11, balance: 0.5 },
    ], 2.97),
  });
  const { root, usage } = await usageOf(t, { GRIGDESK_GLM_API_MODE: 'api', ZAI_API_KEY: API_KEY }, fake);
  const balance = usage.resources.find((item) => item.key === 'balance-usd');

  assert.equal(usage.state, 'ok');
  assert.deepEqual(usage.bars, []);
  assert.deepEqual(balance.balance, { amount: 2.97, currency: 'USD' });
  assert.equal(balance.kind, 'balance');
  assert.match(balance.summary, /2,97/u);
  assert.match(balance.note, /наличные .*2,47.*бонус .*0,50/u);
  assert.equal(balance.tone, 'ok');
  assert.deepEqual(balance.controls, [{
    id: 'top-up',
    kind: 'link',
    label: 'Пополнить счёт',
    href: 'https://z.ai/manage-apikey/billing',
  }]);
  assert.ok(usage.resources.some((item) => item.key === 'forecast'));
  // Ключ уходит как есть, без Bearer: так его принимает страница оплаты.
  assert.ok(fake.calls.every((call) => call.authorization === API_KEY));
  assert.equal(JSON.stringify(usage).includes('C-1'), false, 'номер клиента наружу не выходит');
  assert.equal(JSON.stringify(usage).includes('example.test'), false, 'почта наружу не выходит');

  const log = await fs.stat(path.join(root, 'glm', 'balance-log.json'));

  assert.equal(log.mode & 0o777, 0o600);
});

test('api: нулевой баланс подсвечен как исчерпанный', async (t) => {
  const fake = fakeZai({
    '/api/biz/customerService/zaiUserInfo': USER,
    '/api/platform-charge-zai/business/accountBalance': balanceRoute([{ type: 10, balance: 0 }], 0),
  });
  const { usage } = await usageOf(t, { GRIGDESK_GLM_API_MODE: 'api', ZAI_API_KEY: API_KEY }, fake);

  assert.equal(usage.resources.find((item) => item.key === 'balance-usd').tone, 'bad');
});

test('api: обрыв сети повторяется, отказ ключа — auth_required, чужой ответ — unavailable', async (t) => {
  const routes = {
    '/api/biz/customerService/zaiUserInfo': USER,
    '/api/platform-charge-zai/business/accountBalance': balanceRoute([{ type: 10, balance: 1 }], 1),
  };
  const env = { GRIGDESK_GLM_API_MODE: 'api', ZAI_API_KEY: API_KEY };
  const retried = await usageOf(t, env, fakeZai(routes, { networkFailures: 2 }));
  const offline = await usageOf(t, env, fakeZai(routes, { networkFailures: 50 }));
  const rejected = await usageOf(t, env, fakeZai({
    '/api/biz/customerService/zaiUserInfo': {
      status: 401,
      json: {
        code: 401,
        msg: 'token expired or incorrect',
      },
    },
  }));
  const changed = await usageOf(t, env, fakeZai({
    '/api/biz/customerService/zaiUserInfo': USER,
    '/api/platform-charge-zai/business/accountBalance': { json: { code: 500, msg: 'system error' } },
  }));

  assert.equal(retried.usage.state, 'ok');
  assert.equal(offline.usage.state, 'unavailable');
  assert.match(offline.usage.message, /Z\.ai не ответил/u);
  assert.equal(rejected.usage.state, 'auth_required');
  assert.equal(changed.usage.state, 'unavailable');
  assert.match(changed.usage.message, /system error/u);
});

function tokensLimit(unit, number, percentage, nextResetTime) {
  return {
    type: 'TOKENS_LIMIT',
    unit,
    number,
    percentage,
    nextResetTime,
  };
}

test('coding-plan: полоски 5 часов, недели и MCP за месяц со временем сброса', async (t) => {
  const reset5h = NOW + 2 * 3_600_000;
  const resetWeek = NOW + 3 * 86_400_000;
  const fake = fakeZai({
    '/api/monitor/usage/quota/limit': {
      json: {
        code: 200,
        success: true,
        data: {
          level: 'pro',
          limits: [
            tokensLimit(3, 5, 12, reset5h),
            tokensLimit(6, 1, 40.5, resetWeek),
            {
              type: 'TIME_LIMIT',
              unit: 5,
              number: 1,
              percentage: 3,
              usage: 1000,
              currentValue: 30,
            },
          ],
        },
      },
    },
  });
  const { usage } = await usageOf(t, {
    GRIGDESK_GLM_API_MODE: 'coding-plan',
    ZAI_API_KEY: API_KEY,
    ZAI_CODING_API_KEY: CODING_KEY,
  }, fake);

  assert.equal(usage.state, 'ok');
  assert.deepEqual(usage.bars.map(({ key, label, pct, resetsAt, windowMinutes }) => ({
    key,
    label,
    pct,
    resetsAt,
    windowMinutes,
  })), [
    {
      key: 'zai:5h',
      label: '5 часов',
      pct: 12,
      resetsAt: new Date(reset5h).toISOString(),
      windowMinutes: 300,
    },
    {
      key: 'zai:week',
      label: 'Неделя',
      pct: 40.5,
      resetsAt: new Date(resetWeek).toISOString(),
      windowMinutes: 10_080,
    },
    {
      key: 'zai:mcp',
      label: 'MCP за месяц',
      pct: 3,
      resetsAt: null,
      windowMinutes: null,
    },
  ]);
  assert.match(usage.resources.find((item) => item.key === 'plan').summary, /pro/u);

  const apiCalls = fake.calls.filter((call) => call.hostname === 'api.z.ai');

  assert.ok(apiCalls.length > 0);
  assert.ok(apiCalls.every((call) => call.authorization === CODING_KEY), 'только ключ Coding Plan');
});

test('без режима или ключа — auth_required и ни одного запроса', async (t) => {
  const fake = fakeZai({});
  const none = await usageOf(t, { ZAI_API_KEY: API_KEY }, fake);
  const keyless = await usageOf(t, { GRIGDESK_GLM_API_MODE: 'coding-plan', ZAI_API_KEY: API_KEY }, fake);

  assert.equal(none.usage.state, 'auth_required');
  assert.equal(keyless.usage.state, 'auth_required');
  assert.match(keyless.usage.message, /ZAI_CODING_API_KEY/u);
  assert.equal(fake.calls.length, 0);
});


test('coding-plan: отсутствие percentage не означает свободные окна или MCP', async (t) => {
  for (const percentage of [undefined, null, '', true, -5, 'NaN', 'Infinity', 0, '42']) {
    const fake = fakeZai({
      '/api/monitor/usage/quota/limit': {
        json: {
          code: 200,
          data: {
            limits: [
              tokensLimit(3, 5, percentage, NOW),
              { type: 'TIME_LIMIT', percentage },
            ],
          },
        },
      },
    });
    const { usage } = await usageOf(t, {
      GRIGDESK_GLM_API_MODE: 'coding-plan',
      ZAI_CODING_API_KEY: CODING_KEY,
    }, fake);
    const valid = percentage === 0 || percentage === '42';

    for (const key of ['zai:5h', 'zai:mcp']) {
      assert.equal(usage.bars.some((bar) => bar.key === key), valid, `${key}: ${percentage}`);

      if (valid) {
        assert.equal(usage.bars.find((bar) => bar.key === key).pct, Number(percentage));
      }
    }
  }
});

test('api: тариф и обращения к документации отсутствуют', async (t) => {
  const fake = fakeZai({
    '/api/biz/customerService/zaiUserInfo': USER,
    '/api/platform-charge-zai/business/accountBalance': balanceRoute([{ type: 10, balance: 7 }], 7),
  });
  const { usage } = await usageOf(t, { GRIGDESK_GLM_API_MODE: 'api', ZAI_API_KEY: API_KEY }, fake);

  assert.equal(usage.state, 'ok');
  assert.deepEqual(usage.bars, []);
  assert.deepEqual(usage.resources.map((resource) => resource.key), ['balance-usd', 'forecast']);
  assert.deepEqual(usage.resources[0].balance, { amount: 7, currency: 'USD' });
  assert.equal(usage.resources[1].summary, 'темп появится после двух часов наблюдений');
  assert.equal(fake.calls.some((call) => call.hostname === 'docs.z.ai'), false);
});

test('coding-plan: отказ квот не запускает сторожа', async (t) => {
  const cases = [
    [401, 401, 'auth_required'],
    [403, 403, 'auth_required'],
    [429, 429, 'rate_limited'],
    [200, 500, 'unavailable'],
  ];

  for (const [status, code, state] of cases) {
    await t.test(`${status}/${code} → ${state}`, async (subtest) => {
      const fake = fakeZai({
        '/api/monitor/usage/quota/limit': { status, json: { code, msg: 'synthetic refusal' } },
      });
      const { usage } = await usageOf(subtest, {
        GRIGDESK_GLM_API_MODE: 'coding-plan',
        ZAI_CODING_API_KEY: CODING_KEY,
      }, fake);

      assert.equal(usage.state, state);
      assert.deepEqual(usage.bars, []);
      assert.deepEqual(usage.resources, []);
      assert.equal(fake.calls.length, 1);
      assert.equal(fake.calls[0].hostname, 'api.z.ai');
    });
  }
});

/**
 * Публичные снимки читаются из переносимых фикстур, кабинет отдаёт прежние три квоты.
 * Новый level меняет только подпись плана: поколение цен из него не угадывается.
 */
async function codingRoutes(level = 'pro') {
  const [overview, revision] = await Promise.all([
    fs.readFile(new URL('../fixtures/zai-devpack-overview-2026-10-21.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../fixtures/zai-devpack-usage-revision-2026-10-21.md', import.meta.url), 'utf8'),
  ]);

  return {
    '/api/monitor/usage/quota/limit': {
      json: {
        code: 200,
        data: {
          level,
          limits: [
            tokensLimit(3, 5, 12, NOW + 2 * 3_600_000),
            tokensLimit(6, 1, 40.5, NOW + 3 * 86_400_000),
            { type: 'TIME_LIMIT', percentage: 3 },
          ],
        },
      },
    },
    '/devpack/overview.md': { text: overview },
    '/devpack/notice/usage-revision.md': { text: revision },
  };
}

/**
 * Общие проверки интеграции предшествуют утверждению о новом тарифе.
 * Они доказывают, что красный тест падает на отсутствии ресурса, сохранив прежние квоты.
 */
function assertCodingQuotas(usage, level = 'pro') {
  assert.equal(usage.state, 'ok');
  assert.deepEqual(usage.bars.map(({ key, pct, resetsAt, windowMinutes }) => ({
    key,
    pct,
    resetsAt,
    windowMinutes,
  })), [
    {
      key: 'zai:5h',
      pct: 12,
      resetsAt: new Date(NOW + 2 * 3_600_000).toISOString(),
      windowMinutes: 300,
    },
    {
      key: 'zai:week',
      pct: 40.5,
      resetsAt: new Date(NOW + 3 * 86_400_000).toISOString(),
      windowMinutes: 10_080,
    },
    {
      key: 'zai:mcp',
      pct: 3,
      resetsAt: null,
      windowMinutes: null,
    },
  ]);
  assert.deepEqual(usage.resources.find((resource) => resource.key === 'plan'), {
    key: 'plan',
    label: 'Coding Plan',
    summary: level,
    note: 'окна лимитов — по данным кабинета Z.ai',
    tone: 'ok',
    controls: [{
      id: 'plan',
      kind: 'link',
      label: 'Подписка',
      href: 'https://z.ai/manage-apikey/coding-plan/personal/my-plan',
    }],
  });
}

test('coding-plan: тариф приходит после plan общим ресурсом', async (t) => {
  let knownTariff;

  for (const level of ['pro', 'synthetic-unknown-generation']) {
    await t.test(level, async (subtest) => {
      const fake = fakeZai(await codingRoutes(level));
      const { root, usage } = await usageOf(subtest, {
        GRIGDESK_GLM_API_MODE: 'coding-plan',
        ZAI_CODING_API_KEY: CODING_KEY,
      }, fake);

      assertCodingQuotas(usage, level);
      assert.deepEqual(usage.resources.map((resource) => resource.key), ['plan', 'tariff']);

      const tariff = usage.resources[1];
      const normalized = normalizeUsageResources([tariff])[0];
      const publicCalls = fake.calls.filter((call) => call.hostname === 'docs.z.ai');
      const apiCalls = fake.calls.filter((call) => call.hostname === 'api.z.ai');

      assert.equal(tariff.label, 'Тариф');
      assert.equal(tariff.tone, 'ok');
      assert.match(tariff.summary, /^вне пика до /u);
      assert.doesNotMatch(tariff.summary, /×|pro|generation/u);
      assert.match(tariff.note, /(?:×\s*2|вдвое|2 раза)/u);
      assert.match(tariff.note, /(?:×\s*3|втрое|3 раза)/u);

      for (const field of ['summary', 'note', 'tone', 'controls']) {
        assert.deepEqual(normalized[field], tariff[field], `нормализация сохраняет ${field}`);
      }

      assert.deepEqual(tariff.controls.map(({ kind, label, href }) => ({
        kind,
        label,
        href,
      })), [{
        kind: 'link',
        label: 'Тарифы Z.ai',
        href: 'https://docs.z.ai/devpack/overview',
      }]);
      assert.deepEqual(publicCalls.map((call) => call.pathname).sort(), [
        '/devpack/notice/usage-revision.md',
        '/devpack/overview.md',
      ]);
      assert.equal(apiCalls.length, 1);
      assert.ok(apiCalls.every((call) => call.authorization === CODING_KEY));

      for (const call of publicCalls) {
        assert.equal(call.method, 'GET');
        assert.equal(call.authorization, null);
        assert.equal(call.cookie, null);
      }

      const snapshot = await fs.readFile(path.join(root, 'glm', 'glm-pricing-check.json'), 'utf8');

      assert.equal(snapshot.includes(CODING_KEY), false);
      assert.equal(snapshot.includes(API_KEY), false);
      assert.equal(JSON.stringify(usage).includes(CODING_KEY), false);

      if (knownTariff) {
        assert.deepEqual(tariff, knownTariff, 'неизвестный level не меняет поколение тарифа');
      }

      knownTariff = tariff;
    });
  }
});

test('coding-plan: mismatch и отказ сторожа сохраняют квоты', async (t) => {
  const env = {
    GRIGDESK_GLM_API_MODE: 'coding-plan',
    ZAI_CODING_API_KEY: CODING_KEY,
  };

  for (const scenario of ['mismatch', 'сеть', 'HTTP', 'обрыв', 'отказ записи с mismatch']) {
    await t.test(scenario, async (subtest) => {
      const routes = await codingRoutes();
      const isMismatch = scenario.includes('mismatch');

      if (isMismatch) {
        routes['/devpack/overview.md'].text = routes['/devpack/overview.md'].text
          .replace('14:00–18:00', '14:00–19:00');
      } else {
        for (const route of ['/devpack/overview.md', '/devpack/notice/usage-revision.md']) {
          routes[route] = () => {
            if (scenario === 'HTTP') {
              return { status: 503, text: 'synthetic failure' };
            }

            throw scenario === 'обрыв'
              ? new DOMException('synthetic-secret', 'AbortError')
              : Object.assign(new TypeError('synthetic-secret'), { cause: { code: 'ENOTFOUND' } });
          };
        }
      }

      const fake = fakeZai(routes);
      let usage;

      if (scenario === 'отказ записи с mismatch') {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-unwritable-home-'));
        const occupied = path.join(root, 'occupied');

        subtest.after(() => fs.rm(root, { recursive: true, force: true }));
        await fs.writeFile(occupied, 'synthetic regular file');

        usage = await glmUsage({
          env,
          runtimeHome: occupied,
          fetchImpl: fake.fetchImpl,
          now: () => NOW,
        });
      } else {
        ({ usage } = await usageOf(subtest, env, fake));
      }

      assertCodingQuotas(usage);

      const tariff = usage.resources.find((resource) => resource.key === 'tariff');

      assert.ok(tariff, 'успешные квоты несут тариф даже при отказе сторожа');
      assert.equal(tariff.tone, isMismatch ? 'bad' : 'ok');
      assert.match(tariff.summary, /^вне пика до /u);
      assert.equal(JSON.stringify(usage).includes(CODING_KEY), false);
      assert.equal(JSON.stringify(usage).includes('synthetic-secret'), false);

      if (isMismatch) {
        assert.match(tariff.note, /overview/u);
        assert.match(tariff.note, /19:00|1140/u);
      } else {
        assert.match(tariff.note, /недоступ|не свер/u);
      }
    });
  }
});
