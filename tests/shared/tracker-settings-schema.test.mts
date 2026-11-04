import assert from 'node:assert/strict';
import test from 'node:test';

import { isTrackerSettingsSchema } from '../../shared/trackers/validation.ts';

const select = {
  type: 'select',
  required: true,
  label: { key: 'core.trackerAuthMode' },
  options: [
    { value: 'token', label: { text: 'Токен' } },
    { value: 'password', label: { key: 'core.trackerAuthPassword' } },
  ],
};

test('Select: подписи, уникальные значения и прежние типы проходят контракт', () => {
  assert.equal(isTrackerSettingsSchema({
    authMode: select,
    login: { type: 'string', visibleIf: { field: 'authMode', equals: 'password' } },
    count: { type: 'number', visibleIf: { field: 'authMode', equals: '' } },
    enabled: { type: 'boolean' },
  }), true);
});

for (const options of [
  undefined, null, [], {}, ['token'],
  [{ value: '', label: { text: 'Пустой' } }],
  [{ value: ' ', label: { text: 'Пробел' } }],
  [{ value: 1, label: { text: 'Число' } }],
  [{ value: 'token' }],
  [{ value: 'token', label: 'Токен' }],
  [{
    value: 'token',
    label: { text: 'Токен' },
    script: 'alert(1)',
  }],
  [select.options[0], select.options[0]],
]) {
  test(`Select: повреждённые options ${JSON.stringify(options)} отклоняются`, () => {
    assert.equal(isTrackerSettingsSchema({ authMode: { ...select, options } }), false);
  });
}

for (const visibleIf of [
  null, [], {}, { field: '', equals: 'token' }, { field: 'authMode', equals: false },
  { field: 'authMode' }, {
    field: 'authMode',
    equals: 'token',
    expression: true,
  },
]) {
  test(`VisibleIf: повреждённое условие ${JSON.stringify(visibleIf)} отклоняется`, () => {
    assert.equal(isTrackerSettingsSchema({ login: { type: 'string', visibleIf } }), false);
  });
}

test('VisibleIf запрещён у boolean и select, options запрещены у обычного поля', () => {
  const visibleIf = { field: 'authMode', equals: 'token' };

  assert.equal(isTrackerSettingsSchema({ flag: { type: 'boolean', visibleIf } }), false);
  assert.equal(isTrackerSettingsSchema({ mode: { ...select, visibleIf } }), false);
  assert.equal(isTrackerSettingsSchema({ text: { type: 'string', options: select.options } }), false);
  assert.equal(isTrackerSettingsSchema({ text: { type: 'string', unknown: true } }), false);
});
