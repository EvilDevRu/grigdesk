import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { closeSync, statSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  openServerLog,
  readUnitState,
  runVpnGate,
  spawnServer,
} from '../../desktop/src/serverProcess.ts';

const SYNTHETIC_RUNTIME = {
  root: '/fixture/project',
  node: '/fixture/node',
  port: 9300,
  origin: 'http://127.0.0.1:9300',
  env: { SYNTHETIC_SECRET: 'fixture-secret-value' },
  graceMs: 45_000,
  logPath: '/fixture/server.log',
};

test('PR-01 spawn получает системный Node, точные опции и IPC, без секретов в argv', () => {
  const calls = [];
  const child = new EventEmitter();
  const result = spawnServer(SYNTHETIC_RUNTIME, 123, (...args) => {
    calls.push(args);

    return child;
  });

  assert.equal(result, child);
  assert.deepEqual(calls, [[SYNTHETIC_RUNTIME.node, ['/fixture/project/server/src/app.ts'], {
    cwd: '/fixture/project/server',
    env: SYNTHETIC_RUNTIME.env,
    stdio: ['ignore', 123, 123, 'ipc'],
    serialization: 'json',
    detached: false,
    shell: false,
  }]]);
  assert.equal(JSON.stringify(calls[0][1]).includes('fixture-secret-value'), false);
});

test('PR-02 журнал создаётся 0600, ротируется свыше 10 МБ и открывается на дозапись', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-server-log-'));
  const log = path.join(root, 'nested/server.log');

  t.after(() => rm(root, { recursive: true, force: true }));

  let fd = openServerLog(log);

  try {
    writeSync(fd, 'первая строка\n');
  } finally {
    closeSync(fd);
  }

  assert.equal(statSync(log).mode & 0o777, 0o600);
  fd = openServerLog(log);

  try {
    writeSync(fd, 'вторая строка\n');
  } finally {
    closeSync(fd);
  }

  assert.equal(await readFile(log, 'utf8'), 'первая строка\nвторая строка\n');
  await writeFile(log, Buffer.alloc(10 * 1024 * 1024 + 1, 65));
  fd = openServerLog(log);

  try {
    writeSync(fd, 'после ротации\n');
  } finally {
    closeSync(fd);
  }

  assert.equal(statSync(log + '.1').size, 10 * 1024 * 1024 + 1);
  assert.equal(await readFile(log, 'utf8'), 'после ротации\n');
});

/**
 * Создаёт собственный скрипт вместо рабочих VPN-ворот.
 * Окружение полностью задаётся фикстурой и не содержит параметров живого сервера.
 */
async function gateRuntime(t, script, extraEnv = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-vpn-gate-'));

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'deploy'));
  await writeFile(path.join(root, 'deploy/require-vpn.sh'), script);

  return {
    ...SYNTHETIC_RUNTIME,
    root,
    env: {
      PATH: '/usr/bin:/bin',
      ...extraEnv,
    },
  };
}

test('PR-03 настоящие ворота возвращают код и последнюю непустую строку своего stderr', async (t) => {
  const runtime = await gateRuntime(t, [
    '#!/usr/bin/env bash',
    'printf "начало\\n\\n" >&2',
    'printf "%s\\n\\n" "$GATE_VALUE" >&2',
    'exit 7',
  ].join('\n'), { GATE_VALUE: 'окружение фикстуры' });
  const result = await runVpnGate(runtime, new AbortController().signal);

  assert.deepEqual(result, {
    code: 7,
    lastLine: 'окружение фикстуры',
  });
});

test('PR-04 отмена ворот посылает SIGTERM только своему процессу и даёт code 1', async (t) => {
  const runtime = await gateRuntime(t, [
    '#!/usr/bin/env bash',
    'trap \'printf SIGTERM > "$SIGNAL_FILE"; exit 0\' TERM',
    'printf "готов\\n" >&2',
    'while :; do sleep 0.05; done',
  ].join('\n'));
  const marker = path.join(runtime.root, 'signal.txt');

  runtime.env.SIGNAL_FILE = marker;

  const controller = new AbortController();
  let child;
  let exited;
  let signalReady;
  const ready = new Promise((resolve) => {
    signalReady = resolve;
  });

  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  });

  const result = runVpnGate(runtime, controller.signal, (...args) => {
    child = spawn(...args);
    exited = once(child, 'exit');
    child.stderr.once('data', signalReady);

    return child;
  });

  await ready;
  controller.abort();

  let timer;
  const completed = await Promise.race([
    result,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), 300);
    }),
  ]);

  clearTimeout(timer);
  assert.equal(completed?.code, 1);
  await exited;
  assert.equal(await readFile(marker, 'utf8'), 'SIGTERM');
});

test('PR-05 снимок службы обрезает пробелы, ошибки и таймаут дают unavailable', async () => {
  for (const [error, stdout, expected] of [
    [null, 'active\n', 'active'],
    [null, '  inactive \n', 'inactive'],
    [{ code: 'ENOENT' }, '', 'unavailable'],
    [{ killed: true }, '', 'unavailable'],
  ]) {
    const signal = new AbortController().signal;
    const state = await readUnitState(signal, (file, args, options, callback) => {
      assert.equal(file, 'systemctl');
      assert.deepEqual(args, [
        '--user', 'show', 'grigdesk-server.service', '--property=ActiveState', '--value',
      ]);
      assert.equal(options.timeout, 5000);
      assert.equal(options.signal, signal);
      callback(error, stdout, '');

      return new EventEmitter();
    });

    assert.equal(state, expected);
  }
});
