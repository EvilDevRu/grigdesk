import assert from 'node:assert/strict';
import test from 'node:test';
import {
  lines, batchValidation, batchRows, runRequest,
} from '../../web/src/features/studio3d/creationRequest.ts';

const selected = { 
  provider: 'tripo', 
  operation: 'text-to-model', 
  quote: { total: 40 } 
};

test('CR-01 строки prompt и предел 50 сохраняют значения формы', () => {
  const cases = [
    ['', []],
    ['  кот  \r\n\n  лампа\n ', ['кот', 'лампа']],
    [null, []],
    [123, ['123']],
  ];

  for (const [prompt, expected] of cases) {
    assert.deepEqual(lines({ prompt }), expected);
  }

  for (const count of [0, 1, 50, 51]) {
    const values = { prompt: Array(count).fill('кот').join('\n') };
    const validation = batchValidation(values);

    assert.equal(validation.values, values);
    assert.deepEqual(validation.errors, count > 50
      ? [{ field: 'prompt', message: 'Пачка содержит максимум 50 строк.' }] : []);
    assert.deepEqual(validation.warnings, []);
  }
});

test('CR-02 строки пачки сохраняют общие параметры, имена и ожидаемую цену', () => {
  for (const [name, project, category, names] of [
    ['', '', '', ['кот', 'лампа']],
    ['  Набор  ', 'project', 'prop', ['Набор 1', 'Набор 2']],
    ['я'.repeat(200), '', '', ['я'.repeat(196) + ' 1', 'я'.repeat(196) + ' 2']],
  ]) {
    const values = Object.freeze({ prompt: ' кот\nлампа ', texture: true });

    assert.deepEqual(batchRows({ 
      selected, 
      values, 
      name, 
      project, 
      category 
    }), [
      { 
        provider: 'tripo', 
        operation: 'text-to-model', 
        values: { prompt: 'кот', texture: true },
        name: names[0], 
        project: project || null, 
        category: category || null, 
        expectedPrice: 40 
      },
      { 
        provider: 'tripo', 
        operation: 'text-to-model', 
        values: { prompt: 'лампа', texture: true },
        name: names[1], 
        project: project || null, 
        category: category || null, 
        expectedPrice: 40 
      },
    ]);
  }

  const input = { 
    values: { prompt: 'x'.repeat(90) }, 
    name: '', 
    project: '', 
    category: '' 
  };

  assert.equal(batchRows({ ...input, selected })[0].name, 'x'.repeat(80));
  assert.throws(() => batchRows({ ...input, selected: undefined }), /Цена пока не опубликована\./);
  assert.throws(() => batchRows({ ...input, selected: { ...selected, quote: { total: null } } }),
    /Цена пока не опубликована\./);
  assert.equal(batchRows({ ...input, selected: { ...selected, quote: { total: 0 } } })[0].expectedPrice, 0);
});

test('CR-03 одиночный запрос копирует нормализацию и сохраняет uploads/metadata', () => {
  for (const normalized of [undefined, { prompt: 'нормализовано', parts: ['body'] }]) {
    const values = { prompt: 'черновик', parts: ['head'] };
    const uploads = [{ role: 'primary', uploadId: 'upload-one' }];
    const result = runRequest({ 
      selected, 
      values, 
      normalizedValues: normalized, 
      expectedPrice: 0,
      uploads, 
      name: '  Модель  ', 
      project: 'project', 
      category: 'prop' 
    });

    assert.deepEqual(result, {
      provider: 'tripo', 
      operation: 'text-to-model', 
      values: normalized ?? values, 
      expectedPrice: 0,
      uploads: [{ role: 'primary', uploadId: 'upload-one' }], 
      name: 'Модель',
      project: 'project', 
      category: 'prop',
    });
    assert.notEqual(result.values, normalized ?? values);
    assert.notEqual(result.values.parts, (normalized ?? values).parts);
    assert.equal(result.uploads, uploads);
  }

  assert.deepEqual(runRequest({ 
    selected, 
    values: {}, 
    expectedPrice: 40, 
    uploads: [],
    name: ' ', 
    project: '', 
    category: '' 
  }), {
    provider: 'tripo', 
      operation: 'text-to-model', 
      values: {}, 
      expectedPrice: 40,
    uploads: [], 
      project: null, 
      category: null,
  });
});
