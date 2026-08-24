import assert from 'node:assert/strict';
import test from 'node:test';

import { providerUsageView } from '../../web/src/features/providers/providerUsage.js';
import {
  prepareUsageControl,
  usageControlConfirmation,
} from '../../web/src/features/providers/providerUsageActions.js';

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

test('provider usage view keeps generic resources without knowing the vendor', () => {
  const resource = {
    key: 'kimi-balance',
    label: 'Баланс Kimi',
    summary: '12 CNY',
    controls: [{ id: 'top-up', kind: 'link', label: 'Пополнить', href: 'https://example.test' }],
  };
  const view = providerUsageView({
    state: 'ok',
    bars: [],
    resources: [resource],
  }, { name: 'Kimi' });

  assert.deepEqual(view.resources, [resource]);
});

test('generic usage controls build provider action payloads and confirmations', () => {
  const control = {
    id: 'limit',
    kind: 'number',
    action: 'configure-extra-usage',
    field: 'limit',
    unit: 'EUR',
    minExclusive: 0,
    confirm: {
      text: 'Поставить потолок {value} {unit}?',
      label: 'Поставить',
    },
  };

  assert.deepEqual(prepareUsageControl(control, '12,50'), {
    ok: true,
    actionId: 'configure-extra-usage',
    payload: { limit: 12.5 },
    value: 12.5,
  });
  assert.deepEqual(usageControlConfirmation(control, 12.5), {
    text: 'Поставить потолок 12.5 EUR?',
    label: 'Поставить',
    danger: false,
  });
  assert.equal(prepareUsageControl(control, '0').ok, false);

  const toggle = {
    kind: 'toggle',
    action: 'configure-auto-top-up',
    field: 'enabled',
    confirm: {
      on: { text: 'Включить?', label: 'Включить' },
      off: { text: 'Выключить?', label: 'Выключить', danger: true },
    },
  };
  assert.deepEqual(prepareUsageControl(toggle, false).payload, { enabled: false });
  assert.equal(usageControlConfirmation(toggle, false).danger, true);
});
