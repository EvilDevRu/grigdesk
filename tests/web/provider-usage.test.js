import assert from 'node:assert/strict';
import test from 'node:test';

import { providerUsageView } from '../../web/src/shared/provider-usage.js';

test('missing usage data has visible loading copy', () => {
  const view = providerUsageView(null, { name: 'Claude' });
  assert.equal(view.state, 'loading');
  assert.match(view.message, /ещё не получены/i);
  assert.deepEqual(view.bars, []);
});

test('auth failure offers claude login instead of an empty tooltip', () => {
  const view = providerUsageView({
    state: 'auth_required',
    bars: [],
    message: 'Сессия Claude истекла.',
    action: { kind: 'terminal', label: 'Войти в Claude', command: 'claude login' },
  }, { name: 'Claude' });
  assert.equal(view.tone, 'bad');
  assert.equal(view.action.command, 'claude login');
  assert.match(view.message, /истекла/i);
});

test('stale usage keeps bars and explains their age', () => {
  const view = providerUsageView({
    state: 'unavailable',
    stale: true,
    bars: [{ key: 'weekly', label: 'Неделя', pct: 80 }],
    message: 'Anthropic временно не отвечает.',
  }, { name: 'Claude' });
  assert.equal(view.bars.length, 1);
  assert.match(view.note, /последние/i);
});

test('unsupported provider usage is a normal explicit state', () => {
  const view = providerUsageView({
    state: 'unsupported',
    bars: [],
    message: 'Локальный ИИ не отдаёт данные о лимитах подписки.',
  }, { name: 'Локальный ИИ' });
  assert.equal(view.tone, 'muted');
  assert.match(view.message, /не отдаёт/i);
});
