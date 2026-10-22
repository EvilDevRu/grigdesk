import assert from 'node:assert/strict';
import test from 'node:test';

import { applyProviderSetting, resolveProviderSettings } from '../../server/src/lib/providerSettings.ts';
import claude, {
  buildClaudeUntrustedArgs,
  claudeProviderSettingsArgs,
} from '../../server/src/lib/executors/claude.ts';
import codex from '../../server/src/lib/executors/codex.ts';
import kimi from '../../server/src/lib/executors/kimi.ts';
import deepseek from '../../server/src/lib/executors/deepseek.ts';

const EXECUTOR = {
  id: 'demo',
  name: 'Demo',
  settings: [
    { id: 'fastMode', kind: 'toggle', label: 'Ускоренный вывод', value: false },
    { id: 'window', kind: 'number', label: 'Окно', value: 10 },
  ],
};

const CONFIRMED_EXECUTOR = {
  id: 'guarded',
  name: 'Guarded',
  settings: [{
    id: 'blockDirectSsh',
    kind: 'toggle',
    label: 'Запретить прямой SSH',
    value: true,
    confirm: {
      off: {
        text: 'Агент сможет запускать прямой SSH без журнала инструмента.',
        label: 'Разрешить прямой SSH',
        danger: true,
      },
    },
  }],
};

function settingsPayload(args) {
  const index = args.indexOf('--settings');
  assert.notEqual(index, -1, 'Claude обязан получить --settings');
  return JSON.parse(args[index + 1]);
}

async function directSshPolicyOf(executor, config = {}) {
  const declaration = executor.directSshPolicy;
  return typeof declaration === 'function' ? declaration(config) : declaration;
}

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

test('опасное направление настройки без точного confirmed отклоняется без записи', async () => {
  const before = { guarded: { blockDirectSsh: true }, other: { keep: 'me' } };
  const applied = await applyProviderSetting(
    CONFIRMED_EXECUTOR,
    before,
    { settingId: 'blockDirectSsh', value: false, confirmed: 'true' },
  );

  assert.deepEqual({
    applied: { ok: applied.ok, error: applied.error },
    before,
  }, {
    applied: { ok: false, error: 'confirmation_required' },
    before: { guarded: { blockDirectSsh: true }, other: { keep: 'me' } },
  });
});

test('безопасное включение запрета сохраняется без confirmed', async () => {
  const applied = await applyProviderSetting(
    CONFIRMED_EXECUTOR,
    { guarded: { blockDirectSsh: false } },
    { settingId: 'blockDirectSsh', value: true },
  );

  assert.deepEqual({
    ok: applied.ok,
    value: applied.providerSettings?.guarded?.blockDirectSsh,
  }, {
    ok: true,
    value: true,
  });
});

test('точное confirmed сохраняет только значение, а не метаданные подтверждения', async () => {
  const applied = await applyProviderSetting(
    CONFIRMED_EXECUTOR,
    { other: { keep: 'me' } },
    { settingId: 'blockDirectSsh', value: false, confirmed: true },
  );

  assert.deepEqual(applied.providerSettings, {
    guarded: { blockDirectSsh: false },
    other: { keep: 'me' },
  });
});

test('декларация async-функцией: await-им её, config доезжает, range — число', async () => {
  // settings может быть функцией от config: потолок ползунка зависит от живого железа.
  const FN_EXECUTOR = {
    id: 'fn',
    name: 'Fn',
    settings: async (config) => [
      {
        id: 'window',
        kind: 'range',
        label: 'Окно',
        min: 2048,
        step: 1024,
        max: config?.max || 131072,
        value: 32768,
      },
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
  assert.deepEqual([
    settingsPayload(claudeProviderSettingsArgs({ fastMode: true })).fastMode,
    settingsPayload(claudeProviderSettingsArgs({ fastMode: false })).fastMode,
    settingsPayload(claudeProviderSettingsArgs()).fastMode,
  ], [true, false, false]);
});

test('Claude включает нативный deny и PreToolUse по умолчанию, а false снимает оба слоя', () => {
  const snapshot = [undefined, true, false].map((blockDirectSsh) => {
    const args = claudeProviderSettingsArgs(
      blockDirectSsh === undefined ? {} : { blockDirectSsh },
    );
    const payload = settingsPayload(args);
    return {
      nativeDeny: args.some((value, index) => (
        args[index - 1] === '--disallowedTools' && String(value).includes('Bash(ssh:*)')
      )),
      commandHook: JSON.stringify(payload.hooks || {}).includes('_direct-ssh-policy-hook.js'),
      overwritesUserDeny: Array.isArray(payload.permissions?.deny),
    };
  });

  assert.deepEqual(snapshot, [
    { nativeDeny: true, commandHook: true, overwritesUserDeny: false },
    { nativeDeny: true, commandHook: true, overwritesUserDeny: false },
    { nativeDeny: false, commandHook: false, overwritesUserDeny: false },
  ]);
});

test('model-only запуск Claude не получает SSH-hook', () => {
  const args = buildClaudeUntrustedArgs({ providerSettings: { blockDirectSsh: true } });
  assert.deepEqual({
    nativeDeny: args.includes('--disallowedTools'),
    commandHook: JSON.stringify(settingsPayload(args).hooks || {}).includes('PreToolUse'),
  }, { nativeDeny: false, commandHook: false });
});

test('четыре адаптера объявляют default-on настройку запрета прямого SSH', async () => {
  const declarations = await Promise.all([
    resolveProviderSettings(claude),
    resolveProviderSettings(codex),
    resolveProviderSettings(kimi, undefined, { kimiLaunchMode: 'host' }),
    resolveProviderSettings(deepseek),
  ]);

  assert.deepEqual(declarations.map((settings) => {
    const directSsh = settings.find((setting) => setting.id === 'blockDirectSsh');
    return [directSsh?.kind, directSsh?.value, directSsh?.confirm?.off?.danger];
  }), [
    ['toggle', true, true],
    ['toggle', true, true],
    ['toggle', true, true],
    ['toggle', true, true],
  ]);
});

for (const [name, executor, config] of [
  ['Claude', claude],
  ['Codex', codex],
  ['Kimi', kimi, { kimiLaunchMode: 'host' }],
  ['DeepSeek', deepseek],
]) {
  test(`${name} называет в подтверждении последствия снятия запрета`, async () => {
    const settings = await resolveProviderSettings(executor, undefined, config);
    const text = settings.find((setting) => setting.id === 'blockDirectSsh')?.confirm?.off?.text;

    assert.equal([
      'Агент сможет запускать прямые SSH-клиенты с правами процесса GrigDesk.',
      'Режим прав Bash не заменяет этот запрет.',
      'Подтверждений и журнала SSH-инструмента не будет.',
    ].every((consequence) => String(text || '').includes(consequence)), true);
  });
}

test('способ запрета объявляет сам адаптер с учётом режима Kimi', async () => {
  const policies = await Promise.all([
    directSshPolicyOf(claude),
    directSshPolicyOf(codex),
    directSshPolicyOf(deepseek),
    directSshPolicyOf(kimi, { kimiLaunchMode: 'contained' }),
    directSshPolicyOf(kimi, { kimiLaunchMode: 'host' }),
  ]);

  assert.deepEqual(policies.map((policy) => policy?.enforcement), [
    'command-hook',
    'command-hook',
    'command-hook',
    'network-sandbox',
    'command-broker',
  ]);
});

test('текст и справка сохраняют общий контракт настроек без снятого адаптера', async () => {
  const fake = {
    ...EXECUTOR,
    id: 'fake',
    settings: [
      {
        id: 'note',
        kind: 'text',
        label: 'Текст',
        value: 'Начальный текст',
      },
      {
        id: 'status',
        kind: 'info',
        label: 'Справка',
        value: 'Текущее состояние',
      },
    ],
  };
  const saved = {
    other: { keep: 'Сохранить' },
    'retired-provider': { note: 'Прежняя настройка', unknownKey: 17 },
    fake: { extra: 'Сохранить чужой ключ' },
  };
  const applied = await applyProviderSetting(
    fake,
    saved,
    { settingId: 'note', value: 'Новый текст' },
  );

  assert.equal(applied.ok, true);
  assert.equal(applied.providerSettings.fake.note, 'Новый текст');
  assert.equal(typeof applied.providerSettings.fake.note, 'string');
  assert.equal(applied.providerSettings.fake.extra, saved.fake.extra);
  assert.deepEqual(applied.providerSettings.other, saved.other);
  assert.deepEqual(applied.providerSettings['retired-provider'], saved['retired-provider']);
  assert.equal(Object.hasOwn(saved.fake, 'note'), false);

  const readonly = await applyProviderSetting(
    fake,
    applied.providerSettings,
    { settingId: 'status', value: 'Запись запрещена' },
  );
  const resolved = await resolveProviderSettings(fake, { status: 'Устаревшее значение' });

  assert.equal(readonly.ok, false);
  assert.equal(readonly.error, 'readonly_setting');
  assert.equal(resolved.find((setting) => setting.id === 'status').value, 'Текущее состояние');
});
