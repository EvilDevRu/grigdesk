// Плагин «Телеграм» — СИСТЕМНЫЙ (ему нужны своя страница, адаптер трекера и
// запуск конвейера; пользовательские заперты в /api/ext/<id>/ и фронтовых
// страниц не имеют вовсе), но по умолчанию ВЫКЛЮЧЕН.
//
// Само по себе одно другому противоречит: `isEnabled` при отсутствии ключа в
// prefs возвращает «системный → включён», и раздел с живыми роутами появился бы
// у всех установок без спроса — вместе с полем для токена бота. Поэтому у
// манифеста есть `defaultEnabled`, и этот тест сторожит именно умолчание:
// потерять его легко, а заметить — только по чужому кокпиту.
import assert from 'node:assert/strict';
import test from 'node:test';

import { SYSTEM, isEnabled } from '../../server/src/lib/pluginsRegistry.ts';

const byId = (id) => SYSTEM.find((m) => m.id === id);

test('телеграм есть в системном реестре и у него есть страница', () => {
  const m = byId('telegram');
  assert.ok(m, 'плагина telegram нет в SYSTEM');
  assert.equal(m.nav?.path, '/telegram');
});

test('по умолчанию выключен — пока человек не включит его сам', () => {
  assert.equal(byId('telegram').defaultEnabled, false);
  assert.equal(isEnabled({}, byId('telegram')), false);
});

test('прежние системные плагины умолчание не потеряли', () => {
  for (const id of ['video', 'code']) {
    assert.equal(isEnabled({}, byId(id)), true, `${id} перестал включаться по умолчанию`);
  }
});

test('явный выбор человека сильнее умолчания — в обе стороны', () => {
  assert.equal(isEnabled({ plugins: { telegram: true } }, byId('telegram')), true);
  assert.equal(isEnabled({ plugins: { code: false } }, byId('code')), false);
});

test('пользовательский плагин по-прежнему выключен по умолчанию', () => {
  const user = { id: 'my-plugin', system: false };
  assert.equal(isEnabled({}, user), false);
  assert.equal(isEnabled({ plugins: { 'my-plugin': true } }, user), true);
});
