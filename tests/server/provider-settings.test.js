import assert from 'node:assert/strict';
import test from 'node:test';

import { applyProviderSetting, resolveProviderSettings } from '../../server/src/lib/provider-settings.js';
import claude, { claudeProviderSettingsArgs } from '../../server/src/lib/executors/claude.js';
import ollama from '../../server/src/lib/executors/ollama.js';

const EXECUTOR = {
  id: 'demo',
  name: 'Demo',
  settings: [
    { id: 'fastMode', kind: 'toggle', label: 'Ускоренный вывод', value: false },
    { id: 'window', kind: 'number', label: 'Окно', value: 10 },
  ],
};

test('декларация исполнителя дополняется выбором человека, а не подменяется им', async () => {
  const fresh = await resolveProviderSettings(EXECUTOR, undefined);
  assert.deepEqual(fresh.map((s) => s.value), [false, 10]);

  const chosen = await resolveProviderSettings(EXECUTOR, { fastMode: true });
  assert.equal(chosen[0].value, true);
  assert.equal(chosen[0].label, 'Ускоренный вывод'); // подписи по-прежнему из executor-а
  assert.equal(chosen[1].value, 10); // нетронутая настройка остаётся дефолтной
});

test('в prefs попадают только объявленные исполнителем ключи', async () => {
  const rejected = await applyProviderSetting(EXECUTOR, {}, { settingId: 'rm -rf', value: true });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'unknown_setting');
});

test('значение приводится к типу настройки и не задевает других исполнителей', async () => {
  const applied = await applyProviderSetting(
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

test('декларация async-функцией (ollama-стиль): await-им её, config доезжает, range — число', async () => {
  // settings может быть функцией от config: потолок ползунка зависит от живого железа.
  const FN_EXECUTOR = {
    id: 'fn',
    name: 'Fn',
    settings: async (config) => [
      { id: 'window', kind: 'range', label: 'Окно', min: 2048, step: 1024, max: config?.max || 131072, value: 32768 },
    ],
  };
  const resolved = await resolveProviderSettings(FN_EXECUTOR, undefined, { max: 65536 });
  assert.equal(resolved[0].kind, 'range');
  assert.equal(resolved[0].max, 65536); // config доехал до функции-декларации
  assert.equal(resolved[0].value, 32768);

  // UI шлёт значение ползунка — в prefs оно обязано лечь числом, как у 'number'.
  const applied = await applyProviderSetting(FN_EXECUTOR, {}, { settingId: 'window', value: '65536' }, { max: 65536 });
  assert.equal(applied.ok, true);
  assert.equal(applied.providerSettings.fn.window, 65536);
  assert.equal(applied.settings.find((s) => s.id === 'window').value, 65536);

  const rejected = await applyProviderSetting(FN_EXECUTOR, {}, { settingId: 'temp', value: 1 }, { max: 65536 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'unknown_setting');
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

test('настройки Ollama: numCtx приводится к числу, чужой ключ отклоняется', async () => {
  const declared = (await ollama.settings()).map((s) => [s.id, s.kind]);
  assert.deepEqual(declared, [['host', 'text'], ['numCtx', 'range']]);

  // UI шлёт значение ползунка строкой — в prefs оно обязано лечь числом.
  const applied = await applyProviderSetting(ollama, {}, { settingId: 'numCtx', value: '16384' });
  assert.equal(applied.ok, true);
  assert.equal(applied.providerSettings.ollama.numCtx, 16384);
  assert.equal(applied.settings.find((s) => s.id === 'numCtx').value, 16384);
  assert.equal(applied.settings.find((s) => s.id === 'host').value, 'http://127.0.0.1:11434');

  // Текстовый host проходит как есть, соседние исполнители не задеваются.
  const withHost = await applyProviderSetting(
    ollama,
    { claude: { fastMode: true } },
    { settingId: 'host', value: 'http://192.168.1.10:11434' },
  );
  assert.equal(withHost.providerSettings.ollama.host, 'http://192.168.1.10:11434');
  assert.deepEqual(withHost.providerSettings.claude, { fastMode: true });

  const rejected = await applyProviderSetting(ollama, {}, { settingId: 'temperature', value: 0.7 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'unknown_setting');
});
