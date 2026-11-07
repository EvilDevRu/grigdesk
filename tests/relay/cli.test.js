import assert from 'node:assert/strict';
import test from 'node:test';

import { HELP_TEXT, parseCommand, versionLine } from '../../relay/src/cli.ts';

test('RL-29: разбор команд', () => {
  for (const [args, kind] of [
    [[], 'run'],
    [['--worker'], 'worker'],
    [['--healthcheck'], 'health'],
    [['--help'], 'help'],
    [['-h'], 'help'],
    [['--version'], 'version'],
    [['--license'], 'license'],
    [['--version', '--help'], 'error'],
    [['--worker', '--healthcheck'], 'error'],
    [['run'], 'error'],
    [['--HELP'], 'error'],
    [[''], 'error'],
  ]) {
    assert.equal(parseCommand(args).kind, kind, JSON.stringify(args));
  }
});

test('RL-30: ошибка не повторяет аргумент', () => {
  const result = parseCommand(['--token=секрет']);

  assert.equal(result.kind, 'error');
  assert.equal(result.message, 'Неизвестная команда. Справка: grigdesk-relay --help');
  assert.equal(result.message.includes('секрет'), false);
});

test('RL-31: справка и версия', () => {
  for (const text of ['--healthcheck', '--version', '--license', 'RELAY_PORT']) {
    assert.ok(HELP_TEXT.includes(text));
  }

  assert.equal(HELP_TEXT.includes('--worker'), false);
  assert.ok(HELP_TEXT.endsWith('\n'));
  assert.equal(
    versionLine('0.1.0', 'v24.21.0', 'linux', 'x64'),
    'grigdesk-relay 0.1.0 (Node v24.21.0, linux x64)',
  );
});
