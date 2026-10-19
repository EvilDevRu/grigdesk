import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { freePort, isolatedEnv } from '../../server/helpers/pluginBootFixture.js';
import { launchDesktop } from './launch.mjs';
import { seaDesktopArguments } from './serverSeaFixture.mts';

const execute = promisify(execFile);
const desktop = path.resolve(import.meta.dirname, '../../../desktop');

/**
 * Проверяет наблюдаемое состояние своего процесса без отправки сигналов по PID.
 * Срок ограничен; завершившийся зомби уже не считается работающим сервером.
 */
async function alive(pid: number): Promise<boolean> {
  const text = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');

  return text !== '' && text.slice(text.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
}

/**
 * Ожидание опирается на API/процесс, без фиксированной задержки готовности.
 * Ошибка соединения при коде75 повторяется до срока, затем тест завершается отказом.
 */
async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 60000;

  while (Date.now() < deadline) {
    if (await check().catch(() => false)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.fail(message);
}

test('SEA-GUI-01: окно запускает ELF SEA, код75 сохраняет выбор, закрытие освобождает lock (нестабильный)', {
  timeout: 240000,
}, async (t) => {
  const release = process.env.GRIGDESK_SERVER_RELEASE_DIR;
  const xdg = process.env.XDG_DATA_HOME;

  assert.ok(release, 'Укажите GRIGDESK_SERVER_RELEASE_DIR с готовым комплектом');
  assert.ok(xdg, 'Запускайте через tests/desktop/e2e/isolated-session.sh');
  assert.ok(xdg.startsWith('/tmp/'), 'XDG_DATA_HOME должен принадлежать одноразовой сессии');

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-gui-'));
  const unpack = path.join(temporary, 'unpack');
  const data = path.join(temporary, 'data');
  const runtimeFile = path.join(xdg, 'grigdesk/desktop/runtime.json');
  const basename = path.basename(release).replace(/-[a-f0-9]{16}$/, '');
  const archive = path.join(path.dirname(release), `${basename}.tar.xz`);
  let app: Awaited<ReturnType<typeof launchDesktop>>['app'] | undefined;

  t.after(async () => {
    await app?.close().catch(() => undefined);
    await rm(runtimeFile, { force: true });
    await rm(temporary, { recursive: true, force: true });
  });
  await mkdir(unpack);
  await mkdir(data);
  await mkdir(path.dirname(runtimeFile), { recursive: true });
  await execute('tar', ['-xJf', archive, '-C', unpack], { timeout: 30000 });

  const entries = await readdir(unpack);

  assert.equal(entries.length, 1);

  const root = path.join(temporary, 'SEA package with spaces');

  await rename(path.join(unpack, entries[0]!), root);
  await writeFile(runtimeFile, JSON.stringify({
    version: 3,
    kind: 'sea',
    root,
    home: data,
  }));
  await writeFile(path.join(data, '.env'), 'GRIGDESK_REQUIRE_VPN=0\n');

  const port = await freePort();
  const mobilePort = await freePort();
  const launched = await launchDesktop({
    root: temporary,
    dataDir: path.join(temporary, 'profile'),
    args: seaDesktopArguments(desktop, port),
    isolateEnv: true,
    env: {
      ...isolatedEnv(data, port, mobilePort),
      GRIGDESK_ENV_FILE: path.join(data, '.env'),
      GRIGDESK_WINDOW_KEY_PATH: path.join(temporary, 'window-auth/key'),
      GRIGDESK_LOG: path.join(data, 'state/grigdesk-server.log'),
    },
  });

  app = launched.app;

  const page = launched.page;

  await page.locator('.shell').waitFor({ timeout: 60000 });
  await page.waitForFunction(async () => {
    const state = await (await fetch('/__shell/state')).json();

    return state.status === 'online';
  }, undefined, { timeout: 60000 });

  const selected = await page.evaluate(async () => (await fetch('/__shell/state')).json());
  const pipeOrigin = new URL(page.url()).origin;

  const first = await page.evaluate(async () => (await fetch('/api/system/server')).json());
  const binary = await realpath(path.join(root, 'server/grigdesk-server'));

  assert.notEqual(pipeOrigin, `http://127.0.0.1:${port}`);
  assert.equal(selected.profile.kind, 'local');
  assert.equal(first.mode, 'desktop');
  assert.equal(await realpath(`/proc/${first.pid}/exe`), binary);
  assert.equal((await readFile(binary)).subarray(1, 4).toString(), 'ELF');

  const restart = await page.evaluate(async () => (await fetch('/api/system/restart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })).json());

  assert.equal(restart.ok, true);

  let secondPid = first.pid;

  await until(async () => {
    const current = await page.evaluate(async () => (await fetch('/api/system/server')).json());

    secondPid = current.pid;

    return Number.isSafeInteger(secondPid) && secondPid !== first.pid;
  }, 'После кода75 не появилось новое поколение');
  assert.equal(await realpath(`/proc/${secondPid}/exe`), binary);
  assert.equal(new URL(page.url()).origin, pipeOrigin);

  const reselected = await page.evaluate(async () => (await fetch('/__shell/state')).json());

  assert.equal(reselected.profile.id, selected.profile.id);
  await until(async () => !await alive(first.pid), 'Первое поколение не завершилось');
  await app.close();
  app = undefined;
  await until(async () => !await alive(secondPid), 'SEA остался после закрытия окна');
  assert.equal(await stat(path.join(data, 'state/server.lock')).catch(() => null), null);
});
