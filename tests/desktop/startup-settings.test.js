import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCancelledStartupSettings } from './e2e/startup-settings.mjs';
import { normalizeSettings } from '../../desktop/src/settings.ts';

const origin = 'http://127.0.0.1:12345';
const before = {
  version: 1,
  connection: null,
  window: {
    width: 1111,
    height: 777,
    maximized: true
  },
};

test('R11: отмена до prepare оставляет полный прежний файл v1', () => {
  assert.doesNotThrow(() => assertCancelledStartupSettings(before, structuredClone(before), origin));
  assert.throws(() => assertCancelledStartupSettings(before, { ...before, connection: {} }, origin));
});

test('R11: отмена после атомарной записи принимает проверенный профиль v2 без смены геометрии', () => {
  const saved = normalizeSettings({ ...before, connection: { kind: 'local', origin } });

  assert.doesNotThrow(() => assertCancelledStartupSettings(before, saved, origin));
  assert.doesNotThrow(() => assertCancelledStartupSettings(before, { ...saved, selected: null }, origin));
  assert.throws(() => assertCancelledStartupSettings(before, {
    ...saved, window: { ...saved.window, width: 1280 },
  }, origin));
  assert.throws(() => assertCancelledStartupSettings(before, { ...saved, profiles: [] }, origin));
});
