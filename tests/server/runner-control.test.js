import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FactoryRunnerControl,
  RunnerControlInputError,
} from '../../server/src/lib/runner-control.js';

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
