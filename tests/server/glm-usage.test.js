import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';

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

    const pathname = new URL(url).pathname;

    calls.push({
      pathname,
      method: init.method || 'GET',
      authorization: init.headers?.authorization ?? init.headers?.Authorization,
      body: init.body ? JSON.parse(init.body) : null,
    });

    const route = routes[pathname];

    if (!route) {
      return new Response('{}', { status: 404 });
    }

    const { status = 200, json } = typeof route === 'function' ? route(calls.at(-1)) : route;

    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
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
  const { root, usage } = await usageOf(t, { COCKPIT_GLM_API_MODE: 'api', ZAI_API_KEY: API_KEY }, fake);
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
  const { usage } = await usageOf(t, { COCKPIT_GLM_API_MODE: 'api', ZAI_API_KEY: API_KEY }, fake);

  assert.equal(usage.resources.find((item) => item.key === 'balance-usd').tone, 'bad');
});

test('api: обрыв сети повторяется, отказ ключа — auth_required, чужой ответ — unavailable', async (t) => {
  const routes = {
    '/api/biz/customerService/zaiUserInfo': USER,
    '/api/platform-charge-zai/business/accountBalance': balanceRoute([{ type: 10, balance: 1 }], 1),
  };
  const env = { COCKPIT_GLM_API_MODE: 'api', ZAI_API_KEY: API_KEY };
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
    COCKPIT_GLM_API_MODE: 'coding-plan',
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
  assert.ok(fake.calls.every((call) => call.authorization === CODING_KEY), 'только ключ Coding Plan');
});

test('без режима или ключа — auth_required и ни одного запроса', async (t) => {
  const fake = fakeZai({});
  const none = await usageOf(t, { ZAI_API_KEY: API_KEY }, fake);
  const keyless = await usageOf(t, { COCKPIT_GLM_API_MODE: 'coding-plan', ZAI_API_KEY: API_KEY }, fake);

  assert.equal(none.usage.state, 'auth_required');
  assert.equal(keyless.usage.state, 'auth_required');
  assert.match(keyless.usage.message, /ZAI_CODING_API_KEY/u);
  assert.equal(fake.calls.length, 0);
});
