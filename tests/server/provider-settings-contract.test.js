import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeProviderSettingsCatalog,
  decodeProviderSettingsOverrideRequest,
  decodeSettingsValueSlot,
} from '../../shared/chat/providerSettingsContracts.ts';

import catalog from '../fixtures/executor-settings/synthetic-catalog.json' with { type: 'json' };

test('wire сохраняет явный boolean false отдельно от отсутствующего override', () => {
  assert.deepEqual(decodeSettingsValueSlot({ state: 'known', value: false }), {
    state: 'known',
    value: false,
  });
});

test('set и unset проверяют наличие value, ревизии и отсутствие команды клиента', () => {
  const request = {
    fieldId: '["enabled"]',
    revision: '0',
    schemaRevision: 'v1',
    operation: 'set',
    value: null,
  };

  assert.equal(decodeProviderSettingsOverrideRequest(request).value, null);
  assert.equal(
    decodeProviderSettingsOverrideRequest({
      fieldId: request.fieldId,
      revision: '0',
      schemaRevision: null,
      operation: 'unset',
    }).operation,
    'unset',
  );

  for (const malformed of [
    { ...request, schemaRevision: null },
    { ...request, revision: undefined },
    { ...request, command: 'ignored' },
    { ...request, operation: 'replace' },
    { ...request, operation: 'unset' },
    {
      fieldId: request.fieldId,
      revision: '0',
      schemaRevision: 'v1',
      operation: 'set',
    },
  ]) {
    assert.throws(() => decodeProviderSettingsOverrideRequest(malformed));
  }
});

test('неизвестный вид остаётся read-only и сохраняет известного соседа', () => {
  const value = structuredClone(catalog);

  value.fields.push({
    ...value.fields[0],
    id: '["future"]',
    path: ['future'],
    kind: 'new-kind',
    private: 'sentinel',
  });

  const result = decodeProviderSettingsCatalog(value);

  assert.equal(result.fields[1].kind, 'unknown');
  assert.equal(result.fields[1].writable, false);
  assert.equal(result.fields[0].writable, true);
  assert.equal(JSON.stringify(result).includes('sentinel'), false);
});

test('redacted slot не принимает value в постороннем поле', () => {
  assert.deepEqual(decodeSettingsValueSlot({ state: 'redacted', present: true }), {
    state: 'redacted',
    present: true,
  });
  assert.throws(() => decodeSettingsValueSlot({ state: 'redacted', payload: { value: 'sentinel' } }));
});

test('wire принимает каталог пятого исполнителя с boolean без override', () => {
  const parsed = decodeProviderSettingsCatalog(catalog);

  assert.equal(parsed.providerId, 'future-provider');
  assert.equal(parsed.fields[0]?.kind, 'boolean');
  assert.deepEqual(parsed.fields[0]?.override, { state: 'unset' });
});

test('wire различает ноль, пустую строку, null и unset', () => {
  const results = [0, '', null].map((value) => {
    try {
      return decodeSettingsValueSlot({ state: 'known', value });
    } catch {
      return { state: 'unknown' };
    }
  });

  assert.deepEqual(
    results,
    [0, '', null].map((value) => ({ state: 'known', value })),
  );
  assert.deepEqual(decodeSettingsValueSlot({ state: 'unset' }), { state: 'unset' });
});

test('каталог передаёт вложенный typed enum и его ограничения без приватной схемы', () => {
  const input = structuredClone(catalog);
  const leaf = {
    ...input.fields[0],
    id: '["group","choice"]',
    path: ['group', 'choice'],
    kind: 'enum',
    constraints: { enum: ['1', 1, true, null], nullable: true },
    description: 'Выбор',
    reason: 'Владелец',
    owner: 'Модель',
    schema: { secret: 'sentinel' },
  };

  input.fields = [
    {
      ...input.fields[0],
      kind: 'object',
      writable: false,
      children: [leaf],
    },
  ];

  const result = decodeProviderSettingsCatalog(input);

  assert.deepEqual(result.fields[0]?.children?.[0]?.constraints.enum, ['1', 1, true, null]);
  assert.equal(result.fields[0]?.children?.[0]?.owner, 'Модель');
  assert.equal(JSON.stringify(result).includes('sentinel'), false);
});
