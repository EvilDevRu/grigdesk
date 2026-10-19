import assert from 'node:assert/strict';
import { normalizeSettings } from '../../../desktop/src/settings.ts';

/**
 * Отмена может опередить prepare: тогда весь старый файл остаётся неизменным.
 * Уже записанная миграция проверяется целиком, включая профиль, выбор и прежнюю геометрию.
 */
export function assertCancelledStartupSettings(before, saved, origin) {
  assert.deepEqual(saved.window, before.window);

  if (saved.version === before.version) {
    assert.deepEqual(saved, before);

    return;
  }

  assert.equal(saved.version, 2);
  assert.deepEqual(normalizeSettings(saved), saved);
  assert.equal(saved.profiles.length, 1);
  assert.equal(saved.profiles[0].kind, 'local');
  assert.equal(saved.profiles[0].address, origin);
  assert.ok(saved.selected === null || saved.selected === saved.profiles[0].id);
}
