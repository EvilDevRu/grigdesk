import assert from 'node:assert/strict';
import test from 'node:test';
import { versionFailure } from '../../desktop/src/pipe/versionGate.ts';

test('версия API: major, минимальный minor, обязательный заголовок и исключение 101', () => {
  for (const [header, expected] of [
    ['0.1', null],
    ['0.2', null],
    ['1.0', 'client_upgrade_required'],
    ['0.0', 'server_upgrade_required'],
    [undefined, 'server_upgrade_required'],
    ['bad', 'server_upgrade_required'],
  ]) {
    assert.equal(versionFailure({ major: 0, minor: 1 }, header), expected);
  }

  assert.equal(versionFailure({ major: 1, minor: 0 }, '0.9'), 'server_upgrade_required');
  assert.equal(versionFailure({ major: 0, minor: 1 }, undefined, 101), null);
});
