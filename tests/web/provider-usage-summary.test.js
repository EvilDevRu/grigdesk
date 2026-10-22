import { loadProductModule } from './helpers/compile-vue.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';

const { useProvidersStore } = await loadProductModule('src/stores/providers.ts');

import { api } from '../../web/src/shared/apiClient.ts';
import { providerUsageSummary, remainingUsagePercent, usedUsagePercent }
  from '../../web/src/features/providers/providerUsageSummary.ts';

const fresh = { status: 'success' };
const quota = (pct = 25) => ({ state: 'ok', bars: [{
  key: 'week',
  label: 'Неделя · пул X',
  pct,
}] });

test('остаток отличает ноль, дробь и неизвестность без приведения мусора к числу', () => {
  assert.equal(remainingUsagePercent(0), '100%');
  assert.equal(remainingUsagePercent(100), '0%');
  assert.equal(remainingUsagePercent(99.9), '<1%');

  for (const value of [null, '', '42', NaN, Infinity, -1, 101]) {
    assert.equal(remainingUsagePercent(value), 'нет данных');
  }
});

test('окна и валюты сохраняют порядок, квоты имеют приоритет, тариф не становится балансом', () => {
  const view = providerUsageSummary('any', {
    ...quota(),
    bars: [...quota().bars, {
      key: 'session',
      label: 'Сессия',
      pct: null,
    }],
    resources: [
      {
        key: 'price',
        label: 'Баланс',
        summary: '0 USD',
      },
      {
        key: 'usd',
        label: 'USD',
        kind: 'balance',
        balance: { amount: 0.001, currency: 'USD' },
      },
      {
        key: 'cny',
        label: 'CNY',
        kind: 'balance',
        balance: { amount: -2, currency: 'CNY' },
      },
      {
        key: 'bad',
        label: 'Сломан',
        kind: 'balance',
        balance: { amount: null, currency: 'USD' },
      },
    ],
  }, fresh);

  assert.deepEqual(view.items.map((item) => item.key), ['week', 'session']);
  assert.equal(view.windows[0].label, 'Неделя · пул X');
  assert.equal(view.windows[1].value, 'нет данных');
  assert.deepEqual(view.balances.map((item) => item.value), ['0,001 USD', '-2,00 CNY']);
});

test('первый GET, ошибка, отсутствие записи, снятый исполнитель и вендорные отказы различаются', () => {
  assert.equal(providerUsageSummary('any', null, { status: 'loading' }).label, 'Лимиты: …');
  assert.equal(providerUsageSummary('any', null, { status: 'error', error: 'GrigDesk HTTP 401' }).label,
    'Лимиты недоступны');
  assert.equal(providerUsageSummary('any', null, fresh).label, 'Нет данных о лимитах');
  assert.equal(providerUsageSummary('removed', quota(), fresh, false).label, 'Исполнитель недоступен');
  assert.equal(providerUsageSummary('', quota(), fresh).items.length, 0);

  for (const state of ['auth_required', 'blocked', 'rate_limited', 'unavailable']) {
    const view = providerUsageSummary('any', { ...quota(), state }, fresh);

    assert.ok(view.label);
    assert.equal(view.stale, true);
  }

  const stale = providerUsageSummary('any', {
    ...quota(),
    checkedAt: 500,
    dataCheckedAt: 100,
  },
    {
      status: 'error',
      deliveryStale: true,
      error: 'HTTP 401 GrigDesk',
    });

  assert.equal(stale.measuredAt, 100);
  assert.equal(stale.stale, true);
  assert.equal(stale.windows[0].value, '75%');
  assert.match(stale.detail, /GrigDesk/);
});

test('поздний GET и refresh не заменяют новый SSE, включая позднюю ошибку', async (t) => {
  setActivePinia(createPinia());

  const store = useProvidersStore();
  let resolveGet;
  let rejectRefresh;

  t.mock.method(api, 'get', () => new Promise((resolve) => {
    resolveGet = resolve;
  }));
  t.mock.method(api, 'post', () => new Promise((_, reject) => {
    rejectRefresh = reject;
  }));

  const get = store.loadUsage(true);

  store.applyUsage({ any: quota(80) });
  resolveGet({ usage: { any: quota(10) } });
  await get;
  assert.equal(store.usage.any.bars[0].pct, 80);

  const refresh = store.refreshUsage();

  store.applyUsage({ any: quota(90) });
  rejectRefresh(new Error('поздняя ошибка'));
  await refresh;
  assert.equal(store.usage.any.bars[0].pct, 90);
  assert.equal(store.usageTransport.status, 'success');
  assert.equal(store.usageTransport.error, '');
});

test('ошибка первичной загрузки завершается, reconnect ждёт принятого снимка', async (t) => {
  setActivePinia(createPinia());

  const store = useProvidersStore();

  t.mock.method(api, 'get', async () => {
    throw new Error('GrigDesk HTTP 401');
  });
  await store.loadUsage(true);
  assert.equal(store.usageTransport.status, 'error');
  assert.equal(store.usageTransport.receivedAt, 0);

  store.noteUsageConnection(true);
  store.applyUsage({ any: quota() });
  store.noteUsageConnection(false);
  store.noteUsageConnection(true);
  assert.equal(store.usageTransport.deliveryStale, true);
  store.applyUsage({ any: quota(30) });
  assert.equal(store.usageTransport.deliveryStale, false);
  assert.equal(store.usageTransport.error, '');
});


test('расход и остаток не выдают округлённые крайние значения за точные', () => {
  for (const [used, spent, remaining] of [
    [0, '0%', '100%'],
    [0.4, '<1%', '>99%'],
    [6, '6%', '94%'],
    [28, '28%', '72%'],
    [33.33, '33%', '67%'],
    [99.6, '>99%', '<1%'],
    [100, '100%', '0%'],
  ]) {
    assert.equal(usedUsagePercent(used), spent);
    assert.equal(remainingUsagePercent(used), remaining);
  }

  for (const value of [null, '', true, '42', NaN, Infinity, -1, 101]) {
    assert.equal(usedUsagePercent(value), 'нет данных');
  }
});


test('сброс истёк: прежний остаток сохраняется с expired и stale вместо выдуманных 100%', () => {
  const now = Date.UTC(2030, 0, 1);
  const entry = {
    ...quota(25),
    bars: [{ ...quota(25).bars[0], resetsAt: new Date(now + 1000).toISOString() }],
  };
  const before = providerUsageSummary('any', entry, fresh, true, now);
  const expired = providerUsageSummary('any', entry, fresh, true, now + 1000);

  assert.equal(before.stale, false);
  assert.equal(expired.windows[0].expired, true);
  assert.equal(expired.stale, true);
  assert.equal(expired.windows[0].value, '75%');
});
