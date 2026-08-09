// Реестр — вторичная проекция, и в нём легально остаётся `running` у узла, чей заход
// прервали (TERM демону, перезапуск хоста). Тогда активных узлов становится два, и
// правило линейности обязано оставить более поздний — реальный фронт. Раньше оно гасило
// и его тоже (ветка `i < keep ? 'done' : 'pending'` при i === keep даёт 'pending'), и
// работающий конвейер выглядел в схеме полностью остановившимся.
import test from 'node:test';
import assert from 'node:assert/strict';

import { computeNodeStatuses } from '../../server/src/lib/factory-graph.js';

const POS = {
  chairman: [0, 0], proof: [1, 0], translator: [2, 0], tests: [3, 0], build: [4, 0],
};

test('прерванный узел гаснет, а живой фронт остаётся активным', () => {
  const st = computeNodeStatuses({
    pf: {
      CATALOG_PROTOCOL: 'route-v2',
      CHAIRMAN: 'running', // заход прервали, проекция не переписана
      PROOF: 'pending',
      TRANSLATOR: 'done',
      TESTS: 'running', // реальный фронт
      BUILD: 'pending',
    },
    pos: POS, keys: {}, optional: [], mtimeMs: null,
  });
  assert.equal(st.tests, 'run');
  assert.equal(st.chairman, 'done');
  assert.equal(st.build, 'pending');
});

test('единственный активный узел правило не трогает', () => {
  const st = computeNodeStatuses({
    pf: {
      CATALOG_PROTOCOL: 'route-v2', CHAIRMAN: 'done', PROOF: 'done', TRANSLATOR: 'done', TESTS: 'running',
    },
    pos: POS, keys: {}, optional: [], mtimeMs: null,
  });
  assert.equal(st.tests, 'run');
});

test('пауза ворот переживает соседний застрявший running', () => {
  // wait идёт по той же ветке, что и run: ворота — тоже «фронт», гасить их нельзя,
  // иначе человек не увидит, что маршрут ждёт лично его.
  const st = computeNodeStatuses({
    pf: {
      CATALOG_PROTOCOL: 'route-v2',
      CHAIRMAN: 'running',
      PROOF: 'done',
      TRANSLATOR: 'done',
      TESTS: 'waiting',
    },
    pos: POS, keys: {}, optional: [], mtimeMs: null,
  });
  assert.equal(st.tests, 'wait');
  assert.equal(st.chairman, 'done');
});
