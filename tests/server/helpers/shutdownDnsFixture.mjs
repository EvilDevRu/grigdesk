import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { build } from '../../../server/node_modules/esbuild/lib/main.js';
import { isolatedFetchWithLimits } from '../../../server/src/lib/isolatedFetch.ts';
import { prepareBrowserSocket } from '../../../server/src/lib/browser/browserSocketDirectory.ts';
import { callBotApi } from '../../../server/src/lib/telegram/api.ts';

const [mode, root] = process.argv.slice(2);
const source = fileURLToPath(new URL('../../../', import.meta.url));
const resolver = path.join(root, 'resolv.conf');
const sockets = new Set();
const questions = [];

await fs.writeFile(resolver, 'nameserver 127.0.0.1\noptions use-vc timeout:2 attempts:2\n');
execFileSync('mount', ['--make-rprivate', '/']);
execFileSync('ip', ['link', 'set', 'lo', 'up']);
execFileSync('mount', ['--bind', resolver, '/etc/resolv.conf']);

// Все адреса и TCP DNS принадлежат новому network namespace. Ответов DNS нет.
// Наблюдение закрытия соединения подтверждает освобождение native getaddrinfo.
const dns = net.createServer((socket) => {
  sockets.add(socket);
  socket.on('data', (chunk) => questions.push(chunk.length));
  socket.once('close', () => sockets.delete(socket));
});

dns.listen(53, '127.0.0.1');
await once(dns, 'listening');

/**
 * Ожидание ограничено собственным сценарием и содержит понятную причину отказа.
 * Чужие процессы, сеть и состояние приложения фикстура не исследует.
 */
async function until(condition, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;

  while (!await condition()) {
    assert.ok(Date.now() < deadline, 'Сценарий не подтвердил ожидаемое событие');
    await delay(10);
  }
}

/**
 * После SIGKILL остаётся stale inode, который штатная проверка сокета убирает.
 * Второе поколение действительно начинает слушать тот же путь.
 */
async function nextStart(file) {
  await prepareBrowserSocket(file);

  const next = net.createServer((socket) => socket.destroy());

  next.listen(file);
  await once(next, 'listening');
  await assert.rejects(prepareBrowserSocket(file), /browser_socket_busy/u);
  await new Promise((resolve) => next.close(resolve));
}

/**
 * DNS начинается в самом worker, а exit-event фиксирует оставшиеся native requests.
 * Код payload используется и прямо, и через настоящий bootstrap launcher-а.
 */
function payload(coordinated, exitCode) {
  return `
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
exports.startPayloadServer = async () => {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(${JSON.stringify(path.join(root, 'relay.sock'))}, resolve));
  const factory = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore', detached: true, env: {},
  });
  factory.unref();
  process.on('exit', () => fs.writeFileSync(${JSON.stringify(path.join(root, 'exit.json'))},
    JSON.stringify(process._getActiveRequests().map((r) => r.constructor.name))));
  await fetch('https://worker.shutdown-fixture.invalid/', { signal: AbortSignal.timeout(150) })
    .catch(() => {});
  process.send({ type: 'ready', factory: factory.pid, pid: process.pid });
  ${coordinated ? `
  const { createShutdownCoordinator } = await import(${JSON.stringify(
    path.join(source, 'server/src/lib/shutdown.ts'))});
  const shutdown = createShutdownCoordinator({ close: async () => {}, timeoutMs: 500 });
  await shutdown.begin('фикстура native cleanup', ${exitCode});
  ` : 'process.exit(1);'}
};
`;
}

/**
 * Контроль без сторожа доказывает native зависание, исправленный путь ограничивает его.
 * Launcher удаляется только после записи exit-event именно своего worker.
 */
async function serverCase() {
  const native = mode === 'native';
  const entry = path.join(root, 'payload.cjs');

  await fs.writeFile(entry, payload(mode !== 'launcher', mode === 'restart' ? 75 : 0));

  let command;

  if (native) {
    command = `require(${JSON.stringify(entry)}).startPayloadServer()`;
  } else {
    await fs.mkdir(path.join(root, 'runtime/node/bin'), { recursive: true });
    await fs.mkdir(path.join(root, 'server'), { recursive: true });
    await fs.symlink(process.execPath, path.join(root, 'runtime/node/bin/node'));
    await fs.copyFile(entry, path.join(root, 'server/payload.cjs'));
    await build({
      entryPoints: [path.join(source, 'server/src/binary/workerBootstrap.ts')],
      outfile: path.join(root, 'server/worker-bootstrap.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    });
    command = `
      import { runLauncherWorker } from ${JSON.stringify(path.join(source, 'server/src/binary/worker.ts'))};
      const result = await runLauncherWorker({
        root: ${JSON.stringify(root)}, binary: ${JSON.stringify(entry)},
        cwd: ${JSON.stringify(root)}, env: {}, externalParent: true,
      });
      process.exitCode = result.code;
    `;
  }

  const launcher = spawn(process.execPath, [native ? '--eval' : '--input-type=module',
    ...(native ? [] : ['--eval']), command], {
    env: {},
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const ended = once(launcher, 'exit');
  let ready;

  try {
    [ready] = await once(launcher, 'message');
    await until(() => fs.access(path.join(root, 'exit.json')).then(() => true, () => false));
    assert.ok(JSON.parse(await fs.readFile(path.join(root, 'exit.json'), 'utf8'))
      .includes('GetAddrInfoReqWrap'));

    const startedAt = Date.now();

    if (mode === 'launcher') {
      // Без независимого fd-сторожа SIGKILL launcher навсегда оставлял этот worker.
      await assert.rejects(prepareBrowserSocket(path.join(root, 'relay.sock')), /browser_socket_busy/u);
      launcher.kill('SIGKILL');
    }

    const [code] = await ended;

    if (mode === 'restart') {
      assert.equal(code, 75, 'Аварийный выход worker сохраняет intent desktop-перезапуска');
    }

    await until(() => sockets.size === 0, native ? 2500 : 48_000);
    assert.ok(Date.now() - startedAt < (native ? 2500 : 48_000));
    process.kill(ready.factory, 0);
    await nextStart(path.join(root, 'relay.sock'));

    return {
      nativeRequestsAtExit: true,
      nextStart: true,
      detachedFactorySurvived: true,
      code,
      tookMs: Date.now() - startedAt,
    };
  } finally {
    launcher.kill('SIGKILL');

    for (const pid of [ready?.pid, ready?.factory]) {
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
  }
}

/**
 * Telegram использует настоящий isolatedFetch и синтетический токен в закрытой сети.
 * Отмена завершает DNS-процесс до возврата ошибки, повторов отправки здесь нет.
 */
async function cancellationCase() {
  const controller = new AbortController();
  const result = callBotApi('123456:synthetic_token', 'getUpdates', { timeout: 60 }, {
    signal: controller.signal,
  });

  await until(() => questions.length > 0);
  controller.abort();
  await assert.rejects(result, (error) => error.kind === 'transport' && error.code === 'ABORT_ERR');
  await until(() => sockets.size === 0);

  const request = isolatedFetchWithLimits('https://cancel.shutdown-fixture.invalid/', {}, {
    timeoutMs: 250,
  });

  await assert.rejects(request, { name: 'TimeoutError' });
  await until(() => sockets.size === 0);

  return {
    cancelled: true,
    deadline: true,
    dnsClosed: true,
  };
}

/**
 * Исчезновение владельца сети оставляет только одноразовый сетевой процесс.
 * Его собственный watchdog обязан закрыть DNS через SIGKILL без process.exit.
 */
async function networkOrphanCase() {
  const command = `
    import { isolatedFetchWithLimits } from ${JSON.stringify(
      path.join(source, 'server/src/lib/isolatedFetch.ts'))};
    await isolatedFetchWithLimits('https://orphan.shutdown-fixture.invalid/', {}, { timeoutMs: 5000 });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', command], {
    env: {}, stdio: 'ignore',
  });
  const ended = once(child, 'exit');

  try {
    await until(() => questions.length > 0);
    child.kill('SIGKILL');
    await ended;
    await until(() => sockets.size === 0, 7000);

    return { reserveWatchdog: true, dnsClosed: true };
  } finally {
    child.kill('SIGKILL');
  }
}

try {
  const result = ['native', 'launcher', 'restart'].includes(mode)
    ? await serverCase()
    : mode === 'network-orphan' ? await networkOrphanCase() : await cancellationCase();

  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  for (const socket of sockets) {
    socket.destroy();
  }

  dns.close();
}
