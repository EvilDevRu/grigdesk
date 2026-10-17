// Цепочки сцен: одна формула для сервера и экрана ролика. Проверяется, что
// цепочка режется по флагу продолжения в порядке показа, что первая сцена ролика
// продолжением не считается, и что предшественники сцены — именно её цепочка.
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';

const MODULE = webFile('../shared/plugins/showcase/showcaseChains.ts');

function scene(id, order, continuesPrevious = false) {
  return { id, order, continuesPrevious };
}

test('цепочка начинается на сцене без флага и идёт по порядку показа, а не хранения', async () => {
  const { sceneChains } = await compileModule(MODULE);
  const chains = sceneChains([
    scene('c', 3, true),
    scene('a', 1),
    scene('d', 4),
    scene('b', 2, true),
    scene('e', 5, true),
  ]);

  assert.deepEqual(
    chains.map((chain) => chain.map((item) => item.id)),
    [['a', 'b', 'c'], ['d', 'e']],
  );
});

test('первой сцене продолжать нечего: её флаг не в счёт', async () => {
  const { sceneChains, continuesPrevious, chainLineage } = await compileModule(MODULE);
  const scenes = [scene('a', 1, true), scene('b', 2, true), scene('c', 3)];

  assert.deepEqual(
    sceneChains(scenes).map((chain) => chain.map((item) => item.id)),
    [['a', 'b'], ['c']],
  );
  assert.equal(continuesPrevious(scenes, 'a'), false);
  assert.equal(continuesPrevious(scenes, 'b'), true);
  assert.equal(continuesPrevious(scenes, 'c'), false);
  assert.deepEqual(chainLineage(scenes, 'a'), []);
});

test('предшественники сцены — сцены её цепочки до неё, чужая цепочка не в счёт', async () => {
  const { chainLineage, chainOf } = await compileModule(MODULE);
  const scenes = [
    scene('a', 1),
    scene('b', 2, true),
    scene('c', 3, true),
    scene('d', 4),
    scene('e', 5, true),
  ];

  assert.deepEqual(chainLineage(scenes, 'c').map((item) => item.id), ['a', 'b']);
  assert.deepEqual(chainLineage(scenes, 'e').map((item) => item.id), ['d']);
  assert.deepEqual(chainLineage(scenes, 'd'), []);
  assert.deepEqual(chainOf(scenes, 'e').map((item) => item.id), ['d', 'e']);
  assert.deepEqual(chainOf(scenes, 'нет такой'), []);
});

test('сцена без поля читается как голова: старые записи цепочек не знают', async () => {
  const { sceneChains } = await compileModule(MODULE);
  const chains = sceneChains([
    { id: 'a', order: 1 },
    { id: 'b', order: 2, continuesPrevious: null },
    { id: 'c', order: 3, continuesPrevious: true },
  ]);

  assert.deepEqual(
    chains.map((chain) => chain.map((item) => item.id)),
    [['a'], ['b', 'c']],
  );
});
