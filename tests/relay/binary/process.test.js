import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { makeCert, relayEnv, temporary } from '../helpers.js';
import {
  childPids,
  copyBinary,
  freePort,
  pidExists,
  portIsFree,
  signalPid,
  startRelay,
  waitFor,
} from './helpers.js';

let binary;
let removeBinary;

after(() => removeBinary?.());
before(async () => {
  binary = await copyBinary({ after: (cleanup) => {
    removeBinary = cleanup;
  } });
});

/**
 * Создаёт отдельную пару сторож/worker и сохраняет только её дочерний PID.
 * Синтетические настройки и свободный порт изолируют проверку от живого сервера.
 */
async function fixture(t, overrides = {}) {
  const cert = await makeCert(await temporary(t), 'sea-process');
  const port = await freePort();
  const env = relayEnv({
    cert,
    overrides: {
      RELAY_PORT: String(port),
      ...overrides,
    },
  });
  const relay = await startRelay(t, {
    binary,
    env,
  });
  const children = await childPids(relay.pid);

  assert.equal(children.length, 1, 'ожидается ровно одна рабочая часть');

  return {
    ...relay,
    worker: children[0],
    port,
  };
}

test('RS-09: штатная остановка по SIGTERM и SIGINT', { timeout: 20000 }, async (t) => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    await t.test(signal, async (t) => {
      const box = await fixture(t);

      box.child.kill(signal);
      await waitFor(() => box.child.exitCode !== null, 7000);
      assert.equal((await box.exited).code, 0);
      assert.equal(pidExists(box.worker), false);
      assert.equal(await portIsFree(box.port), true);
    });
  }
});

test('RS-10: падение рабочей части даёт код 1', { timeout: 10000 }, async (t) => {
  const box = await fixture(t);

  signalPid(box.worker, 'SIGKILL');
  await waitFor(() => box.child.exitCode !== null, 5000);
  assert.equal((await box.exited).code, 1);
  assert.equal(pidExists(box.worker), false);
  assert.equal(await portIsFree(box.port), true);
});

test('RS-11: зависание рабочей части ограничено внешним watchdog', { timeout: 16000 }, async (t) => {
  const box = await fixture(t, { RELAY_WATCHDOG_MS: '3000' });
  const started = Date.now();

  signalPid(box.worker, 'SIGSTOP');
  await waitFor(() => box.child.exitCode !== null, 12000);
  assert.equal((await box.exited).code, 1);
  assert.ok(Date.now() - started < 12000);
  assert.equal(pidExists(box.worker), false);
  assert.equal(await portIsFree(box.port), true);
});

test('RS-12: смерть сторожа закрывает рабочую часть и порт', { timeout: 10000 }, async (t) => {
  const box = await fixture(t);
  const started = Date.now();

  box.child.kill('SIGKILL');
  await waitFor(() => !pidExists(box.worker), 5000);
  assert.equal((await box.exited).signal, 'SIGKILL');
  assert.ok(Date.now() - started < 5000);
  assert.equal(await portIsFree(box.port), true);
});
