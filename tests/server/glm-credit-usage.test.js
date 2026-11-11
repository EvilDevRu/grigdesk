import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGlmAdapter } from '../../server/src/lib/executors/glm.ts';
import providersModule from '../../server/src/modules/providers/index.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');
const NOW = Date.UTC(2026, 9, 28, 12);
const CODING_KEY = 'synthetic-credit-plan-key';

/**
 * Форма ответа кабинета V3 воспроизводит кредитные окна с разными сроками сброса.
 * Счётчики округлены самим сервисом: percentage нельзя заменять отношением абсолютов.
 */
function creditLimits() {
  return [
    {
      type: 'CREDIT_LIMIT',
      unit: 3,
      number: 5,
      usage: 12000,
      currentValue: 25,
      remaining: 11974,
      percentage: 1,
      nextResetTime: NOW + 2 * 3_600_000,
    },
    {
      type: 'CREDIT_LIMIT',
      unit: 6,
      number: 1,
      usage: 60000,
      currentValue: 25,
      remaining: 59974,
      percentage: 1,
      nextResetTime: NOW + 6 * 86_400_000,
    },
  ];
}

/**
 * Настоящий GLM-адаптер получает только подменённый транспорт служебного кабинета.
 * Любой вызов модели запрещён, публичный сторож отделён от авторизованного чтения квот.
 */
async function fixture(t, limits = creditLimits()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-credit-usage-'));
  const calls = [];
  const adapter = createGlmAdapter({
    env: {
      GRIGDESK_GLM_API_MODE: 'coding-plan',
      ZAI_API_KEY: 'synthetic-other-api-key',
      ZAI_CODING_API_KEY: CODING_KEY,
    },
    admission: [],
    usageNow: () => NOW,
    usageFetch: async (url, init = {}) => {
      const { hostname, pathname } = new URL(url);
      const authorization = new Headers(init.headers).get('authorization');

      calls.push({
        hostname,
        pathname,
        authorization,
      });

      if (hostname === 'docs.z.ai') {
        assert.equal(authorization, null);

        return new Response('', { status: 503 });
      }

      assert.equal(hostname, 'api.z.ai');
      assert.equal(pathname, '/api/monitor/usage/quota/limit');
      assert.equal(authorization, CODING_KEY);

      return Response.json({
        code: 200,
        success: true,
        data: {
          level: 'pro',
          limits,
          unknownExtraUsage: { token: 'synthetic-private-account-value' },
        },
      });
    },
  });

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  return {
    root,
    calls,
    adapter,
    config: { glmRuntimeHome: path.join(root, 'glm') },
  };
}

test('Coding Plan V3: кредитные окна сохраняют процент сервиса, сроки и отсутствие доплаты', async (t) => {
  const { adapter, config, calls } = await fixture(t);
  const usage = await adapter.usage(config);

  assert.equal(usage.state, 'ok');
  assert.deepEqual(usage.bars, [
    {
      key: 'zai:5h',
      label: '5 часов',
      windowMinutes: 300,
      group: 'zai',
      pct: 1,
      resetsAt: new Date(NOW + 2 * 3_600_000).toISOString(),
    },
    {
      key: 'zai:week',
      label: 'Неделя',
      windowMinutes: 10_080,
      group: 'zai',
      pct: 1,
      resetsAt: new Date(NOW + 6 * 86_400_000).toISOString(),
    },
  ]);
  assert.deepEqual(usage.resources.map((resource) => resource.key), ['plan', 'tariff']);
  assert.equal(usage.resources[0].summary, 'pro');
  assert.equal(calls.filter((call) => call.hostname === 'api.z.ai').length, 1);
  assert.doesNotMatch(JSON.stringify(usage), /synthetic-private|synthetic-credit|synthetic-other/u);
});

test('кредитные окна проходят HTTP usage вместе с прежними токенными и MCP', async (t) => {
  const limits = creditLimits();

  limits[0].type = 'TOKENS_LIMIT';
  limits[0].percentage = 0;
  limits[1].percentage = 100;
  limits.push({ type: 'TIME_LIMIT', percentage: 3 });

  const { root, adapter, config } = await fixture(t, limits);
  // Проверяется перенос квот через HTTP, поэтому наличие ELF задаётся явно.
  // Настоящий probe зависит от runtime машины и не относится к этому сценарию.
  const installedAdapter = {
    ...adapter,
    probe: async () => ({ ok: true }),
  };
  const app = Fastify({ logger: false });

  t.after(() => app.close());
  await app.register(providersModule, {
    prefs: { read: () => ({ providerUsageAutoRefresh: true }) },
    config: {
      ...config,
      modelsPath: path.join(root, 'models.json'),
      providerUsageSeenPath: path.join(root, 'usage-seen.json'),
      envPath: path.join(root, 'fixture.env'),
    },
    env: {},
    claudeAuth: null,
    getProviderAdapters: async () => new Map([['glm', installedAdapter]]),
    getModelsRegistry: async () => ({}),
  });

  const response = await app.inject('/api/providers/usage');
  const usage = response.json().usage.glm;

  assert.equal(response.statusCode, 200);
  assert.equal(usage.state, 'ok');
  assert.equal(usage.stale, false);
  assert.deepEqual(usage.bars.map(({ key, pct }) => ({ key, pct })), [
    { key: 'zai:5h', pct: 0 },
    { key: 'zai:week', pct: 100 },
    { key: 'zai:mcp', pct: 3 },
  ]);
  assert.equal(usage.resources[0].key, 'plan');
  assert.doesNotMatch(response.body, /synthetic-private|synthetic-credit|synthetic-other/u);
});

test('кредитные окна без достоверного percentage и неизвестные типы не создают полос', async (t) => {
  const invalid = [undefined, null, '', false, -1, 'NaN', 'Infinity'];
  const limits = invalid.map((percentage) => ({ ...creditLimits()[0], percentage }));

  limits.push(
    { ...creditLimits()[0], percentage: '42.25' },
    {
      ...creditLimits()[1],
      percentage: 140,
      nextResetTime: null,
    },
    { type: 'UNKNOWN_LIMIT', percentage: 20 },
  );

  const { adapter, config } = await fixture(t, limits);
  const usage = await adapter.usage(config);

  assert.deepEqual(usage.bars.map(({ key, pct, resetsAt }) => ({
    key,
    pct,
    resetsAt,
  })), [
    {
      key: 'zai:5h',
      pct: 42.25,
      resetsAt: new Date(NOW + 2 * 3_600_000).toISOString(),
    },
    {
      key: 'zai:week',
      pct: 100,
      resetsAt: null,
    },
  ]);
});
