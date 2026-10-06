import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createUsageReadCache,
  executeProviderUsageAction,
  mergeProviderUsage,
  normalizeProviderUsage,
  unsupportedProviderUsage,
} from '../../server/src/lib/providerUsage.ts';
import {
  classifyClaudeUsageResponse,
  fetchClaudeUsage,
  parseClaudeUsagePayload,
  parseClaudeUsageResources,
} from '../../server/src/lib/executors/claude.ts';
import { claudeOauthMetadata } from '../../server/src/lib/executors/_claudeCatalog.ts';
import {
  classifyCodexUsageResponse,
  consumeCodexRateLimitReset,
  parseCodexRateLimits,
  parseCodexUsageResources,
  readCodexRateLimits,
} from '../../server/src/lib/executors/codex.ts';

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

test('usage read cache объединяет одновременные загрузки и считает TTL после ответа', async () => {
  let currentTime = 100;
  let calls = 0;
  let finishFirst;
  const cache = createUsageReadCache(async () => {
    calls += 1;
    if (calls === 1) return new Promise((resolve) => { finishFirst = resolve; });
    return { generation: calls };
  }, { maxAgeMs: 60, now: () => currentTime });

  const first = cache.read();
  const concurrent = cache.read();
  await Promise.resolve();
  assert.equal(calls, 1);

  currentTime = 130;
  finishFirst({ generation: 1 });
  assert.deepEqual(await Promise.all([first, concurrent]), [
    { generation: 1 },
    { generation: 1 },
  ]);

  currentTime = 189;
  assert.deepEqual(await cache.read(), { generation: 1 });
  assert.equal(calls, 1);

  currentTime = 190;
  assert.deepEqual(await cache.read(), { generation: 2 });
  assert.equal(calls, 2);
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

test('Codex bar order is owned by Cockpit, not by the service key order', () => {
  // `rateLimitsByLimitId` — объект, и OpenAI перетасовывает ключи от ответа к ответу
  // (замер: шесть запросов подряд дали три разных порядка). Без своей сортировки
  // полосы в шапке скакали на каждом минутном обновлении реестра.
  const buckets = {
    base_model_inference: {
      limitId: 'base_model_inference',
      limitName: 'gpt-reserve',
      primary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_788_323_408 },
    },
    codex_bengalfox: {
      limitId: 'codex_bengalfox',
      limitName: 'GPT-5.3-Codex-Spark',
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_787_736_608 },
      secondary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_788_323_408 },
    },
    codex: {
      limitId: 'codex',
      primary: { usedPercent: 2, windowDurationMins: 10_080, resetsAt: 1_788_272_122 },
    },
  };

  const shuffled = (keys) => parseCodexRateLimits({
    rateLimitsByLimitId: Object.fromEntries(keys.map((key) => [key, buckets[key]])),
  }).map((bar) => [bar.key, bar.group, bar.label]);

  // Общая квота аккаунта первой, затем именованные вёдра по видимой подписи.
  const expected = [
    ['codex:primary', 'codex', 'Неделя (7д)'],
    ['codex_bengalfox:primary', 'codex_bengalfox', 'Сессия · GPT-5.3-Codex-Spark'],
    ['codex_bengalfox:secondary', 'codex_bengalfox', 'Неделя · GPT-5.3-Codex-Spark'],
    ['base_model_inference:primary', 'base_model_inference', 'Неделя · gpt-reserve'],
  ];

  assert.deepEqual(shuffled(['codex', 'codex_bengalfox', 'base_model_inference']), expected);
  assert.deepEqual(shuffled(['base_model_inference', 'codex_bengalfox', 'codex']), expected);
  assert.deepEqual(shuffled(['codex_bengalfox', 'base_model_inference', 'codex']), expected);
});

test('An unknown window slot shows up instead of being silently dropped', () => {
  // Схема app-server знает сегодня ровно primary и secondary, но перечислять их
  // списком — значит потерять третий слот молча, как терялось бы новое ведро при
  // allowlist по id. Окном считается любое поле с числовым usedPercent; `credits`
  // и `individualLimit` под это не подходят и в полосы не превращаются.
  const bars = parseCodexRateLimits({
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_788_272_122 },
        tertiary: { usedPercent: 10, windowDurationMins: 43_200, resetsAt: 1_790_000_000 },
        primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1_787_736_608 },
        credits: { hasCredits: false, unlimited: false, balance: '0' },
        individualLimit: { limit: '10', used: '1', remainingPercent: 90, resetsAt: 1_790_000_000 },
        spendControlReached: false,
        planType: 'pro',
      },
    },
  });

  // Порядок — по длительности окна, а не по имени слота: имена придумывает сервис.
  assert.deepEqual(bars.map((bar) => [bar.key, bar.label, bar.pct]), [
    ['codex:primary', 'Сессия (5ч)', 5],
    ['codex:secondary', 'Неделя (7д)', 40],
    ['codex:tertiary', 'Окно (30д)', 10],
  ]);
});

test('Claude spend limit reached is stated, not inferred from numbers', () => {
  // Сервис сообщает это отдельным полем. Выводить из `used >= limit` нельзя:
  // у выключенной доплаты и у режима «без потолка» чисел может не быть вовсе.
  const [calm] = parseClaudeUsageResources({
    extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 100, currency: 'EUR' },
  });
  assert.equal(calm.tone, 'ok');
  assert.doesNotMatch(calm.note, /потолок/i);

  const [reached] = parseClaudeUsageResources({
    extra_usage: {
      is_enabled: true,
      monthly_limit: 2000,
      used_credits: 2000,
      currency: 'EUR',
      spend_limit_reached: true,
    },
  });
  assert.equal(reached.tone, 'bad');
  assert.match(reached.note, /Месячный потолок доплаты выбран/);
});

test('Claude bars name their bucket so scoped families stay separable', () => {
  const bars = parseClaudeUsagePayload({
    limits: [
      { kind: 'session', percent: 2 },
      { kind: 'weekly_all', percent: 60 },
      { kind: 'weekly_scoped', percent: 0, scope: { model: { display_name: 'Fable' } } },
    ],
  });

  assert.deepEqual(bars.map((bar) => bar.group), [
    'subscription',
    'subscription',
    'scoped:Fable',
  ]);
});

test('Codex spend control surfaces instead of stopping the account silently', () => {
  // Поля приходили с самого начала и не показывались нигде: исчерпанный денежный
  // потолок выглядел как «всё молча встало» без подсказки во всплывашке.
  const quiet = parseCodexUsageResources({
    rateLimits: { limitId: 'codex', individualLimit: null, spendControlReached: false },
  });
  assert.equal(quiet.find((resource) => resource.key === 'spend-control'), undefined);

  const reached = parseCodexUsageResources({
    rateLimits: {
      limitId: 'codex',
      individualLimit: { limit: '50.00', used: '50.00', remainingPercent: 0, resetsAt: 1_790_000_000 },
      spendControlReached: true,
      rateLimitReachedType: 'workspace_owner_usage_limit_reached',
    },
  });
  const resource = reached.find((item) => item.key === 'spend-control');

  assert.equal(resource.tone, 'bad');
  // Деньги остаются строками как пришли: Number на них молча теряет точность.
  assert.equal(resource.summary, '50.00 из 50.00');
  assert.equal(resource.percent, 100);
  assert.match(resource.note, /Лимит трат исчерпан/);
  assert.match(resource.note, /лимит расхода владельца/);
});

test('An unknown reached reason is shown as the service word, not invented', () => {
  const resources = parseCodexUsageResources({
    rateLimits: { limitId: 'codex', rateLimitReachedType: 'some_future_reason' },
  });

  assert.match(resources.find((item) => item.key === 'spend-control').note, /some_future_reason/);
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

test('Codex credit balance is rounded to hundredths with grouped thousands', () => {
  const summaryOf = (balance) => parseCodexUsageResources({
    credits: {
      hasCredits: true,
      unlimited: false,
      balance,
    },
  })[0].summary;

  assert.equal(summaryOf('62420.0214700000'), 'Баланс: 62 420,02');
  assert.equal(summaryOf(1500), 'Баланс: 1 500');
  assert.equal(summaryOf('не число'), 'Баланс: не число');
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

test('Claude usage refreshes an expired CLI token instead of asking for login', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-claude-oauth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credentialsPath = path.join(dir, '.credentials.json');
  const now = 1_800_000_000_000;
  await writeFile(credentialsPath, JSON.stringify({
    untouched: 'keep',
    claudeAiOauth: {
      accessToken: 'expired-access',
      refreshToken: 'working-refresh',
      expiresAt: now - 1,
      refreshTokenExpiresAt: now + 86_400_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
    },
  }), { mode: 0o600 });

  const calls = [];
  const usage = await fetchClaudeUsage({
    credentialsPath,
    now: () => now,
    oauthClientId: 'fixture-client-id',
    oauthTokenUrl: 'https://auth.example.test/v1/oauth/token',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/v1/oauth/token')) {
        return new Response(JSON.stringify({
          access_token: 'fresh-access',
          refresh_token: 'rotated-refresh',
          expires_in: 3_600,
          refresh_token_expires_in: 7_200,
          scope: 'user:profile user:inference',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      assert.equal(init.headers.Authorization, 'Bearer fresh-access');
      return new Response(JSON.stringify({
        limits: [{ kind: 'session', percent: 12 }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.equal(usage.status, 200);
  assert.equal(calls.length, 2);
  const refreshBody = JSON.parse(calls[0].init.body);
  assert.equal(refreshBody.grant_type, 'refresh_token');
  assert.equal(refreshBody.refresh_token, 'working-refresh');
  assert.equal(refreshBody.client_id, 'fixture-client-id');
  assert.equal(refreshBody.scope, 'user:profile user:inference');

  const stored = JSON.parse(await readFile(credentialsPath, 'utf8'));
  assert.equal(stored.untouched, 'keep');
  assert.equal(stored.claudeAiOauth.accessToken, 'fresh-access');
  assert.equal(stored.claudeAiOauth.refreshToken, 'rotated-refresh');
  assert.equal(stored.claudeAiOauth.expiresAt, now + 3_600_000);
  assert.equal(stored.claudeAiOauth.subscriptionType, 'max');
});

test('temporary Claude token refresh failure is not reported as logout', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-claude-oauth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credentialsPath = path.join(dir, '.credentials.json');
  const now = 1_800_000_000_000;
  await writeFile(credentialsPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'expired-access',
      refreshToken: 'working-refresh',
      expiresAt: now - 1,
      scopes: ['user:inference'],
    },
  }), { mode: 0o600 });

  const raw = await fetchClaudeUsage({
    credentialsPath,
    now: () => now,
    oauthClientId: 'fixture-client-id',
    oauthTokenUrl: 'https://auth.example.test/v1/oauth/token',
    fetchImpl: async () => { throw new Error('network offline'); },
  });
  const status = classifyClaudeUsageResponse(raw);

  assert.equal(raw.hasToken, true);
  assert.equal(raw.status, 0);
  assert.equal(status.state, 'unavailable');
  assert.equal(status.action, null);
});

test('OAuth-пара Claude извлекается из установленного бинаря единым источником', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-claude-bin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'claude-fixture');
  await writeFile(bin, Buffer.from([
    'https://auth.example.test/v1/oauth/token',
    'https://auth.example.test/oauth/code/callback',
    '12345678-1234-5678-9abc-123456789abc',
  ].join('\0')));

  assert.deepEqual(await claudeOauthMetadata({ claudeBin: bin }), {
    tokenUrl: 'https://auth.example.test/v1/oauth/token',
    clientId: '12345678-1234-5678-9abc-123456789abc',
  });
});

test('без полной OAuth-пары refresh завершается до сетевого запроса', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-claude-oauth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credentialsPath = path.join(dir, '.credentials.json');
  const bin = path.join(dir, 'claude-without-oauth');
  await writeFile(bin, 'нет oauth metadata');
  await writeFile(credentialsPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'expired-access',
      refreshToken: 'working-refresh',
      expiresAt: 1,
    },
  }));
  let fetched = false;

  const raw = await fetchClaudeUsage({
    credentialsPath,
    claudeBin: bin,
    now: () => 10_000,
    fetchImpl: async () => { fetched = true; throw new Error('не вызывать'); },
  });

  assert.equal(fetched, false);
  assert.equal(raw.error, 'oauth_refresh_metadata_missing');
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

// --- моргнувшая сеть не должна выглядеть как «лимиты недоступны» ---------------
// Живой случай 22.08.2026: VPN-туннель моргает секундами, и одиночный (у Codex) либо
// мгновенно повторённый (у Claude) запрос попадает в то же моргание. В шапке появлялось
// «Не удалось получить лимиты», хотя аккаунт исправен. Отсюда пауза между попытками:
// повтор без неё удваивает трафик, не увеличивая шанс на ответ.

test('Claude usage survives a blinking tunnel: retries with a pause, not instantly', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-claude-usage-retry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credentialsPath = path.join(dir, '.credentials.json');
  const now = 1_800_000_000_000;
  await writeFile(credentialsPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'live-access',
      refreshToken: 'live-refresh',
      expiresAt: now + 3_600_000,
      refreshTokenExpiresAt: now + 86_400_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
    },
  }), { mode: 0o600 });

  const naps = [];
  let attempts = 0;
  const usage = await fetchClaudeUsage({
    credentialsPath,
    now: () => now,
    sleep: async (ms) => { naps.push(ms); },
    fetchImpl: async () => {
      attempts += 1;
      // Два первых запроса попали в моргание, третий доехал.
      if (attempts < 3) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({
        limits: [{ name: 'weekly_all', utilization: 41, resets_at: null }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.equal(attempts, 3, 'до успеха дошли третьей попыткой');
  assert.deepEqual(naps, [400, 1200], 'между попытками была нарастающая пауза');
  assert.equal(usage.status, 200, 'человек видит лимиты, а не отказ');
});

test('Claude usage does not retry a refusal the network cannot fix', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-claude-usage-403-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credentialsPath = path.join(dir, '.credentials.json');
  const now = 1_800_000_000_000;
  await writeFile(credentialsPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'live-access',
      refreshToken: 'live-refresh',
      expiresAt: now + 3_600_000,
      refreshTokenExpiresAt: now + 86_400_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
    },
  }), { mode: 0o600 });

  let attempts = 0;
  const naps = [];
  const usage = await fetchClaudeUsage({
    credentialsPath,
    now: () => now,
    sleep: async (ms) => { naps.push(ms); },
    fetchImpl: async () => {
      attempts += 1;
      return new Response(JSON.stringify({ error: { message: 'forbidden' } }), { status: 403 });
    },
  });

  assert.equal(attempts, 1, 'отказ аккаунта повторять нечем — он не про сеть');
  assert.deepEqual(naps, [], 'и задерживать человека паузой тоже не за чем');
  assert.equal(usage.status, 403);
});

test('Codex usage retries transport failures but accepts a permanent answer at once', async () => {
  const naps = [];
  let attempts = 0;
  const recovered = await readCodexRateLimits('codex', {
    sleep: async (ms) => { naps.push(ms); },
    request: async () => {
      attempts += 1;
      if (attempts < 3) return { error: { message: 'Codex app-server не ответил за отведённое время' } };
      return {
        result: {
          rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null } },
        },
      };
    },
  });

  assert.equal(attempts, 3, 'таймаут app-server лечится повтором');
  assert.deepEqual(naps, [400, 1200], 'повтор идёт с нарастающей паузой');
  assert.equal(classifyCodexUsageResponse(recovered).state, 'ok');

  for (const [label, error] of [
    ['неавторизован', { message: 'Please run codex login first' }],
    ['устаревший CLI', { code: -32601, message: 'method not found' }],
  ]) {
    let tries = 0;
    const response = await readCodexRateLimits('codex', {
      sleep: async () => { throw new Error('паузы быть не должно'); },
      request: async () => { tries += 1; return { error }; },
    });
    assert.equal(tries, 1, `${label}: ожиданием не лечится, повтор не нужен`);
    assert.notEqual(classifyCodexUsageResponse(response).state, 'ok');
  }
});

// Фоновый тик читает по требованию, а не по TTL, и не теряет прошлый снимок: слияние
// при сбое держит старые полосы, только если ему есть что держать.
test('usage read cache: refresh перечитывает до истечения TTL и отдаёт load прошлый снимок', async () => {
  let currentTime = 100;
  const seen = [];
  const cache = createUsageReadCache(async (previous) => {
    seen.push(previous);
    return { generation: seen.length };
  }, { maxAgeMs: 60, now: () => currentTime });

  assert.equal(cache.ageMs(), Number.POSITIVE_INFINITY, 'без снимка возраст бесконечен');
  assert.deepEqual(await cache.read(), { generation: 1 });
  assert.equal(cache.ageMs(), 0);

  currentTime = 130;
  assert.equal(cache.ageMs(), 30);
  assert.deepEqual(await cache.read(), { generation: 1 }, 'TTL не вышел — read молчит');
  assert.deepEqual(await cache.refresh(), { generation: 2 }, 'refresh ходит, не дожидаясь TTL');
  assert.deepEqual(seen, [null, { generation: 1 }]);

  currentTime = 150;
  assert.deepEqual(await cache.read(), { generation: 2 }, 'снимок refresh обновил и TTL');
});

test('usage read cache: refresh не дублирует уже начатое чтение', async () => {
  let finishFirst;
  let calls = 0;
  const cache = createUsageReadCache(async () => {
    calls += 1;
    return new Promise((resolve) => { finishFirst = resolve; });
  }, { maxAgeMs: 60, now: () => 100 });

  const reading = cache.read();
  const refreshing = cache.refresh();
  await Promise.resolve();
  assert.equal(calls, 1);

  finishFirst({ generation: 1 });
  assert.deepEqual(await Promise.all([reading, refreshing]), [
    { generation: 1 },
    { generation: 1 },
  ]);
});
