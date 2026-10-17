import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import tls from 'node:tls';
import { promisify } from 'node:util';

import { readConfig } from '../../relay/src/config.ts';
import { createRelayServer } from '../../relay/src/relayServer.ts';
import { checkHealth } from '../../relay/src/runtime.ts';
import { makeCert, relayEnv, temporary } from './helpers.js';

const execute = promisify(execFile);
const modules = ['runtime', 'supervision', 'cli'];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Резервирует порт через ОС и освобождает его перед запуском отдельного процесса.
 * Фиксированные порты работающего посредника не используются.
 */
async function freePort() {
  const server = net.createServer();

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const port = server.address().port;

  await new Promise((resolve) => server.close(resolve));

  return port;
}

/**
 * Проверяет существование только PID, полученного от собственного процесса.
 * ESRCH означает завершение, остальные ошибки не маскируются.
 */
function alive(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    assert.equal(error.code, 'ESRCH');

    return false;
  }
}

test('RL-38: импорт модулей запуска без побочных эффектов', async () => {
  for (const name of modules) {
    const url = new URL(`../../relay/src/${name}.ts`, import.meta.url).href;
    const result = await execute(process.execPath, [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(url)}); process.stdout.write('ok');`,
    ], {
      env: { PATH: process.env.PATH },
      timeout: 5000,
    });

    assert.equal(result.stdout, 'ok');
    assert.equal(result.stderr, '');
  }
});

test('RL-39: checkHealth проверяет исправный сервер и закрытый порт', async (t) => {
  const cert = await makeCert(await temporary(t), 'health');
  const server = createRelayServer({
    ...readConfig(relayEnv({ cert })),
    port: 0,
  }, { log: () => {} });
  const port = await server.listen('127.0.0.1');

  t.after(() => server.close());
  assert.equal(await checkHealth(String(port)), 0);
  await server.close();
  assert.equal(await checkHealth(String(port)), 1);
});

test('RL-39/неверные порты: отказ без вызова TLS', async (t) => {
  let calls = 0;

  t.mock.method(tls, 'connect', () => {
    calls += 1;

    throw new Error('сеть не должна открываться');
  });

  for (const value of ['0', '70000', 'abc', '', '08']) {
    assert.equal(await checkHealth(value), 1);
  }

  assert.equal(calls, 0);
});

test('RL-39/отрицательный ответ и молчание: ограниченное ожидание', async (t) => {
  const cert = await makeCert(await temporary(t), 'silent');

  for (const response of ['{"ok":false}\n', null]) {
    const sockets = new Set();
    const server = tls.createServer({
      key: cert.keyPem,
      cert: cert.certPem,
    }, (socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('data', () => {
        if (response !== null) {
          socket.write(response);
        }
      });
    });

    t.after(() => {
      for (const socket of sockets) {
        socket.destroy();
      }

      server.close();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const started = Date.now();

    assert.equal(await checkHealth(String(server.address().port)), 1);
    assert.ok(Date.now() - started < 4000);

    for (const socket of sockets) {
      socket.destroy();
    }

    await new Promise((resolve) => server.close(resolve));
  }
});

test('RL-40: рабочий процесс выходит при потере IPC', { timeout: 15000 }, async (t) => {
  const cert = await makeCert(await temporary(t), 'orphan');
  const port = await freePort();
  const main = new URL('../../relay/src/main.ts', import.meta.url).pathname;
  const code = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [${JSON.stringify(main)}], {
      stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    });
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening')) {
        process.stdout.write('pid=' + child.pid + '\\n');
      }
    });
  `;
  const parent = spawn(process.execPath, ['-e', code], {
    env: {
      PATH: process.env.PATH,
      ...relayEnv({
        cert,
        overrides: { RELAY_PORT: String(port) },
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let pid;

  t.after(() => {
    parent.kill('SIGKILL');

    if (pid && alive(pid)) {
      process.kill(pid, 'SIGKILL');
    }
  });

  const output = await Promise.race([
    once(parent.stdout, 'data').then(([chunk]) => chunk.toString()),
    pause(5000).then(() => {
      throw new Error('нет listening от рабочей части');
    }),
  ]);

  pid = Number(output.match(/pid=(\d+)/)?.[1]);
  assert.ok(pid > 0);
  parent.kill('SIGKILL');

  const deadline = Date.now() + 5000;

  while (alive(pid) && Date.now() < deadline) {
    await pause(50);
  }

  assert.equal(alive(pid), false, 'ребёнок остался жить после смерти сторожа');

  const listener = net.createServer();

  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => listener.close(resolve));
});
