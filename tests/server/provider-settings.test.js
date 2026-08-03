import assert from 'node:assert/strict';
import test from 'node:test';

import { applyProviderSetting, resolveProviderSettings } from '../../server/src/lib/provider-settings.js';
import claude, { claudeProviderSettingsArgs } from '../../server/src/lib/executors/claude.js';

const EXECUTOR = {
  id: 'demo',
  name: 'Demo',
  settings: [
    { id: 'fastMode', kind: 'toggle', label: 'Ускоренный вывод', value: false },
    { id: 'window', kind: 'number', label: 'Окно', value: 10 },
  ],
};

test('декларация исполнителя дополняется выбором человека, а не подменяется им', () => {
  const fresh = resolveProviderSettings(EXECUTOR, undefined);
  assert.deepEqual(fresh.map((s) => s.value), [false, 10]);

  const chosen = resolveProviderSettings(EXECUTOR, { fastMode: true });
  assert.equal(chosen[0].value, true);
  assert.equal(chosen[0].label, 'Ускоренный вывод'); // подписи по-прежнему из executor-а
  assert.equal(chosen[1].value, 10); // нетронутая настройка остаётся дефолтной
});

test('в prefs попадают только объявленные исполнителем ключи', () => {
  const rejected = applyProviderSetting(EXECUTOR, {}, { settingId: 'rm -rf', value: true });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'unknown_setting');
});

test('значение приводится к типу настройки и не задевает других исполнителей', () => {
  const applied = applyProviderSetting(
    EXECUTOR,
    { other: { keep: 'me' }, demo: { window: 10 } },
    { settingId: 'fastMode', value: 'да' },
  );
  assert.equal(applied.ok, true);
  assert.equal(applied.providerSettings.demo.fastMode, true); // toggle — булево, не строка
  assert.equal(applied.providerSettings.demo.window, 10);
  assert.deepEqual(applied.providerSettings.other, { keep: 'me' });
  assert.equal(applied.settings.find((s) => s.id === 'fastMode').value, true);
});

test('ускоренный вывод Claude объявлен выключенным и переключаемым', () => {
  const fast = (claude.settings || []).find((s) => s.id === 'fastMode');
  assert.ok(fast, 'Claude объявляет настройку fastMode');
  assert.equal(fast.kind, 'toggle');
  assert.equal(fast.value, false);          // выключено по умолчанию…
  assert.notEqual(fast.disabled, true);     // …но именно выключено, а не заблокировано
  assert.doesNotMatch(fast.label, /×|\b\d+(?:\.\d+)?\b/);
  assert.doesNotMatch(fast.hint, /Opus\s+\d|\b\d+\.\d+\b/);
});

test('настройка fastMode явно передаётся каждому headless-запуску Claude', () => {
  assert.deepEqual(claudeProviderSettingsArgs({ fastMode: true }), [
    '--settings',
    '{"fastMode":true}',
  ]);
  assert.deepEqual(claudeProviderSettingsArgs({ fastMode: false }), [
    '--settings',
    '{"fastMode":false}',
  ]);
  assert.deepEqual(claudeProviderSettingsArgs(), [
    '--settings',
    '{"fastMode":false}',
  ]);
});
