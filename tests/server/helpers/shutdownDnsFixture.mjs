import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { build } from '../../../server/node_modules/esbuild/lib/main.js';
import { fetchWithIsolatedDns } from '../../../server/src/lib/fetchWithIsolatedDns.ts';
import { isolatedLookup } from '../../../server/src/lib/isolatedDns.ts';
import { isolatedFetchWithLimits } from '../../../server/src/lib/isolatedFetch.ts';
import { PluginCatalogService } from '../../../server/src/lib/pluginCatalog.ts';
import { prepareBrowserSocket } from '../../../server/src/lib/browser/browserSocketDirectory.ts';
import { startEgressGuard } from '../../../server/src/lib/showcase/browserPolicy.ts';
import { callBotApi } from '../../../server/src/lib/telegram/api.ts';
import { catalogFixture } from '../../helpers/pluginCatalog.js';
import { selectTracker, trackerFixture, writeTracker } from './trackerFixture.js';

const [mode, root, relaySocket] = process.argv.slice(2);
const source = fileURLToPath(new URL('../../../', import.meta.url));
const resolver = path.join(root, 'resolv.conf');
const sockets = new Set();
const questions = [];
let dnsResponds = false;

await fs.writeFile(resolver, 'nameserver 127.0.0.1\noptions use-vc timeout:2 attempts:2\n');
execFileSync('mount', ['--make-rprivate', '/']);
execFileSync('ip', ['link', 'set', 'lo', 'up']);
execFileSync('mount', ['--bind', resolver, '/etc/resolv.conf']);

// Все адреса и TCP DNS принадлежат новому network namespace. Сначала DNS молчит.
// Наблюдение закрытия соединения подтверждает освобождение native getaddrinfo.
const dns = net.createServer((socket) => {
  sockets.add(socket);
  let pending = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    questions.push(chunk.length);

    if (!dnsResponds) {
      return;
    }

    pending = Buffer.concat([pending, chunk]);

    while (pending.length >= 2 && pending.length >= 2 + pending.readUInt16BE(0)) {
      const end = 2 + pending.readUInt16BE(0);

      socket.write(dnsReply(pending.subarray(2, end)));
      pending = pending.subarray(end);
    }
  });
  socket.once('close', () => sockets.delete(socket));
});

dns.listen(53, '127.0.0.1');
await once(dns, 'listening');

/**
 * Фикстура выдаёт локальный IPv4 для A и пустой успешный ответ для AAAA.
 * DNS по TCP может прислать несколько вопросов одним чтением.
 */
function dnsReply(query) {
  let offset = 12;

  while (query[offset] !== 0) {
    offset += 1 + query[offset];
  }

  const type = query.readUInt16BE(offset + 1);
  const answer = type === 1 ? Buffer.from('c00c000100010000000000047f000001', 'hex') : Buffer.alloc(0);
  const header = Buffer.from(query.subarray(0, 12));

  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(type === 1 ? 1 : 0, 6);
  header.fill(0, 8);

  const response = Buffer.concat([header, query.subarray(12, offset + 5), answer]);
  const length = Buffer.alloc(2);

  length.writeUInt16BE(response.length);

  return Buffer.concat([length, response]);
}

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
  await new Promise((resolve) => server.listen(${JSON.stringify(relaySocket)}, resolve));
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
      await assert.rejects(prepareBrowserSocket(relaySocket), /browser_socket_busy/u);
      launcher.kill('SIGKILL');
    }

    const [code] = await ended;

    if (mode === 'restart') {
      assert.equal(code, 75, 'Аварийный выход worker сохраняет intent desktop-перезапуска');
    }

    await until(() => sockets.size === 0, native ? 2500 : 48_000);
    assert.ok(Date.now() - startedAt < (native ? 2500 : 48_000));
    process.kill(ready.factory, 0);
    await nextStart(relaySocket);

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

/**
 * Штатные входы сервера используют одну сеть и живут в том же процессе.
 * Молчание DNS заканчивается ошибками, следующая попытка возвращает данные и очищает сокеты.
 */
async function recoverCase() {
  const cleanups = [];
  const fixture = { after: (cleanup) => cleanups.push(cleanup) };
  const catalogHost = 'catalog.shutdown-fixture.invalid';
  const certificate = path.join(root, 'certificate.pem');
  const key = path.join(root, 'key.pem');

  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=GrigDesk test',
    '-addext', `subjectAltName=DNS:${catalogHost}`, '-keyout', key, '-out', certificate,
  ], { stdio: 'ignore' });
  process.env.NODE_EXTRA_CA_CERTS = certificate;

  const catalogData = catalogFixture().index;
  const catalogServer = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(certificate) },
    (_request, res) => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(catalogData));
    });
  const task = { id: 42, title: 'Задача после восстановления DNS' };
  let finishStream;
  const trackerServer = http.createServer((request, res) => {
    if (request.url === '/stream') {
      res.writeHead(200, { connection: 'close' });
      res.write('первая часть');
      finishStream = () => res.end('вторая часть');

      return;
    }

    if (request.url === '/start') {
      res.writeHead(302, { location: '/dashboard', connection: 'close' });
      res.end();

      return;
    }

    res.writeHead(200, { 'set-cookie': ['a=1', 'b=2'], connection: 'close' });
    res.write('{"tasks":');
    setTimeout(() => res.end(`${JSON.stringify([task])},"toReview":[],"created":[],"widgets":[]}`), 50);
  });

  for (const server of [catalogServer, trackerServer]) {
    server.listen(0, '127.0.0.1');
    cleanups.unshift(() => {
      server.closeAllConnections();
      server.close();
    });
    await once(server, 'listening');
  }

  const trackerOrigin = `http://tracker.shutdown-fixture.invalid:${trackerServer.address().port}`;
  let now = Date.now();
  const catalog = new PluginCatalogService({
    urls: [`https://${catalogHost}:${catalogServer.address().port}/api/plugins/v1/index.json`],
    applicationVersion: '1.0.0',
    now: () => now,
  });

  cleanups.push(() => catalog.close());

  try {
    const proxy = await startEgressGuard({ allowedOrigins: [trackerOrigin], allowedMethods: ['GET'] });

    cleanups.push(() => proxy.close());

    /**
     * Запрашивает объявленный маршрут через прокси показа.
     * Собственный срок превращает ошибочный fallback к DNS родителя в отказ теста.
     */
    const readProxy = () => new Promise((resolve, reject) => {
      const request = http.get({
        host: '127.0.0.1',
        port: proxy.port,
        path: `${trackerOrigin}/dashboard`,
        signal: AbortSignal.timeout(12_000),
      }, (response) => {
        response.once('end', () => resolve(response.statusCode));
        response.once('error', reject);
        response.resume();
      });

      request.once('error', reject);
    });
    const board = await trackerFixture(fixture, {
      setup: async (config) => writeTracker(config, 'dns-fixture', { code: `
        export default function (host) {
          const origin = ${JSON.stringify(trackerOrigin)};
          return {
            id: 'dns-fixture', capabilities: {}, isConfigured: () => true,
            testAuth: async () => ({ ok: true }),
            accountIdentity: async () => ({ baseUrl: origin, userId: 7 }),
            listTasks: async () => [], taskDetail: async () => null,
            sourceUrl: () => origin, probeTaskNumber: async () => 'absent',
            async getDashboard() {
              const response = await host.fetch(new Request(origin + '/start'));
              if (response.url !== origin + '/dashboard' || !response.redirected
                || response.headers.getSetCookie().length !== 2) {
                throw new Error('Драйвер потерял нативные свойства ответа');
              }
              return response.json();
            },
          };
        }
      ` }),
    });
    const readBoard = () => board.request('GET', '/api/tracker/dns-fixture/dashboard');

    await selectTracker(board, 'dns-fixture');

    const fail = Promise.all([readBoard(), catalog.index(), readProxy()]);

    await until(() => sockets.size >= 2);

    const [failedBoard, failedCatalog, failedProxy] = await fail;

    assert.equal(failedBoard.statusCode, 502);
    assert.equal(failedCatalog.state, 'unavailable');
    assert.equal(failedProxy, 502);
    await until(() => sockets.size === 0);

    for (let i = 0; i < 3; i += 1) {
      const request = isolatedLookup('again.shutdown-fixture.invalid', {}, { timeoutMs: 500 });
      const stopped = assert.rejects(request, { name: 'TimeoutError' });

      await until(() => sockets.size > 0);
      await stopped;
      await until(() => sockets.size === 0);
    }

    dnsResponds = true;
    now += 60_000;

    const [loadedBoard, loadedCatalog, loadedProxy] = await Promise.all([
      readBoard(), catalog.index(true), readProxy(),
    ]);

    assert.equal(loadedBoard.statusCode, 200, loadedBoard.body);
    assert.deepEqual(loadedBoard.json().tasks.map(({ id, title }) => ({ id, title })), [task]);
    assert.equal(loadedCatalog.state, 'fresh');
    assert.deepEqual(loadedCatalog.catalog, catalogData);
    assert.equal(loadedProxy, 200);

    const stream = await fetchWithIsolatedDns(`${trackerOrigin}/stream`, { signal: AbortSignal.timeout(2000) });
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();

    assert.equal(decoder.decode((await reader.read()).value), 'первая часть');
    finishStream();
    assert.equal(decoder.decode((await reader.read()).value), 'вторая часть');
    assert.equal((await reader.read()).done, true);
    await until(() => sockets.size === 0);

    return { trackerRecovered: true, catalogRecovered: true, dnsClosed: true, streamPreserved: true };
  } finally {
    for (const cleanup of cleanups) {
      await cleanup();
    }
  }
}

try {
  const runCase = {
    cancel: cancellationCase,
    'network-orphan': networkOrphanCase,
    recover: recoverCase,
  }[mode] ?? serverCase;
  const result = await runCase();

  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  for (const socket of sockets) {
    socket.destroy();
  }

  dns.close();
}
