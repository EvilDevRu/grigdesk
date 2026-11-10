import assert from 'node:assert/strict';
import test from 'node:test';

import type { TrackerSettingsField, TrackerSettingsSchema } from '../../shared/trackers/contracts.ts';
import { isTrackerSettingsSchema } from '../../shared/trackers/validation.ts';
import {
  isTrackerTokenField, isTrackerTokenInput, visibleTrackerTokenKeys,
} from '../../shared/trackers/settingsValidation.ts';

test('Токен объявляется схемой, прежняя общая подпись распознаётся без id поставщика', () => {
  const field: TrackerSettingsField = { type: 'string', secret: true };

  assert.equal(isTrackerTokenField({ ...field, format: 'api-token' }), true);
  assert.equal(isTrackerTokenField({ ...field, label: { key: 'core.trackerAccessToken' } }), true);
  assert.equal(isTrackerTokenField({ ...field, label: { key: 'core.trackerPassword' } }), false);
  assert.equal(isTrackerTokenField({ type: 'string', format: 'api-token' }), false);
  assert.equal(isTrackerSettingsSchema({ key: { ...field, format: 'api-token' } }), true);

  for (const invalid of [
    { type: 'string', format: 'api-token' },
    { ...field, format: 'unknown' },
    { type: 'number', format: 'api-token' },
    { type: 'boolean', format: 'api-token' },
  ]) {
    assert.equal(isTrackerSettingsSchema({ key: invalid }), false);
  }
});

test('Непрозрачный токен не имеет фиксированной длины или обязательного префикса', () => {
  for (const value of [
    '', 'a'.repeat(24), 'a'.repeat(32), 'ATATT' + 'a'.repeat(187),
    'a'.repeat(5000), 'opaque._~+/-token==', 'ATATTopaque==segment:fixture!',
    'opaque!$%&()*,:;<=>?@[\\]^`{|}token', 'пароль', 'Pass!word',
  ]) {
    assert.equal(isTrackerTokenInput(value), true);
  }

  for (const value of [
    ' password', 'password ', 'token\n', 'token\tvalue', 'Bearer token',
    '"token"', "'token'", 'https://tracker.invalid/token',
    'token\u0000value', 'token\u007fvalue', 'token\u200bvalue',
  ]) {
    assert.equal(isTrackerTokenInput(value), false);
  }
});

test('Режим пароля исключает скрытый токен из проверки', () => {
  const schema: TrackerSettingsSchema = {
    accessToken: {
      type: 'string',
      secret: true,
      format: 'api-token',
      visibleIf: { field: 'authMode', equals: 'token' },
    },
    password: { type: 'string', secret: true },
  };

  assert.deepEqual(visibleTrackerTokenKeys(schema, { authMode: 'password' }), []);
  assert.deepEqual(visibleTrackerTokenKeys(schema, { authMode: 'token' }), ['accessToken']);
});
