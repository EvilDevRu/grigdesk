import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeProviderUsageAction,
  mergeProviderUsage,
  normalizeProviderUsage,
  unsupportedProviderUsage,
} from '../../server/src/lib/provider-usage.js';
import {
  classifyClaudeUsageResponse,
  parseClaudeUsagePayload,
  parseClaudeUsageResources,
} from '../../server/src/lib/executors/claude.js';
import {
  classifyCodexUsageResponse,
  consumeCodexRateLimitReset,
  parseCodexRateLimits,
  parseCodexUsageResources,
} from '../../server/src/lib/executors/codex.js';

test('usage contract never turns an executor error into an empty popup', () => {
  const status = normalizeProviderUsage({
    state: 'auth_required',
    message: 'Сессия Claude истекла.',
    action: { kind: 'terminal', label: 'Войти в Claude', command: 'claude login' },
  }, { providerName: 'Claude', checkedAt: 100 });

  assert.equal(status.state, 'auth_required');
  assert.equal(status.message, 'Сессия Claude истекла.');
  assert.deepEqual(status.bars, []);
  assert.equal(status.action.command, 'claude login');
  assert.equal(status.checkedAt, 100);
});

test('last successful bars survive a temporary usage failure and are marked stale', () => {
  const previous = normalizeProviderUsage([
    { key: 'weekly_all', label: 'Неделя (7д)', pct: 73, resetsAt: null },
  ], { providerName: 'Claude', checkedAt: 100 });
  const current = normalizeProviderUsage({
    state: 'unavailable',
    message: 'Anthropic временно не отвечает.',
  }, { providerName: 'Claude', checkedAt: 200 });

  const merged = mergeProviderUsage(previous, current);
  assert.equal(merged.state, 'unavailable');
  assert.equal(merged.stale, true);
  assert.equal(merged.bars[0].pct, 73);
  assert.equal(merged.checkedAt, 200);
  assert.equal(merged.dataCheckedAt, 100);
});

test('last successful account resources also survive a temporary usage failure', () => {
  const previous = normalizeProviderUsage({
    state: 'ok',
    bars: [],
    resources: [{
      key: 'balance',
      label: 'Баланс',
      summary: '10',
      controls: [],
    }],
  }, { checkedAt: 100 });
  const current = normalizeProviderUsage({
    state: 'unavailable',
    message: 'Временный сбой.',
  }, { checkedAt: 200 });

  const merged = mergeProviderUsage(previous, current);
  assert.equal(merged.stale, true);
  assert.equal(merged.resources[0].summary, '10');
  assert.equal(merged.dataCheckedAt, 100);
});

test('provider without a usage API is explicit instead of blank', () => {
  const status = unsupportedProviderUsage('Локальный ИИ', 300);
  assert.equal(status.state, 'unsupported');
  assert.match(status.message, /не отдаёт/i);
  assert.deepEqual(status.bars, []);
  assert.deepEqual(status.resources, []);
});

test('usage resources and their controls are provider-neutral and normalized', () => {
  const status = normalizeProviderUsage({
    state: 'ok',
    bars: [],
    resources: [{
      key: 'kimi-balance',
      label: 'Баланс Kimi',
      summary: '12 CNY',
      tone: 'ok',
      percent: 24,
      controls: [
        {
          id: 'top-up',
          kind: 'link',
          label: 'Пополнить',
          href: 'https://platform.moonshot.cn/console',
        },
        {
          id: 'auto-top-up',
          kind: 'toggle',
          label: 'автопополнение',
          value: true,
          action: 'configure-auto-top-up',
          field: 'enabled',
        },
        { id: 'unsafe-link', kind: 'link', label: 'Плохая ссылка', href: 'javascript:alert(1)' },
      ],
    }],
  }, { providerName: 'Kimi', checkedAt: 400 });

  assert.equal(status.resources[0].key, 'kimi-balance');
  assert.equal(status.resources[0].percent, 24);
  assert.deepEqual(status.resources[0].controls.map((control) => control.id), [
    'top-up',
    'auto-top-up',
  ]);
});

test('generic usage action delegates only to the selected provider adapter', async () => {
  const calls = [];
  const executor = {
    usageActions: {
      'configure-auto-top-up': async (context) => {
        calls.push(context);
        return { ok: true };
      },
    },
  };
  const result = await executeProviderUsageAction(executor, {
    actionId: 'configure-auto-top-up',
    payload: { enabled: true },
    requestId: 'request-1',
    config: { provider: 'kimi' },
    deps: { auth: 'test' },
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls[0], {
    payload: { enabled: true },
    requestId: 'request-1',
    config: { provider: 'kimi' },
    deps: { auth: 'test' },
  });
  assert.deepEqual(
    await executeProviderUsageAction(executor, { actionId: 'unknown' }),
    { ok: false, error: 'unknown_usage_action' },
  );
});

test('Codex app-server rate limits become generic and model-family bars', () => {
  const bars = parseCodexRateLimits({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 18.4, windowDurationMins: 300, resetsAt: 1_785_900_000 },
      secondary: { usedPercent: 36.6, windowDurationMins: 10_080, resetsAt: 1_786_000_000 },
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        primary: { usedPercent: 18.4, windowDurationMins: 300, resetsAt: 1_785_900_000 },
        secondary: { usedPercent: 36.6, windowDurationMins: 10_080, resetsAt: 1_786_000_000 },
      },
      codex_spark: {
        limitId: 'codex_spark',
        limitName: 'GPT-5.3-Codex-Spark',
        primary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 1_786_100_000 },
        secondary: null,
      },
    },
  });

  assert.deepEqual(bars.map((bar) => [bar.key, bar.label, bar.pct]), [
    ['codex:primary', 'Сессия (5ч)', 18],
    ['codex:secondary', 'Неделя (7д)', 37],
    ['codex_spark:primary', 'Неделя · GPT-5.3-Codex-Spark', 7],
  ]);
  assert.equal(bars[0].resetsAt, '2026-08-05T03:20:00.000Z');
});

test('Codex usage distinguishes login, old CLI and an empty service response', () => {
  const login = classifyCodexUsageResponse({
    error: { code: -32000, message: 'ChatGPT login required' },
  });
  assert.equal(login.state, 'auth_required');
  assert.equal(login.action.command, 'codex login');

  const oldCli = classifyCodexUsageResponse({
    error: { code: -32601, message: 'Method not found' },
  });
  assert.equal(oldCli.state, 'unsupported');
  assert.match(oldCli.message, /обнов/i);

  const empty = classifyCodexUsageResponse({ result: { rateLimits: null } });
  assert.equal(empty.state, 'unavailable');
  assert.match(empty.message, /не вернул/i);
});

test('Codex exposes purchased credits and earned resets through generic resources', () => {
  const result = {
    rateLimits: {
      limitId: 'codex',
      planType: 'pro',
      primary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 1_786_000_000 },
      credits: { hasCredits: false, unlimited: false, balance: '0' },
    },
    rateLimitResetCredits: {
      availableCount: 2,
      credits: [{
        id: 'RateLimitResetCredit_1',
        status: 'available',
        title: 'Rate-limit reset',
      }],
    },
  };
  const resources = parseCodexUsageResources(result);

  assert.equal(resources[0].key, 'chatgpt-credits');
  assert.equal(resources[0].summary, 'Баланс: 0');
  assert.deepEqual(resources[0].controls[0], {
    id: 'manage-credits',
    kind: 'link',
    label: 'Купить / управлять кредитами',
    href: 'https://chatgpt.com/codex/settings/usage',
  });
  assert.equal(resources[1].summary, 'Доступно: 2');
  assert.equal(resources[1].controls[0].action, 'consume-rate-limit-reset');
  assert.deepEqual(resources[1].controls[0].payload, {
    creditId: 'RateLimitResetCredit_1',
  });

  const usage = classifyCodexUsageResponse({ result });
  assert.deepEqual(usage.resources, resources);
});

test('Codex reset consumption forwards a stable idempotency key and maps outcomes', async () => {
  const calls = [];
  const reset = await consumeCodexRateLimitReset('codex', {
    requestId: 'request-7',
    creditId: 'RateLimitResetCredit_1',
  }, {
    request: async (...args) => {
      calls.push(args);
      return { result: { outcome: 'reset' } };
    },
  });
  assert.deepEqual(reset, { ok: true, outcome: 'reset' });
  assert.deepEqual(calls[0], [
    'codex',
    {
      method: 'account/rateLimitResetCredit/consume',
      params: {
        idempotencyKey: 'request-7',
        creditId: 'RateLimitResetCredit_1',
      },
    },
  ]);

  const empty = await consumeCodexRateLimitReset('codex', {}, {
    request: async () => ({ result: { outcome: 'noCredit' } }),
  });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /нет/i);
});

test('Claude usage payload is converted to subscription and scoped family bars', () => {
  const bars = parseClaudeUsagePayload({
    limits: [
      { kind: 'session', percent: 12.4, resets_at: '2026-07-29T12:00:00Z' },
      {
        kind: 'weekly_scoped',
        percent: 91.6,
        resets_at: '2026-07-31T00:00:00Z',
        scope: { model: { display_name: 'Opus' } },
      },
    ],
  });
  assert.deepEqual(bars.map((bar) => [bar.label, bar.pct]), [
    ['Сессия (5ч)', 12],
    ['Неделя · Opus', 92],
  ]);
});

test('Claude extra usage is a generic resource with adapter-owned actions', () => {
  const resources = parseClaudeUsageResources({
    extra_usage: {
      is_enabled: true,
      monthly_limit: 17_000,
      used_credits: 6_100,
      utilization: 35.9,
      currency: 'EUR',
      decimal_places: 2,
    },
  });

  assert.equal(resources[0].key, 'extra-usage');
  assert.equal(resources[0].summary, '61 из 170 EUR');
  assert.equal(resources[0].percent, 36);
  assert.deepEqual(resources[0].controls.map((control) => [
    control.kind,
    control.action || control.href,
  ]), [
    ['toggle', 'configure-extra-usage'],
    ['number', 'configure-extra-usage'],
    ['link', 'https://claude.ai/settings/usage'],
  ]);
});

test('Claude usage HTTP states explain login, account refusal and rate limiting', () => {
  const missing = classifyClaudeUsageResponse({ hasToken: false, now: 100 });
  assert.equal(missing.state, 'auth_required');
  assert.equal(missing.action.command, 'claude login');

  const expired = classifyClaudeUsageResponse({
    hasToken: true,
    status: 401,
    data: { error: { message: 'Invalid authentication credentials' } },
    now: 200,
  });
  assert.equal(expired.state, 'auth_required');
  assert.match(expired.message, /истекла|авторизац/i);

  const forbidden = classifyClaudeUsageResponse({
    hasToken: true,
    status: 403,
    data: { error: { message: 'Request not allowed' } },
    now: 300,
  });
  assert.equal(forbidden.state, 'blocked');
  assert.match(forbidden.message, /отклонил/i);

  const limited = classifyClaudeUsageResponse({
    hasToken: true,
    status: 429,
    data: { error: { message: 'weekly limit' } },
    retryAfter: '120',
    now: 400,
  });
  assert.equal(limited.state, 'rate_limited');
  assert.equal(limited.retryAt, 120_400);
});

test('successful but empty Claude payload is visible instead of a blank popup', () => {
  const empty = classifyClaudeUsageResponse({
    hasToken: true,
    status: 200,
    data: {},
    now: 500,
  });
  assert.equal(empty.state, 'unavailable');
  assert.match(empty.message, /не вернул/i);
  assert.deepEqual(empty.bars, []);
});
