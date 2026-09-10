// Отклонённая приёмка возвращает курсор на build, но реестр — вторичная проекция:
// узлы хвоста остаются `done` с прошлого круга, а GATE_ACCEPT — `rejected`. Доинференс
// точки возврата поверх этого рисовал работу на давно пройденном build, уводил реально
// идущий следом узел в pending и занижал прогресс, а через пять минут после последней
// записи реестра объявлял build ждущим человека: карточка задачи желтела целиком, хотя
// ворот, требующих решения, не было и чип «ждут тебя» её законно не считал.
import test from 'node:test';
import assert from 'node:assert/strict';

import { computeNodeStatuses } from '../../server/src/lib/factoryGraph.ts';

// Хвост маршрута с приёмкой, порядок — как в цепочке машины.
const POS = {
  build: [0, 0], review: [1, 0], measure: [2, 0], lint: [3, 0], gate_accept: [4, 0], ship: [5, 0],
};

// Реальное состояние задачи 8162 после возврата: хвост остался пройденным с прошлого
// круга, ворота — rejected, маршрут идёт вторым кругом и стоит на review.
const REJECTED_REGISTRY = {
  CATALOG_PROTOCOL: 'route-v2',
  BUILD: 'done',
  REVIEW: 'done',
  MEASURE: 'done',
  LINT: 'done',
  GATE_ACCEPT: 'rejected',
  SHIP: 'pending',
};

const STALE = Date.now() - 30 * 60 * 1000; // окно «недавней записи» давно истекло

test('при известном курсоре пройденный build остаётся пройденным, а хвост за курсором гаснет', () => {
  const st = computeNodeStatuses({
    pf: REJECTED_REGISTRY,
    pos: POS,
    keys: {},
    optional: [],
    mtimeMs: STALE,
    cursorNode: 'review',
  });

  assert.equal(st.build, 'done');
  assert.equal(st.measure, 'pending');
  assert.equal(st.lint, 'pending');
  assert.equal(st.gate_accept, 'pending');
  assert.equal(st.ship, 'pending');
});

test('истёкшее окно записи не превращает пройденный узел в ожидание человека', () => {
  const st = computeNodeStatuses({
    pf: REJECTED_REGISTRY,
    pos: POS,
    keys: {},
    optional: [],
    mtimeMs: STALE,
    cursorNode: 'review',
  });

  // Жёлтый `wait` означает «работа стоит на человеке»; здесь стоять не на чем.
  assert.equal(Object.values(st).filter((v) => v === 'wait').length, 0);
});

test('узел курсора остаётся на досветку журнала, а не уезжает в pending', () => {
  const st = computeNodeStatuses({
    pf: REJECTED_REGISTRY,
    pos: POS,
    keys: {},
    optional: [],
    mtimeMs: STALE,
    cursorNode: 'review',
  });

  // getTaskGraph красит узел курсора по состоянию журнала (`ready` при живом демоне →
  // run, `paused` → wait). Затерев его здесь в pending, схема гасила идущий этап.
  assert.notEqual(st.review, 'pending');
});

test('без курсора историческое поведение сохранено: точка возврата активна', () => {
  const fresh = computeNodeStatuses({
    pf: { ...REJECTED_REGISTRY, CATALOG_PROTOCOL: 'route-v1' },
    pos: POS,
    keys: {},
    optional: [],
    mtimeMs: Date.now(),
    cursorNode: null,
  });
  assert.equal(fresh.build, 'run');
  assert.equal(fresh.measure, 'pending');

  const stale = computeNodeStatuses({
    pf: { ...REJECTED_REGISTRY, CATALOG_PROTOCOL: 'route-v1' },
    pos: POS,
    keys: {},
    optional: [],
    mtimeMs: STALE,
    cursorNode: null,
  });
  assert.equal(stale.build, 'wait');
});
