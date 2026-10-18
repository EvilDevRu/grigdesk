// Установка браузера записи: жизненный цикл задания и манифест ревизии.
//
// Скачивание подменяется исполнителем, который пишет то же, что настоящий: ход,
// манифест и итог. Проверяется главное: «установлен» означает «под текущий
// Playwright», повтор нажатия не заводит вторую установку, отказ приходит со
// своей причиной, а исчезнувший процесс честно называется оборванным.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createBrowserInstaller,
  PLAYWRIGHT_VERSION,
} from '../../server/src/lib/showcase/browserInstall.ts';
import { processAlive } from '../../server/src/lib/showcase/processIdentity.ts';

const ATTEMPT_LOG = new URL('../../server/src/lib/showcase/attemptLog.ts', import.meta.url).href;

// Исполнитель-двойник удачной установки: отчитывается о ходе, кладёт манифест с
// существующим файлом (самим node) и пишет итог. Версию Playwright берёт из
// задания — как настоящий.
const SUCCEEDING_WORKER = `
import { readFile, writeFile } from 'node:fs/promises';
import { createAttemptLog } from ${JSON.stringify(ATTEMPT_LOG)};

const task = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { finish, report } = createAttemptLog(task);

await report('download', 'скачиваю Chromium');
await writeFile(task.manifestFile, JSON.stringify({
  schemaVersion: 1,
  executable: process.execPath,
  playwrightVersion: task.playwrightVersion,
  browserVersion: 'Chromium 000.0',
  installedAt: new Date().toISOString(),
}), 'utf8');
await report('done', 'браузер готов');
await finish({ state: 'succeeded', executable: process.execPath });
`;

const FAILING_WORKER = `
import { readFile } from 'node:fs/promises';
import { createAttemptLog } from ${JSON.stringify(ATTEMPT_LOG)};

const task = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { finish } = createAttemptLog(task);

await finish({ state: 'failed', error: 'браузер не запускается: libnss3.so отсутствует' });
`;

// Исполнитель, который живёт, пока его не снимут: на нём проверяются повтор
// нажатия, отмена и потеря процесса.
const SLEEPING_WORKER = `
import { readFile } from 'node:fs/promises';
import { createAttemptLog } from ${JSON.stringify(ATTEMPT_LOG)};

const task = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { report } = createAttemptLog(task);

await report('download', 'скачиваю Chromium');
setInterval(() => {}, 1000);
`;

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'showcase-browser-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

async function fakeWorker(root, body, marker) {
  const file = path.join(root, `${marker}.mts`);

  await writeFile(file, body, 'utf8');

  return { file, marker };
}

async function waitFor(probe, attempts = 200) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await probe();

    if (value) {
      return value;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }

  throw new Error('ожидаемое состояние не наступило');
}

async function settled(installer, states) {
  return waitFor(async () => {
    await installer.poll();

    const status = await installer.status();

    return states.includes(status.job?.state) ? status : null;
  });
}

test('без манифеста браузер не установлен, и записи путь не отдаётся', async (t) => {
  const root = await workspace(t);
  const installer = createBrowserInstaller({ browserDir: path.join(root, 'browser') });
  const status = await installer.status();

  assert.equal(status.installed, null);
  assert.equal(status.job, null);
  assert.equal(status.playwrightVersion, PLAYWRIGHT_VERSION);
  assert.equal(await installer.installedExecutable(), null);
});

test('удачная установка оставляет манифест, а путь отдаётся только под текущий Playwright', async (t) => {
  const root = await workspace(t);
  const browserDir = path.join(root, 'browser');
  const installer = createBrowserInstaller({
    browserDir,
    workerScript: await fakeWorker(root, SUCCEEDING_WORKER, 'succeeding'),
  });
  const started = await installer.start();

  assert.equal(started.job.state, 'running');

  const done = await settled(installer, ['succeeded', 'failed']);

  assert.equal(done.job.state, 'succeeded');
  assert.equal(done.installed.executable, process.execPath);
  assert.equal(done.installed.current, true);
  assert.equal(await installer.installedExecutable(), process.execPath);

  // Тот же манифест глазами GrigDesk с другим playwright-core: браузер на диске
  // есть, но записи с ним верить нельзя.
  const other = createBrowserInstaller({ browserDir, playwrightVersion: '0.0.0' });
  const stale = await other.status();

  assert.equal(stale.installed.current, false);
  assert.equal(await other.installedExecutable(), null);
});

test('отказ исполнителя приносит его причину и не оставляет манифеста', async (t) => {
  const root = await workspace(t);
  const installer = createBrowserInstaller({
    browserDir: path.join(root, 'browser'),
    workerScript: await fakeWorker(root, FAILING_WORKER, 'failing'),
  });

  await installer.start();

  const done = await settled(installer, ['succeeded', 'failed']);

  assert.equal(done.job.state, 'failed');
  assert.match(done.job.error, /libnss3/);
  assert.equal(done.installed, null);
});

test('повторное нажатие возвращает идущую установку, а отмена снимает процесс', async (t) => {
  const root = await workspace(t);
  const installer = createBrowserInstaller({
    browserDir: path.join(root, 'browser'),
    workerScript: await fakeWorker(root, SLEEPING_WORKER, 'sleeping'),
  });
  const first = await installer.start();
  const second = await installer.start();

  assert.equal(second.job.id, first.job.id, 'вторая установка не заводится');

  const cancelled = await installer.cancel();

  assert.equal(cancelled.job.state, 'cancelled');
});

test('исчезнувший процесс после перезапуска называется оборванным', async (t) => {
  const root = await workspace(t);
  const browserDir = path.join(root, 'browser');
  const installer = createBrowserInstaller({
    browserDir,
    workerScript: await fakeWorker(root, SLEEPING_WORKER, 'sleeping'),
  });

  await installer.start();

  const record = JSON.parse(await readFile(path.join(browserDir, 'install.json'), 'utf8'));

  process.kill(record.identity.pid, 'SIGKILL');
  await waitFor(async () => !processAlive(record.identity));

  // Новый сервер поднимает состояние с диска: живого процесса нет, и «идёт»
  // превращается в честное «оборвалось».
  const restarted = createBrowserInstaller({ browserDir });

  await restarted.recover();

  const status = await restarted.status();

  assert.equal(status.job.state, 'interrupted');
  assert.match(status.job.error, /процесс/);
});
