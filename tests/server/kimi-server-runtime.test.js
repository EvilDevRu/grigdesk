// Runtime сервера Kimi: запуск, готовность по токену и мете, остановка и отказ старта.
//
// Сервер поднимается как настоящий процесс (фикстура-бинарь), поэтому проверяются и
// ожидание готовности, и уборка процесса, и понятная ошибка, когда сервер не встал.
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startKimiServer } from '../../server/src/lib/kimi/serverRuntime.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/kimi-server/fake-kimi.mjs');
const RELAY_FIXTURE = path.join(ROOT, 'tests/fixtures/kimi-server/fake-kimi-relay.mjs');

/**
 * Даёт каждому тесту отдельный дом и процесс синтетического сервера.
 * Обёртка хранит конфигурацию только в каталоге фикстуры.
 */
async function fixture(t, env = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-kimi-runtime-'));
  const bin = path.join(dir, 'kimi-fixture');

  await copyFile(FIXTURE, bin);
  await chmod(bin, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));

  return {
    dir,
    bin,
    home: path.join(dir, 'home'),
    env: { ...process.env, ...env },
  };
}

test('Kimi runtime: сервер поднимается, отдаёт мету и гасится', async (t) => {
  const f = await fixture(t);
  const started = await startKimiServer({
    bin: f.bin,
    home: f.home,
    env: f.env,
  });

  assert.match(started.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(started.token, 'fixture-token-0123456789');
  assert.ok(started.pid, 'известен pid процесса');
  assert.equal((await started.client.meta()).server_version, '0.33.0-fixture');

  const pid = started.pid;

  await started.stop();

  await waitFor(() => !processAlive(pid), 'остановку процесса');
});

test('Kimi runtime: сервер, который не встал, даёт понятную ошибку с хвостом лога', async (t) => {
  const f = await fixture(t, { GRIGDESK_KIMI_FIXTURE_MODE: 'crash' });

  await assert.rejects(
    () => startKimiServer({
      bin: f.bin,
      home: f.home,
      env: f.env,
      startupTimeoutMs: 3000,
    }),
    (error) => /Kimi server завершился, не поднявшись/.test(error.message)
      && /сервер не поднялся/.test(error.message),
  );
});

test('Kimi runtime: чужой токен в файле не выдаётся за готовность', async (t) => {
  const f = await fixture(t, { GRIGDESK_KIMI_FIXTURE_TOKEN: 'right-token-0123456789' });
  const started = await startKimiServer({
    bin: f.bin,
    home: f.home,
    env: f.env,
  });

  assert.equal(started.token, 'right-token-0123456789');
  assert.equal((await started.client.meta()).server_version, '0.33.0-fixture');
  await started.stop();
});

test('Kimi runtime: contained HTTP проходит через короткий Unix socket bridge', async (t) => {
  const f = await fixture(t);
  const socketPath = path.join(f.dir, 'control', 's');
  const started = await startKimiServer({
    bin: f.bin,
    home: f.home,
    socketPath,
    launch: {
      command: process.execPath,
      args: [RELAY_FIXTURE, f.home, socketPath],
      cwd: f.dir,
      env: f.env,
    },
  });

  assert.equal((await started.client.meta()).server_version, 'contained-fixture');
  await started.stop();
  await assert.rejects(fetch(`${started.baseUrl}/api/v1/meta`));
});

/**
 * Проверяет только живость собственного процесса теста по его pid.
 * Реальную остановку выполняет startKimiServer.stop().
 */
function processAlive(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

/**
 * Ожидание условия короткими паузами: настоящие задержки в тесте не нужны.
 * Deadline защищает от зависания фикстуры при нарушении протокола остановки.
 */
async function waitFor(check, what, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`не дождались: ${what}`);
}
