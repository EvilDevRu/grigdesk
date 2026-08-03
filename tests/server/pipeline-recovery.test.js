import assert from 'node:assert/strict';
import test from 'node:test';

import { recoveryDecision } from '../../server/src/lib/pipeline-recovery.js';

const running = {
  WF_STATUS: 'running',
  PROFILE: 'arsenkin',
  ROUTE: 'feature',
  PLAN: 'running',
};

test('dead active pipeline is resumed after Cockpit startup', () => {
  const decision = recoveryDecision({
    registry: running,
    daemonAlive: false,
    profileAvailable: true,
    now: 10_000,
  });
  assert.equal(decision.action, 'resume');
  assert.equal(decision.reason, 'crashed');
  assert.equal(decision.nextCount, 1);
});

test('recovery never crosses human gates or semantic stop flags', () => {
  for (const registry of [
    { ...running, GATE_PLAN: 'waiting' },
    { ...running, STALLED_HUMAN: '1' },
  ]) {
    const decision = recoveryDecision({
      registry,
      daemonAlive: false,
      profileAvailable: true,
      now: 10_000,
    });
    assert.notEqual(decision.action, 'resume');
  }
});

test('recovery ignores live, completed and closed pipelines', () => {
  const cases = [
    { registry: running, daemonAlive: true },
    { registry: { ...running, RETRO: 'done' }, daemonAlive: false },
    { registry: { ...running, WF_STATUS: 'stopped' }, daemonAlive: false },
  ];
  for (const item of cases) {
    const decision = recoveryDecision({
      ...item,
      profileAvailable: true,
      now: 10_000,
    });
    assert.equal(decision.action, 'skip');
  }
});

test('missing local profile and restart loop request human attention', () => {
  const missing = recoveryDecision({
    registry: running,
    daemonAlive: false,
    profileAvailable: false,
    now: 10_000,
  });
  assert.equal(missing.action, 'attention');
  assert.equal(missing.reason, 'profile_missing');

  const loop = recoveryDecision({
    registry: {
      ...running,
      RECOVERY_RESTARTS: '3',
      RECOVERY_WINDOW_AT: '9000',
    },
    daemonAlive: false,
    profileAvailable: true,
    now: 10_000,
    maxRestarts: 3,
    windowMs: 60_000,
  });
  assert.equal(loop.action, 'attention');
  assert.equal(loop.reason, 'restart_limit');
});

test('restart budget resets after a quiet recovery window', () => {
  const decision = recoveryDecision({
    registry: {
      ...running,
      RECOVERY_RESTARTS: '3',
      RECOVERY_WINDOW_AT: '1000',
    },
    daemonAlive: false,
    profileAvailable: true,
    now: 100_000,
    maxRestarts: 3,
    windowMs: 60_000,
  });
  assert.equal(decision.action, 'resume');
  assert.equal(decision.nextCount, 1);
  assert.equal(decision.windowAt, 100_000);
});
