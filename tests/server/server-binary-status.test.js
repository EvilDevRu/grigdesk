import assert from 'node:assert/strict';
import test from 'node:test';

import { factoryStatusBoundaryArgs } from '../../server/src/lib/factoryStatusArgs.ts';

test('SB-STATUS: следующий stage проходит только полным result ведущего', () => {
  assert.deepEqual(factoryStatusBoundaryArgs({ result: 'done' }, ''), []);

  const value = {
    result: 'failed',
    nextStage: true,
    stageClosed: ['fixture-1'],
    stageSummary: 'Готово',
  };

  assert.deepEqual(factoryStatusBoundaryArgs(value, 'lead'), [
    '--next-stage', '--stage-closed', 'fixture-1', '--stage-summary', 'Готово',
  ]);
  assert.throws(() => factoryStatusBoundaryArgs(value, 'worker'));
  assert.throws(() => factoryStatusBoundaryArgs({ ...value, stageClosed: [] }, 'lead'));
  assert.throws(() => factoryStatusBoundaryArgs({ ...value, result: 'done' }, 'lead'));
  assert.throws(() => factoryStatusBoundaryArgs({ ...value, stageSummary: 'one\ntwo' }, 'lead'));
  assert.throws(() => factoryStatusBoundaryArgs({ result: 'done', stageClosed: null }, 'lead'));
  assert.throws(() => factoryStatusBoundaryArgs({ result: 'done', stageSummary: null }, 'lead'));
  assert.throws(() => factoryStatusBoundaryArgs({ result: 'done', nextStage: 'true' }, 'lead'));
});
