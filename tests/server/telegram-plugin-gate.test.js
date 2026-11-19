import assert from 'node:assert/strict';
import test from 'node:test';

import { SYSTEM, isEnabled } from '../../server/src/lib/pluginsRegistry.ts';

const byId = (id) => SYSTEM.find((m) => m.id === id);

test('телеграм есть в системном реестре и у него есть страница', () => {
  const m = byId('telegram');
  assert.ok(m, 'плагина telegram нет в SYSTEM');
  assert.equal(m.nav?.path, '/telegram');
});

test('все системные плагины включены по умолчанию и учитывают явное выключение', () => {
  for (const manifest of SYSTEM) {
    assert.equal(isEnabled({}, manifest), true, manifest.id);
    assert.equal(isEnabled({ plugins: { [manifest.id]: false } }, manifest), false, manifest.id);
  }
});

test('пользовательский плагин по-прежнему выключен по умолчанию', () => {
  const user = { id: 'my-plugin', system: false };
  assert.equal(isEnabled({}, user), false);
  assert.equal(isEnabled({ plugins: { 'my-plugin': true } }, user), true);
});
