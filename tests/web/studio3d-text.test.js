import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as presentation from '../../web/src/features/studio3d/presentation.ts';

test('3D тексты отделяют числа пробелами в формах и ошибках просмотра', async () => {
  const files = [
    'views/studio3d/CreatePanel.vue',
    'views/studio3d/SheetCutter.vue',
    'shared/viewer3d/engine.ts',
    'shared/viewer3d/modelParser.ts',
    'shared/viewer3d/modelDisposal.ts',
    'shared/viewer3d/viewerMaterials.ts',
    'shared/viewer3d/viewerAnimation.ts',
    'shared/viewer3d/viewerBudget.ts',
    'shared/viewer3d/viewerLoading.ts',
    'shared/viewer3d/modelResources.ts',
    'shared/viewer3d/fbxResources.ts',
    'shared/viewer3d/splat.ts',
    'features/studio3d/creationRequest.ts',
    'features/studio3d/useCreationInputs.ts',
    'features/studio3d/useCreationQuote.ts',
    'features/studio3d/useCreationForm.ts',
    'features/studio3d/pendingIntentTypes.ts',
    'features/studio3d/pendingIntentController.ts',
    'stores/studio3d.ts'
  ];

  for (const file of files) {
    const text = await readFile(new URL(`../../web/src/${file}`, import.meta.url), 'utf8');

    assert.doesNotMatch(text, /[а-яА-ЯёЁ][0-9]|[0-9][а-яА-ЯёЁ]/, file);
  }
});

test('3D сводка склоняет кости и движения', () => {
  const text = presentation.statsText({
    triangles: 3,
    textures: [],
    bones: 1,
    animations: [{ name: 'Шаг' }, { name: 'Бег' }],
    size: null,
    facing: null
  });

  assert.match(text, /1 кость/);
  assert.match(text, /2 движения/);
});

test('3D сетевой отказ переводится, параметры получают русские подписи', () => {
  assert.equal(presentation.studioErrorMessage(new TypeError('Failed to fetch')), 'Нет связи с сервером');
  assert.equal(presentation.studioErrorMessage(new Error('signal timed out')), 'Нет связи с сервером');
  assert.deepEqual(presentation.parameterRows({
    category: 'character',
    view: 'front',
    rig_type: 'biped'
  }), [
    { name: 'Категория', value: 'персонаж' },
    { name: 'Вид', value: 'спереди' },
    { name: 'Тип тела', value: 'двуногий' }
  ]);
  assert.equal(presentation.providerLabel('tripo'), 'Tripo');
  assert.equal(presentation.taskTypeLabel('animate_rig'), 'Скелет');
  assert.deepEqual(presentation.parameterRows({ model: 'P1-20260311' }), [
    { name: 'Модель исполнителя', value: 'Быстрая модель P1' }
  ]);
});
