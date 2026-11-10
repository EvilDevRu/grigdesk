import assert from 'node:assert/strict';
import test from 'node:test';

import { mountMultiBoard, SOURCE_A, SOURCE_B } from './helpers/trackerMultiView.js';
import { webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

test('MD-NUMERIC-PROJECTION: analysis[42] принадлежит только default B', async (t) => {
  const card = await mountMultiBoard(t, {
    analysis: { 42: { analysis: { risk: 9, complexity: 8 } } },
    compilerStubs: {
      './board/TriageBadge.vue': `export default {
        props: ['row'],
        template: '<span data-test-triage>{{ row?.analysis?.risk ?? "нет оценки" }}</span>',
      };`,
    },
  });
  const a = card.wrapper.findAll('li.trow').find((row) => row.text().includes('Задача A'));
  const b = card.wrapper.findAll('li.trow').find((row) => row.text().includes('Задача B'));

  assert.equal(a.get('[data-test-triage]').text(), 'нет оценки');
  assert.equal(b.get('[data-test-triage]').text(), '9');
});

test('MD-NUMERIC-PROJECTION: batch не запускает A42 через числовой default B', async (t) => {
  const calls = [];
  const card = await mountMultiBoard(t, {
    compilerStubs: {
      '../ui': `export * from ${JSON.stringify(webFile('src/ui.ts'))};
        export const confirmDialog = async () => true;`,
    },
  });

  card.stores.analysis().analyze = async (...args) => calls.push(args);
  await card.wrapper.get('.triage-all').trigger('click');
  await card.flushPromises();

  assert.equal(calls.length, 1);
  assert.equal(String(calls[0][0]), '42');
  assert.equal(calls.some((call) => JSON.stringify(call).includes(SOURCE_A)), false);
  assert.ok(JSON.stringify(calls[0]).includes(SOURCE_B), 'Batch передаёт подтверждённый source default');
});
