import assert from 'node:assert/strict';
import test from 'node:test';

import * as values from '../../shared/plugins/pluginInstallValues.ts';
import { PLUGIN_ID_RE } from '../../server/src/lib/pluginsRegistry.ts';

const UUID = '01234567-89ab-4def-8abc-0123456789ab';

/**
 * Версии и варианты выводятся из явно синтетической базы, а не из runtime identity.
 * Производные значения сохраняют проверку полного домена UUID, включая неверные биты.
 */
function uuid(version, variant = '8') {
  return UUID.replace('-4def-', `-${version}def-`).replace('-8abc-', `-${variant}abc-`);
}

const cases = [
  ['isInstallUuid', [UUID, uuid('8', '9').toUpperCase()],
    [uuid('0'), uuid('9'), uuid('4', '7'), UUID + '\n']],
  ['isInstallSha', ['a'.repeat(40), 'f'.repeat(64)], ['a'.repeat(39), 'a'.repeat(65), 'A'.repeat(40)]],
  ['isInstallDigest', ['a'.repeat(64)], ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64)]],
  ['isInstallPluginId', ['demo', 'a'.repeat(41), 'a-b_c'],
    ['constructor', 'prototype', '__proto__', 'a'.repeat(42), 'Demo', 'demo\n', 'ä']],
  ['isInstallTimestamp', ['2024-02-29T00:00:00.000Z'],
    ['2026-02-30T00:00:00.000Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000+00:00']],
  ['isInstallJobKind', ['install', 'update', 'rollback'], ['Install', 'erase', 'install\n']],
  ['isInstallJobStatus', ['running', 'ready', 'awaiting_restart', 'applying', 'done', 'failed', 'cancelled',
    'interrupted', 'recovery_required'], ['success', 'DONE', 'done\n']],
  ['isInstallStage', ['fetching', 'validating', 'dependencies'], ['npm', 'FETCHING', 'fetching\n']],
  ['isInstallTerminalStatus', ['done', 'failed', 'cancelled', 'interrupted'],
    ['recovery_required', 'ready', 'awaiting_restart', 'DONE']],
  ['isInstallPreparedStatus', ['ready', 'awaiting_restart', 'applying', 'done'],
    ['recovery_required', 'running', 'READY']],
];

for (const [name, valid, invalid] of cases) {
  test(`Общие значения: ${name} сохраняет домен и тип`, () => {
    for (const input of valid) {
      assert.equal(values[name](input), true, String(input));
    }

    for (const input of [...invalid, null, undefined, 42, {}, []]) {
      assert.equal(values[name](input), false, String(input));
    }
  });
}

test('Общий UUID допускает все версии 1–8', () => {
  for (const version of ['1', '2', '3', '4', '5', '6', '7', '8']) {
    assert.equal(values.isInstallUuid(uuid(version)), true);
  }
});

test('Общий текст сохраняет явный предел, пустую строку и запрет NUL', () => {
  assert.equal(values.isInstallText('', 0), true);
  assert.equal(values.isInstallText('а'.repeat(4), 4), true);
  assert.equal(values.isInstallText('а'.repeat(5), 4), false);
  assert.equal(values.isInstallText('а\0', 4), false);

  for (const input of [null, undefined, 42, {}, []]) {
    assert.equal(values.isInstallText(input, 4096), false);
  }
});

test('Общий id совпадает с manifest regex и отказом от prototype имён', () => {
  for (const id of ['demo', 'constructor', 'prototype', '__proto__', 'a'.repeat(41),
    'a'.repeat(42), 'Demo', 'demo\n', 'ä']) {
    assert.equal(values.isInstallPluginId(id), PLUGIN_ID_RE.test(id)
      && !['constructor', 'prototype', '__proto__'].includes(id), id);
  }
});

test('Пять списков общих значений сохраняют явный состав', () => {
  assert.deepEqual(values.INSTALL_JOB_KINDS, ['install', 'update', 'rollback']);
  assert.deepEqual(values.INSTALL_JOB_STATUSES, [
    'running', 'ready', 'awaiting_restart', 'applying', 'done', 'failed', 'cancelled',
    'interrupted', 'recovery_required',
  ]);
  assert.deepEqual(values.INSTALL_STAGES, ['fetching', 'validating', 'dependencies']);
  assert.deepEqual(values.INSTALL_TERMINAL_STATUSES, ['done', 'failed', 'cancelled', 'interrupted']);
  assert.deepEqual(values.INSTALL_PREPARED_STATUSES, ['ready', 'awaiting_restart', 'applying', 'done']);
});
