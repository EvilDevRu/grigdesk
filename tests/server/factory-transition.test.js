import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ManualStageTransitionError,
  manualStageTransitionPairs,
} from '../../server/src/lib/factoryTransition.ts';

const stages = ['BUILD', 'REVIEW', 'LINT', 'GATE_ACCEPT', 'SHIP'];

test('manual transition from acceptance gate sends a rewind control to the engine', () => {
  const registry = {
    BUILD: 'done',
    REVIEW: 'done',
    LINT: 'skipped',
    GATE_ACCEPT: 'waiting',
    SHIP: 'pending',
  };

  assert.deepEqual(
    manualStageTransitionPairs({ registry, stages, key: 'REVIEW', status: 'running' }),
    ['REVIEW', 'running', 'REWIND_STAGE', 'REVIEW'],
  );
});

test('manual transition cannot silently fork an already active pipeline', () => {
  const registry = {
    BUILD: 'done',
    REVIEW: 'running',
    LINT: 'pending',
    GATE_ACCEPT: 'pending',
  };

  assert.throws(
    () => manualStageTransitionPairs({ registry, stages, key: 'BUILD', status: 'running' }),
    (error) => error instanceof ManualStageTransitionError && error.code === 'pipeline_not_waiting',
  );
});

test('manual transition only targets a stage before the waiting gate', () => {
  const registry = { GATE_ACCEPT: 'waiting', SHIP: 'pending' };

  assert.throws(
    () => manualStageTransitionPairs({ registry, stages, key: 'SHIP', status: 'running' }),
    (error) => error instanceof ManualStageTransitionError && error.code === 'stage_after_gate',
  );
});

test('non-running force statuses keep the existing one-pair protocol', () => {
  assert.deepEqual(
    manualStageTransitionPairs({ registry: {}, stages, key: 'LINT', status: 'pending' }),
    ['LINT', 'pending'],
  );
});
