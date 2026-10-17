import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CREDIT_FORMS,
  OPERATIONS,
  formatPrice,
  isFieldVisible,
  normalizeValues,
  operationSpec,
  operationsFor,
  outputKind,
  pluralForm,
  refineKind,
} from '../../shared/studio3d/studio3dOperations.ts';

const FIELDS = [
  {
    id: 'texture',
    kind: 'toggle',
    label: 'Текстура',
    default: true
  },
  {
    id: 'quality',
    kind: 'select',
    label: 'Качество',
    default: 'standard',
    options: [
      {
        value: 'standard',
        label: 'Обычное'
      },
      {
        value: 'detailed',
        label: 'HD'
      },
    ],
    visibleWhen: [{
      field: 'texture',
      is: [true]
    }],
  },
  {
    id: 'faces',
    kind: 'number',
    label: 'Граней',
    min: 48,
    max: 20000,
    step: 1
  },
  {
    id: 'prompt',
    kind: 'textarea',
    label: 'Описание',
    required: true,
    maxLength: 10
  },
];

test('VO-01 словарь: id уникальны, у каждого действия группа, входы и подсказка', () => {
  const ids = OPERATIONS.map((operation) => operation.id);

  assert.equal(new Set(ids).size, ids.length);
  assert.ok(OPERATIONS.every((operation) => {
    return operation.label && operation.hint && operation.inputs.length > 0;
  }));
  assert.equal(operationSpec('rig')?.output, 'rigged');
  assert.equal(operationSpec('teleport'), null);
});

test('VO-02 что можно сделать с версией каждого вида', () => {
  const start = operationsFor('start').map((operation) => operation.id);
  const rigged = operationsFor('rigged').map((operation) => operation.id);

  assert.ok(start.includes('text-to-model') && start.includes('views-to-model'));
  assert.ok(!start.includes('rig'));
  assert.deepEqual(rigged, ['uv-unwrap', 'animate', 'export', 'rotate', 'scale']);
  assert.deepEqual(operationsFor('splat'), []);
});

test('VO-03 вид результата: same наследует вход, проверка версии не создаёт', () => {
  assert.equal(outputKind(operationSpec('rotate'), 'animated'), 'animated');
  assert.equal(outputKind(operationSpec('rig-check'), 'model'), 'check');
  assert.equal(outputKind(operationSpec('segment'), 'model'), 'parts');
});

test('VO-04 сводка уточняет вид модели', () => {
  assert.equal(refineKind('model', {
    bones: 41,
    animations: []
  }), 'rigged');
  assert.equal(refineKind('model', {
    bones: 41,
    animations: [{ name: 'walk' }]
  }), 'animated');
  assert.equal(refineKind('parts', { bones: 3 }), 'parts');
  assert.equal(refineKind('rigged', null), 'rigged');
});

test('VO-05 скрытое поле не уходит исполнителю, обязательное проверяется', () => {
  const shown = normalizeValues(FIELDS, {
    texture: true,
    quality: 'detailed',
    prompt: 'кот'
  });
  const hidden = normalizeValues(FIELDS, {
    texture: false,
    quality: 'nonsense',
    prompt: ''
  });

  assert.deepEqual(shown.values, {
    texture: true,
    quality: 'detailed',
    faces: null,
    prompt: 'кот'
  });
  assert.deepEqual(shown.errors, []);
  assert.equal('quality' in hidden.values, false);
  assert.deepEqual(hidden.errors.map((issue) => issue.field), ['prompt']);
  assert.equal(isFieldVisible(FIELDS[1], { texture: false }), false);
});

test('VO-06 числа, списки и длина текста проверяются, а не подменяются', () => {
  const result = normalizeValues(FIELDS, {
    faces: '20001',
    prompt: 'слишком длинное описание'
  });
  const fraction = normalizeValues(FIELDS, {
    faces: '100,5',
    prompt: 'кот'
  });

  assert.deepEqual(result.errors.map((issue) => issue.field), ['faces', 'prompt']);
  assert.equal(fraction.errors[0].message, '«Граней»: нужно целое число.');
});

test('VO-07 склонение и цена на кнопке', () => {
  assert.deepEqual([1, 2, 5, 11, 21, 22, 112, 2.5].map((amount) => pluralForm(amount, CREDIT_FORMS)), [
    'кредит',
    'кредита',
    'кредитов',
    'кредитов',
    'кредит',
    'кредита',
    'кредитов',
    'кредита',
  ]);
  assert.equal(formatPrice(30, CREDIT_FORMS), '30 кредитов');
  assert.equal(formatPrice(null, CREDIT_FORMS), 'цена неизвестна');
  assert.equal(formatPrice(0, null), 'бесплатно');
});

test('FIX-07 ноль бесплатен при любой единице, неизвестная цена не бесплатна', () => {
  assert.equal(formatPrice(0, CREDIT_FORMS), 'бесплатно');
  assert.equal(formatPrice(null, null), 'цена неизвестна');
  assert.equal(formatPrice(2.5, CREDIT_FORMS), '2,5 кредита');
});
