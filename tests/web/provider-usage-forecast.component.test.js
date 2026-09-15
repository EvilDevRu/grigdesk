// Блок прогноза во всплывашке исполнителя: строки по полосам, последний сброс окна и
// внешний сигнал только у своего исполнителя; у исполнителя без данных блока нет.
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import {
  agoOf,
  barRowOf,
  externalRowOf,
  idleRow,
  momentOf,
  resetRowOf,
} from '../../web/src/features/providers/usageForecastText.ts';

const NOW = new Date(2026, 8, 15, 12, 0).getTime();

const STORE_STUB = `
  export const useUsageForecastStore = () => globalThis.__usageForecastStore;
`;
const WATCH_STUB = `
  export const watchUsageForecast = () => { globalThis.__usageForecastWatched += 1; };
`;

function bar(overrides = {}) {
  return {
    providerId: 'codex',
    barKey: 'codex:primary',
    label: 'Неделя (7д)',
    pct: 63,
    resetsAt: new Date(2026, 8, 19, 18, 30).toISOString(),
    ratePerHour: 6.2,
    spanMinutes: 120,
    exhaustAt: new Date(2026, 8, 15, 18, 0).toISOString(),
    verdict: 'short',
    sampledAt: new Date(NOW).toISOString(),
    windowMinutes: 300,
    averagePerHour: null,
    projectedPct: null,
    basis: 'current',
    ...overrides,
  };
}

test('ряды прогноза: момент, давность, темп с вердиктом, стоящий расход и сброс', () => {
  assert.equal(momentOf(new Date(2026, 8, 15, 18, 0).toISOString(), NOW), 'сегодня 18:00');
  assert.equal(momentOf(new Date(2026, 8, 14, 15, 9).toISOString(), NOW), 'вчера 15:09');
  assert.equal(momentOf(new Date(2026, 8, 12, 15, 9).toISOString(), NOW), '12 сен 15:09');
  assert.equal(momentOf(null, NOW), '');
  assert.equal(agoOf(new Date(NOW - 40 * 60_000).toISOString(), NOW), '40 мин назад');
  assert.equal(agoOf(new Date(NOW - 3 * 86_400_000).toISOString(), NOW), '3 дн назад');

  assert.deepEqual(barRowOf(bar(), NOW), {
    key: 'codex:primary',
    label: 'Неделя (7д)',
    value: '6.2 %/ч',
    tone: 'bad',
    sub: { label: '100 % — сегодня 18:00', text: 'до сброса не хватит', tone: 'bad' },
  });
  assert.deepEqual(barRowOf(bar({ verdict: 'enough', ratePerHour: 12 }), NOW).sub, {
    label: '100 % — сегодня 18:00',
    text: 'до сброса хватит',
    tone: 'ok',
  });
  assert.equal(barRowOf(bar({ verdict: 'idle', ratePerHour: 0, exhaustAt: null }), NOW), null);

  // Неделя судится по среднему: справа средний темп, под ним ожидаемый процент и текущий темп.
  const weekly = bar({
    windowMinutes: 10_080,
    basis: 'average',
    averagePerHour: 0.58,
    projectedPct: 97,
    ratePerHour: 1.7,
    verdict: 'enough',
  });

  assert.deepEqual(barRowOf(weekly, NOW), {
    key: 'codex:primary',
    label: 'Неделя (7д)',
    value: 'в среднем 0.6 %/ч',
    tone: 'warn',
    sub: { label: 'к сбросу ~97 % · сейчас 1.7 %/ч', text: 'впритык', tone: 'warn' },
  });
  assert.deepEqual(barRowOf(bar({ ...weekly, projectedPct: 62, ratePerHour: 0 }), NOW).sub, {
    label: 'к сбросу ~62 % · сейчас стоит',
    text: 'до сброса хватит',
    tone: 'ok',
  });
  assert.deepEqual(barRowOf(bar({ ...weekly, projectedPct: 212, verdict: 'short' }), NOW).sub, {
    label: 'к сбросу ~212 % · сейчас 1.7 %/ч',
    text: 'до сброса не хватит',
    tone: 'bad',
  });
  assert.equal(barRowOf(bar({ verdict: 'unknown', ratePerHour: null, exhaustAt: null }), NOW), null);
  assert.deepEqual(idleRow(), { key: 'idle', label: 'Темп', value: 'расход стоит', tone: 'muted', sub: null });

  assert.deepEqual(resetRowOf({
    providerId: 'codex',
    barKey: 'codex:primary',
    label: 'Неделя (7д)',
    at: new Date(2026, 8, 12, 18, 30).toISOString(),
    fromPct: 100,
    toPct: 0,
    origin: 'external',
  }, NOW), {
    key: 'reset',
    label: 'Сброс окна',
    value: '12 сен 18:30',
    tone: 'muted',
    sub: { label: '«Неделя (7д)» · сбросил вендор', text: '100 % → 0 %', tone: 'muted' },
  });
});

test('ряд внешнего сигнала: свежий, устаревший и пустой', () => {
  const signal = {
    providerId: 'codex',
    source: 'codexreset.org',
    homepage: 'https://codexreset.org/',
    fetchedAt: new Date(NOW - 40 * 60_000).toISOString(),
    stale: false,
    error: null,
    lastReset: {
      at: new Date(2026, 8, 12, 15, 9).toISOString(),
      title: 'Global Codex quota reset',
      scope: 'All users',
      sourceLabel: 'Tibo on X',
      sourceUrl: null,
    },
    chance24h: 28,
    chance48h: 49,
  };

  assert.deepEqual(externalRowOf(signal, NOW), {
    key: 'external',
    label: 'codexreset.org',
    href: 'https://codexreset.org/',
    value: 'сброс 12 сен 15:09',
    tone: 'ok',
    sub: { label: 'шанс сброса за 24 ч / 48 ч', text: '28 % / 49 %', tone: 'ok' },
  });

  const stale = externalRowOf({ ...signal, stale: true, error: 'socket closed' }, NOW);

  assert.equal(stale.tone, 'muted');
  assert.equal(stale.note, 'данные 40 мин назад');

  assert.deepEqual(externalRowOf({
    ...signal,
    fetchedAt: null,
    stale: true,
    error: 'HTTP 503',
    lastReset: null,
    chance24h: null,
    chance48h: null,
  }, NOW), {
    key: 'external',
    label: 'codexreset.org',
    href: 'https://codexreset.org/',
    value: 'нет данных',
    tone: 'muted',
    sub: null,
    note: 'HTTP 503',
  });
});

test('компонент показывает блок своему исполнителю и молчит у чужого', async (t) => {
  const browser = await installUiBrowser(t);

  globalThis.__usageForecastWatched = 0;
  globalThis.__usageForecastStore = {
    barsOf: (id) => (id === 'codex' ? [bar()] : []),
    lastResetOf: (id) => (id === 'codex' ? {
      providerId: 'codex',
      barKey: 'codex:primary',
      label: 'Неделя (7д)',
      at: new Date(2026, 8, 12, 18, 30).toISOString(),
      fromPct: 100,
      toPct: 0,
      origin: 'external',
    } : null),
    externalOf: (id) => (id === 'codex' ? {
      providerId: 'codex',
      source: 'codexreset.org',
      homepage: 'https://codexreset.org/',
      fetchedAt: new Date().toISOString(),
      stale: false,
      error: null,
      lastReset: null,
      chance24h: 28,
      chance48h: 49,
    } : null),
  };

  const [{ mount }, ProviderUsageForecast] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/features/providers/ProviderUsageForecast.vue'), {
      stubs: {
        '../../stores/usageForecast.ts': STORE_STUB,
        '../../actions/usageForecast/watchUsageForecast.ts': WATCH_STUB,
      },
    }),
  ]);

  const codex = mount(ProviderUsageForecast, {
    attachTo: browser.document.querySelector('#mount'),
    props: { providerId: 'codex' },
  });

  t.after(() => codex.unmount());

  assert.match(codex.text(), /Прогноз/);
  assert.match(codex.text(), /Неделя \(7д\)\s*6.2 %\/ч/);
  assert.match(codex.text(), /до сброса не хватит/);
  assert.match(codex.text(), /Сброс окна\s*12 сен 18:30/);
  assert.match(codex.text(), /«Неделя \(7д\)» · сбросил вендор\s*100 % → 0 %/);
  assert.match(codex.text(), /шанс сброса за 24 ч \/ 48 ч\s*28 % \/ 49 %/);
  assert.doesNotMatch(codex.text(), /расход стоит/);
  assert.equal(codex.get('a').text(), 'codexreset.org');
  assert.equal(codex.get('a').attributes('href'), 'https://codexreset.org/');
  assert.equal(codex.get('a').attributes('target'), '_blank');
  assert.equal(globalThis.__usageForecastWatched, 1);

  const ollama = mount(ProviderUsageForecast, { props: { providerId: 'ollama' } });

  t.after(() => ollama.unmount());

  assert.equal(ollama.text(), '');

  // Полосы есть, но все стоят: один общий ряд вместо трёх одинаковых.
  globalThis.__usageForecastStore.barsOf = (id) => (id === 'claude'
    ? [bar({ providerId: 'claude', verdict: 'idle', ratePerHour: 0, exhaustAt: null }),
      bar({ providerId: 'claude', barKey: 'claude:5h', label: 'Сессия (5ч)', verdict: 'idle', ratePerHour: 0, exhaustAt: null })]
    : []);
  const claude = mount(ProviderUsageForecast, { props: { providerId: 'claude' } });

  t.after(() => claude.unmount());

  assert.equal(claude.text().match(/расход стоит/g).length, 1);
});
