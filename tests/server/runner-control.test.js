import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FactoryRunnerControl,
  RunnerControlInputError,
} from '../../server/src/lib/runnerControl.ts';

test('runner control invokes only the canonical factory switch command', async () => {
  const calls = [];
  const control = new FactoryRunnerControl({
    factoryBin: '/repo/engine/bin/factory',
    stateDir: '/state',
    configRoot: '/config',
    profilesDir: '/repo/profiles',
    run: async (...args) => { calls.push(args); return { stdout: 'ok\n', stderr: '' }; },
  });

  const result = await control.switch({ task: '42', stage: 'BUILD', target: 'codex' });
  assert.deepEqual(result, { ok: true, output: 'ok' });
  assert.equal(calls[0][0], '/repo/engine/bin/factory');
  assert.deepEqual(calls[0][1], ['42', 'runner', 'switch', 'BUILD', 'codex']);
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][2].env.STATE_DIR, '/state');
  assert.equal(calls[0][2].env.FACTORY_CONFIG_ROOT, '/config');
  assert.equal(calls[0][2].env.FACTORY_PROFILES_DIR, '/repo/profiles');
});

test('runner control rejects command injection before spawning', async () => {
  let called = false;
  const control = new FactoryRunnerControl({
    factoryBin: '/factory',
    stateDir: '/state',
    configRoot: '/config',
    run: async () => { called = true; },
  });
  await assert.rejects(
    control.switch({ task: '42;rm', stage: 'BUILD', target: 'codex' }),
    RunnerControlInputError,
  );
  await assert.rejects(
    control.switch({ task: '42', stage: 'BUILD', target: 'codex;rm' }),
    RunnerControlInputError,
  );
  assert.equal(called, false);
});

test('runner control builds canonical set/clear stage override commands', async () => {
  const calls = [];
  const control = new FactoryRunnerControl({
    factoryBin: '/repo/engine/bin/factory',
    stateDir: '/state',
    configRoot: '/config',
    profilesDir: '/repo/profiles',
    run: async (...args) => { calls.push(args); return { stdout: 'ok\n', stderr: '' }; },
  });

  const set = await control.setStage({ task: '42', stage: 'BUILD', primary: 'codex' });
  assert.deepEqual(set, { ok: true, output: 'ok' });
  assert.deepEqual(calls[0][1], ['42', 'runner', 'set', 'BUILD', 'codex']);
  assert.equal(calls[0][0], '/repo/engine/bin/factory');
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][2].timeout, 15_000);
  assert.equal(calls[0][2].env.STATE_DIR, '/state');
  assert.equal(calls[0][2].env.FACTORY_CONFIG_ROOT, '/config');
  assert.equal(calls[0][2].env.FACTORY_PROFILES_DIR, '/repo/profiles');

  const cleared = await control.clearStage({ task: '42', stage: 'BUILD' });
  assert.deepEqual(cleared, { ok: true, output: 'ok' });
  assert.deepEqual(calls[1][1], ['42', 'runner', 'clear', 'BUILD']);
  assert.equal(calls[1][2].timeout, 15_000);
  assert.equal(calls[1][2].env.STATE_DIR, '/state');
});

test('runner control rejects malformed set/clear input before spawning', async () => {
  let called = false;
  const control = new FactoryRunnerControl({
    factoryBin: '/factory',
    stateDir: '/state',
    configRoot: '/config',
    run: async () => { called = true; },
  });
  await assert.rejects(
    control.setStage({ task: '42;rm', stage: 'BUILD', primary: 'codex' }),
    RunnerControlInputError,
  );
  await assert.rejects(
    control.setStage({ task: '42', stage: 'build', primary: 'codex' }),
    RunnerControlInputError,
  );
  await assert.rejects(
    control.setStage({ task: '42', stage: 'BUILD', primary: 'codex;rm' }),
    RunnerControlInputError,
  );
  await assert.rejects(
    control.clearStage({ task: '42', stage: 'build;rm' }),
    RunnerControlInputError,
  );
  assert.equal(called, false);
});
