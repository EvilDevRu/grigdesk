import test from 'node:test';
import assert from 'node:assert/strict';
import { stopRouteOrchestrator } from '../../server/src/lib/factory-route-cli.js';

const runOk = async () => ({ ok: true, message: '' });
const runNoSystemd = async () => ({ ok: false, message: 'systemctl: command not found' });

test('stop on a dead orchestrator is a no-op', async () => {
  let ran = false;
  const res = await stopRouteOrchestrator({
    task: '42', orchPid: '100', isAlive: () => false,
    run: async () => { ran = true; return runOk(); },
  });
  assert.deepEqual(res, { ok: true, outcome: 'not_running' });
  assert.equal(ran, false);
});

test('stop via systemd unit waits for the daemon to die', async () => {
  let alive = true;
  const calls = [];
  const res = await stopRouteOrchestrator({
    task: '42', orchPid: '100', isAlive: () => alive, stepMs: 1,
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      alive = false; // юнит погасил оркестратор
      return { ok: true, message: '' };
    },
  });
  assert.deepEqual(res, { ok: true, outcome: 'stopped' });
  assert.deepEqual(calls, [['systemctl', '--user', 'stop', 'factory-t42']]);
});

test('without systemd the orchestrator gets a direct TERM', async () => {
  let alive = true;
  const killed = [];
  const res = await stopRouteOrchestrator({
    task: '42', orchPid: '100', isAlive: () => alive, stepMs: 1,
    run: runNoSystemd,
    kill: (pid) => { killed.push(pid); alive = false; },
  });
  assert.deepEqual(res, { ok: true, outcome: 'stopped' });
  assert.deepEqual(killed, [100]);
});

test('a daemon that outlives the grace period reports stop_sent, not success', async () => {
  const res = await stopRouteOrchestrator({
    task: '42', orchPid: '100', isAlive: () => true, waitMs: 5, stepMs: 1,
    run: runOk,
  });
  assert.deepEqual(res, { ok: true, outcome: 'stop_sent' });
});

test('failure of both unit stop and TERM is an error with the unit message', async () => {
  const res = await stopRouteOrchestrator({
    task: '42', orchPid: '100', isAlive: () => true, waitMs: 5, stepMs: 1,
    run: runNoSystemd,
    kill: () => { throw new Error('ESRCH'); },
  });
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'stop_sent');
  assert.equal(res.message, 'systemctl: command not found');
});
