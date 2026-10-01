import assert from 'node:assert/strict';
import test from 'node:test';

import schema from '../fixtures/executor-settings/synthetic-v1.json' with { type: 'json' };
import types from '../fixtures/executor-settings/types.json' with { type: 'json' };
import { normalizeJsonSchema } from '../../server/src/lib/executorSettings/jsonSchema.ts';
import { validateNativeSetting } from '../../server/src/lib/executorSettings/validation.ts';
import { overlayNativeSettings } from '../../server/src/lib/executorSettings/values.ts';

test('boolean принимает false и отклоняет строку без приведения типов', () => {
  const fields = normalizeJsonSchema(schema, {
    path: [],
    writeChannel: {
      id: 'overlay',
      scope: 'cockpit-chats',
      state: 'verified',
    },
    ownership: [],
  });

  assert.equal(validateNativeSetting(fields, '["enabled"]', false), null);
  assert.equal(validateNativeSetting(fields, '["enabled"]', 'false')?.code, 'invalid_value');
});

test('наложение не мутирует native base, заменяет массив и не принимает опасные сегменты', () => {
  const base = { group: { enabled: true, neighbor: 7 }, tags: ['old'] };
  const overrides = [
    { path: ['group', 'enabled'], value: false },
    { path: ['tags'], value: ['new'] },
  ];
  const result = overlayNativeSettings(base, overrides);

  assert.deepEqual(result, { group: { enabled: false, neighbor: 7 }, tags: ['new'] });
  assert.deepEqual(base, { group: { enabled: true, neighbor: 7 }, tags: ['old'] });
  assert.equal(overrides[0].value, false);

  for (const segment of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => overlayNativeSettings(base, [{ path: [segment, 'polluted'], value: true }]));
  }

  assert.equal(Object.prototype.polluted, undefined);
  assert.throws(() => overlayNativeSettings(base, [{ path: ['tags', '0'], value: 'bad' }]));
});

test('валидация сохраняет JSON-типы enum и проверяет границы, кратность и длину', () => {
  const fields = normalizeJsonSchema(types, {
    path: [],
    writeChannel: {
      id: 'overlay',
      scope: 'cockpit-chats',
      state: 'verified',
    },
    ownership: [],
  });
  const cases = [
    ['count', 0, true],
    ['count', 1, false],
    ['count', 2.5, false],
    ['count', 12, false],
    ['ratio', 0, false],
    ['ratio', Infinity, false],
    ['text', '', true],
    ['text', 'a'.repeat(21), false],
    ['choice', 1, true],
    ['choice', '1', true],
    ['choice', false, false],
    ['nullable', null, true],
  ];

  for (const [key, value, expected] of cases) {
    assert.equal(validateNativeSetting(fields, JSON.stringify([key]), value) === null, expected, key);
  }
});

test('лист проверяется после наложения на native base и не обходит required предка', () => {
  const fields = normalizeJsonSchema(
    {
      type: 'object',
      properties: {
        group: {
          type: 'object',
          required: ['neighbor'],
          properties: { value: { type: 'boolean' }, neighbor: { type: 'string' } },
        },
      },
    },
    {
      path: [],
      writeChannel: {
        id: 'overlay',
        scope: 'cockpit-chats',
        state: 'verified',
      },
      ownership: [],
      base: { group: {} },
    },
  );

  assert.equal(validateNativeSetting(fields, '["group","value"]', false)?.code, 'invalid_value');
  assert.equal(validateNativeSetting(fields, '["group","neighbor"]', '') === null, true);
  assert.equal(validateNativeSetting(fields, '["group"]', {})?.code, 'readonly_field');
});

test('enum не отменяет объявленный тип и целочисленность значения', () => {
  const fields = normalizeJsonSchema(
    {
      type: 'object',
      properties: {
        count: { type: 'integer', enum: [1, 1.5] },
        text: { type: 'string', enum: ['1', 1] },
      },
    },
    {
      path: [],
      ownership: [],
      writeChannel: {
        id: 'fixture',
        scope: 'cockpit-chats',
        state: 'verified',
      },
    },
  );

  assert.equal(validateNativeSetting(fields, '["count"]', 1), null);
  assert.equal(validateNativeSetting(fields, '["count"]', 1.5)?.code, 'invalid_value');
  assert.equal(validateNativeSetting(fields, '["text"]', '1'), null);
  assert.equal(validateNativeSetting(fields, '["text"]', 1)?.code, 'invalid_value');
});
