import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeProviderUsage } from '../../server/src/lib/providerUsage.ts';
import { acceptPatch, projectUsage, settlePoll } from '../../server/src/lib/providerUsageLive.ts';

const NOW = Date.UTC(2030, 0, 1);
const RESET = new Date(NOW + 5 * 3600000).toISOString();
const NEXT = new Date(NOW + 10 * 3600000).toISOString();
const empty = () => ({
  generation: 0,
  seq: 0,
  bars: new Map()
});
const bar = (key, pct, resetsAt = RESET) => ({
  key,
  label: key,
  pct,
  resetsAt,
});
const snapshot = () => normalizeProviderUsage({
  state: 'ok',
  bars: [bar('session', 6), bar('week', 28, NEXT), bar('model', 11, NEXT)],
  resources: [{
    key: 'plan',
    label: 'Подписка',
    summary: 'тариф'
  }],
  dataCheckedAt: NOW,
  checkedAt: NOW,
});
const accept = (state, bars, patch) => acceptPatch(state, bars, { bars: patch }, { now: NOW });

test('R2: равный процент без сброса дублирует снимок и сохраняет известный срок', () => {
  const entry = normalizeProviderUsage({ state: 'ok', bars: [bar('session', 50)] });
  const result = accept(empty(), entry.bars, [bar('session', 50, null)]);

  assert.equal(result.changed, false);
  assert.equal(result.state.seq, 0);
  assert.equal(projectUsage(entry, result.state).bars[0].resetsAt, RESET);
});

test('R2: неизвестный сброс не блокирует следующее окно с меньшим расходом', () => {
  const entry = normalizeProviderUsage({ state: 'ok', bars: [bar('session', 50)] });
  const sparse = accept(empty(), entry.bars, [bar('session', 50, null)]);
  const next = accept(sparse.state, entry.bars, [bar('session', 3, NEXT)]);

  assert.equal(next.changed, true);
  assert.equal(projectUsage(entry, next.state).bars[0].pct, 3);
  assert.equal(projectUsage(entry, next.state).bars[0].resetsAt, NEXT);
});

test('R2: растущий разреженный patch сохраняет сброс предыдущего оверлея', () => {
  const entry = snapshot();
  const first = accept(empty(), entry.bars, [bar('session', 50, NEXT)]);
  const sparse = accept(first.state, entry.bars, [bar('session', 55, null)]);

  assert.equal(sparse.changed, true);
  assert.equal(sparse.state.bars.get('session').resetsAt, NEXT);
  assert.equal(projectUsage(entry, sparse.state).bars[0].resetsAt, NEXT);
});

test('R5: более высокий расход снимка того же окна сильнее старого оверлея', () => {
  const entry = snapshot();
  const { state } = accept(empty(), entry.bars, [bar('session', 8)]);

  for (const offset of [-30000, 30000]) {
    const reset = new Date(Date.parse(RESET) + offset).toISOString();
    const fresh = normalizeProviderUsage({ state: 'ok', bars: [bar('session', 10, reset)] });

    assert.equal(projectUsage(fresh, state).bars[0].pct, 10);
    assert.equal(state.bars.get('session').pct, 8, 'проекция не меняет оверлей');
  }
});

test('R5: новое окно снимка не перекрывается оверлеем старого окна', () => {
  const entry = snapshot();
  const { state } = accept(empty(), entry.bars, [bar('session', 80)]);
  const fresh = normalizeProviderUsage({ state: 'ok', bars: [bar('session', 3, NEXT)] });

  assert.deepEqual(projectUsage(fresh, state).bars[0], fresh.bars[0]);
});

test('patch сессии сохраняет недели, их сбросы и ресурсы', () => {
  const entry = snapshot();
  const { state, changed } = accept(empty(), entry.bars, [bar('session', 8)]);
  const projected = projectUsage(entry, state);

  assert.equal(changed, true);
  assert.deepEqual(projected.bars.map((item) => 100 - item.pct), [92, 72, 89]);
  assert.deepEqual(projected.bars.slice(1), entry.bars.slice(1));
  assert.deepEqual(projected.resources, entry.resources);
  assert.equal(entry.bars[0].pct, 6, 'исходный снимок неизменен');
});

test('patch недели сохраняет остальные окна', () => {
  const entry = snapshot();
  const { state } = accept(empty(), entry.bars, [bar('week', 30, NEXT)]);

  assert.deepEqual(projectUsage(entry, state).bars.map((item) => item.pct), [6, 30, 11]);
});

test('окна с одинаковой подписью объединяются по ключам', () => {
  const entry = normalizeProviderUsage({
    state: 'ok',
    bars: [bar('a', 6), bar('b', 28)].map((item) => ({ ...item, label: 'Неделя' })),
  });
  const { state } = accept(empty(), entry.bars, [bar('b', 30)]);

  assert.deepEqual(projectUsage(entry, state).bars.map((item) => item.pct), [6, 30]);
});

test('дубликат не меняет последовательность оверлея', () => {
  const entry = snapshot();
  const first = accept(empty(), entry.bars, [bar('session', 8)]);
  const second = accept(first.state, entry.bars, [bar('session', 8)]);

  assert.equal(second.changed, false);
  assert.equal(second.state.seq, first.state.seq);
});

test('поздний patch прошлого окна отвергается', () => {
  const entry = snapshot();
  const first = accept(empty(), entry.bars, [bar('session', 2, NEXT)]);
  const late = accept(first.state, entry.bars, [bar('session', 90)]);

  assert.equal(late.changed, false);
  assert.equal(projectUsage(entry, late.state).bars[0].pct, 2);
});

test('новое окно допускает уменьшение расхода', () => {
  const entry = snapshot();
  const first = accept(empty(), entry.bars, [bar('session', 98)]);
  const reset = accept(first.state, entry.bars, [bar('session', 2, NEXT)]);

  assert.equal(reset.changed, true);
  assert.equal(projectUsage(entry, reset.state).bars[0].pct, 2);
});

test('в том же окне расход не уменьшается от перестановки событий', () => {
  const entry = snapshot();
  const first = accept(empty(), entry.bars, [bar('session', 42)]);
  const late = accept(first.state, entry.bars, [bar('session', 40)]);

  assert.equal(late.changed, false);
  assert.equal(projectUsage(entry, late.state).bars[0].pct, 42);
});

test('метаданные полосы принадлежат снимку, включая разреженный patch', () => {
  const entry = snapshot();

  entry.bars[0].windowMinutes = 300;
  entry.bars[0].group = 'subscription';

  const { state } = accept(empty(), entry.bars, [{
    key: 'session',
    pct: 8,
    resetsAt: RESET,
    label: 'чужая подпись',
    windowMinutes: 999,
    group: 'other',
  }]);
  const projected = projectUsage(entry, state).bars[0];

  assert.equal(projected.label, 'session');
  assert.equal(projected.windowMinutes, 300);
  assert.equal(projected.group, 'subscription');
});

test('неизвестный ключ игнорируется при полосах снимка и создаётся без них', () => {
  const entry = snapshot();
  const ignored = accept(empty(), entry.bars, [bar('other', 9)]);
  const created = accept(empty(), [], [bar('other', 9)]);
  const failed = normalizeProviderUsage({ state: 'unavailable' });

  assert.equal(ignored.changed, false);
  assert.deepEqual(projectUsage(failed, created.state).bars, [bar('other', 9)]);
});

test('проекция сохраняет состояние и возраст неуспешного снимка', () => {
  const entry = {
    ...snapshot(),
    state: 'rate_limited',
    stale: true,
    retryAt: NOW + 60000
  };
  const { state } = accept(empty(), entry.bars, [bar('session', 8)]);
  const projected = projectUsage(entry, state);

  for (const key of ['state', 'dataCheckedAt', 'checkedAt', 'stale', 'retryAt', 'message', 'action']) {
    assert.deepEqual(projected[key], entry[key], key);
  }

  assert.deepEqual(projected.resources, entry.resources);
});

test('успешный опрос снимает только patch, существовавшие до его начала', () => {
  const entry = snapshot();
  const first = accept(empty(), entry.bars, [bar('session', 8)]);
  const second = accept(first.state, entry.bars, [bar('week', 30, NEXT)]);
  const settled = settlePoll(second.state, first.state.seq);

  assert.equal(settled.bars.has('session'), false);
  assert.equal(settled.bars.get('week').pct, 30);
  assert.equal(second.state.bars.has('session'), true, 'состояние до опроса неизменно');
});

test('сброс с микросекундами и округлённые секунды обозначают один замер', () => {
  const entry = snapshot();

  entry.bars[0].resetsAt = '2030-01-01T05:00:00.123456+00:00';

  const result = accept(empty(), entry.bars, [bar('session', 6)]);

  assert.equal(result.changed, false);
  assert.equal(result.state.seq, 0);
});

test('patch нормализует сотые и пропускает неверные полосы без исключений', () => {
  for (const patch of [null, {}, { bars: null }, { bars: [null, { key: 'session', pct: NaN }] }]) {
    assert.equal(acceptPatch(empty(), [], patch, { now: NOW }).changed, false);
  }

  const { state } = accept(empty(), [], [bar('session', 99.6)]);

  assert.equal(projectUsage(normalizeProviderUsage({ state: 'unavailable' }), state).bars[0].pct, 99.6);
});
