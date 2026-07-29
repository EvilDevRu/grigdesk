import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeProviderUsage,
  normalizeProviderUsage,
  unsupportedProviderUsage,
} from '../../server/src/lib/provider-usage.js';
import {
  classifyClaudeUsageResponse,
  parseClaudeUsagePayload,
} from '../../server/src/lib/executors/claude.js';

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

test('provider without a usage API is explicit instead of blank', () => {
  const status = unsupportedProviderUsage('GPT (Codex)', 300);
  assert.equal(status.state, 'unsupported');
  assert.match(status.message, /не отдаёт/i);
  assert.deepEqual(status.bars, []);
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
