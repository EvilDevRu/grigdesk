import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { extractFile, listPackage } from '../../../desktop/node_modules/@electron/asar/lib/asar.js';
import {
  FuseV1Options,
  getCurrentFuseWire,
} from '../../../desktop/node_modules/@electron/fuses/dist/index.js';
import { FuseState } from '../../../desktop/node_modules/@electron/fuses/dist/constants.js';
import { freePort } from '../../server/helpers/pluginBootFixture.js';
import { desktopLaunchOptions } from './launch.mjs';
import { fixtureEntries, writeRuntimeDescriptor, writeServerFixture } from './server-fixture.mjs';
import { startStub } from './stub.mjs';
import { verifyUiRelease } from '../../../desktop/src/uiRelease.ts';

const execute = promisify(execFile);
const modes = [
  {
    name: 'linux-unpacked',
    executable: process.env.COCKPIT_PACKAGED_EXECUTABLE,
  },
  {
    name: 'AppImage',
    executable: process.env.COCKPIT_PACKAGED_APPIMAGE,
  },
];

/**
 * Отсутствующий пакет и FUSE дают отдельный NOT RUN до запуска Electron.
 * При готовом бинарнике любая ошибка приложения остаётся FAIL самого smoke.
 */
async function available(t, mode) {
  if (!mode.executable) {
    t.skip('Не задан путь готового пакета.');

    return false;
  }

  assert.equal(path.isAbsolute(mode.executable), true);

  try {
    await access(mode.executable);
  } catch {
    t.skip('Готовый пакет отсутствует.');

    return false;
  }

  if (mode.name === 'AppImage') {
    try {
      await access('/dev/fuse');
    } catch {
      t.skip('В песочнице отсутствует /dev/fuse; прямой запуск AppImage невозможен.');

      return false;
    }
  }

  return true;
}

/**
 * Каждый режим имеет собственный профиль и случайную постоянную cookie.
 * Cleanup ждёт exit только своего child до остановки HTTP и удаления root.
 */
async function packagedRun(t, mode) {
  const root = await mkdtemp(path.join(tmpdir(), 'desktop-packaged-'));
  const dataDir = path.join(root, 'profile');
  const marker = randomBytes(24).toString('base64url');
  const children = [];
  let stub;

  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');

        child.kill('SIGKILL');
        await exited;
      }
    }

    await stub?.close();
    await rm(root, { recursive: true, force: true });
  });

  const authKey = randomBytes(32).toString('base64url');
  const keyFile = path.join(root, 'window-auth/key');

  await mkdir(path.dirname(keyFile), { mode: 0o700 });
  await writeFile(keyFile, authKey, { mode: 0o600 });
  stub = await startStub({
    packagedCookie: marker,
    authKey,
    uiReleasesDir: path.join(root, 'ui-releases'),
  });

  /**
   * Пакет стартует без inspector/CDP и закрывается только через window.close страницы.
   * Код 0 без сигнала доказывается до чтения SQLite и повторного запуска профиля.
   */
  async function launch() {
    const selected = desktopLaunchOptions({
      root,
      dataDir,
      executablePath: mode.executable,
      args: [`--cockpit-url=${stub.address}`, '--password-store=gnome-libsecret'],
      env: {
        COCKPIT_WINDOW_KEY_PATH: keyFile,
        COCKPIT_UI_RELEASES_DIR: path.join(root, 'ui-releases'),
      },
    });
    const child = spawn(selected.executablePath, selected.args, {
      env: selected.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const exited = once(child, 'exit');
    let log = '';
    let deadline;

    children.push(child);
    child.stderr.on('data', (chunk) => {
      log += chunk;
    });

    try {
      const [code, signal] = await Promise.race([
        exited,
        new Promise((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('Окно не закрылось штатно за 30 с.')), 30_000);
        }),
      ]);

      assert.equal(signal, null);
      assert.equal(code, 0, `Пакет завершился с ошибкой: ${log.slice(-2000)}`);
    } finally {
      clearTimeout(deadline);
    }
  }

  return {
    dataDir,
    stub,
    launch,
  };
}

/**
 * SQLite ищется только в двух известных местах собственной partition.
 * При ошибке перечисляется только этот подкаталог профиля, без глобального поиска.
 */
async function cookieDatabase(dataDir) {
  const partition = path.join(dataDir, 'Partitions/cockpit-local');

  for (const relative of ['Cookies', 'Network/Cookies']) {
    const candidate = path.join(partition, relative);

    try {
      await access(candidate);

      return candidate;
    } catch {
      // Следующий известный кандидат остаётся в той же собственной partition.
    }
  }

  const files = await readdir(partition, { recursive: true }).catch(() => []);

  assert.fail(`Cookie DB отсутствует; собственная partition содержит: ${files.join(', ')}`);
}

/**
 * Read-only запрос выводит лишь размеры и признаки строки, без cookie и BLOB.
 * Изолированный Python не читает пользовательские site-packages или настройки.
 */
async function encryptedCookie(database) {
  const source = `
import json, sqlite3, sys
from pathlib import Path
connection = sqlite3.connect(Path(sys.argv[1]).as_uri() + '?mode=ro', uri=True)
rows = connection.execute(
    "SELECT length(value), length(encrypted_value), expires_utc > 0 "
    "FROM cookies WHERE name = 'stub' AND host_key = '127.0.0.1'"
).fetchall()
connection.close()
print(json.dumps(rows))
`;
  const { stdout } = await execute('python3', ['-I', '-c', source, database], { timeout: 10_000 });
  const rows = JSON.parse(stdout);

  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], 0, 'Открытый value должен быть пустым.');
  assert.ok(rows[0][1] > 0, 'encrypted_value должен быть непустым.');
  assert.equal(rows[0][2], 1);
}

for (const mode of modes) {
  test(`DW-P1/${mode.name}: готовое окно загружает свою страницу`, { timeout: 45_000 }, async (t) => {
    if (!await available(t, mode)) {
      return;
    }

    const run = await packagedRun(t, mode);

    await run.launch();
    assert.deepEqual(run.stub.observations.probes, [{
      origin: run.stub.address,
      requireType: 'undefined',
      processType: 'undefined',
    }]);

    const probe = run.stub.observations.requests.find((request) => request.pathname === '/probe/loaded');

    assert.equal(probe?.packagedCookiePresent, true);
  });

  test(`DW-P2/${mode.name}: постоянная cookie зашифрована и читается после перезапуска`,
    { timeout: 90_000 }, async (t) => {
      if (!await available(t, mode)) {
        return;
      }

      const run = await packagedRun(t, mode);

      await run.launch();

      await t.test(`DW-P2/${mode.name}/SQLite: на диске только шифрованная строка`, async (subtest) => {
        try {
          await execute('python3', ['-I', '-c', 'import sqlite3'], { timeout: 5000 });
        } catch (error) {
          if (error.code === 'ENOENT' || /No module named .sqlite3/u.test(error.stderr ?? '')) {
            subtest.skip('Недоступны python3/sqlite3 для проверки базы.');

            return;
          }

          throw error;
        }

        const database = await cookieDatabase(run.dataDir);

        await encryptedCookie(database);
        subtest.diagnostic(`Cookie DB: ${path.relative(run.dataDir, database)}`);
      });
      await run.launch();

      const documents = run.stub.observations.requests.filter((request) =>
        /^\/ui\/[a-f0-9]{64}\/$/.test(request.pathname));

      assert.equal(documents.length, 2);
      assert.equal(documents[0].packagedCookiePresent, false);
      assert.equal(documents[1].packagedCookiePresent, true);
      assert.equal(run.stub.observations.cookieSets, 1, 'Сервер не устанавливает cookie повторно.');
      assert.equal(run.stub.observations.probes.length, 2);
      assert.ok(run.stub.observations.requests.filter((request) => request.pathname === '/probe/loaded')
        .every((request) => request.packagedCookiePresent));
    });
}

const fuseTargets = [
  {
    name: 'linux-unpacked',
    executable: process.env.COCKPIT_PACKAGED_EXECUTABLE,
  },
  {
    name: 'AppImage-ELF',
    executable: process.env.COCKPIT_PACKAGED_EXTRACTED_EXECUTABLE,
  },
];

for (const target of fuseTargets) {
  test(`DW-P3/${target.name}: готовый бинарник содержит четыре fuse-значения`, async (t) => {
    if (!target.executable) {
      t.skip('Не задан путь ELF для проверки fuse wire.');

      return;
    }

    assert.equal(path.isAbsolute(target.executable), true);

    try {
      await access(target.executable);
    } catch {
      t.skip('ELF отсутствует до выпуска пакета.');

      return;
    }

    const wire = await getCurrentFuseWire(target.executable);

    assert.equal(wire[FuseV1Options.RunAsNode], FuseState.DISABLE);
    assert.equal(wire[FuseV1Options.EnableCookieEncryption], FuseState.ENABLE);
    assert.equal(wire[FuseV1Options.EnableNodeOptionsEnvironmentVariable], FuseState.DISABLE);
    assert.equal(wire[FuseV1Options.EnableNodeCliInspectArguments], FuseState.DISABLE);
  });
}

const IMAGE_SHA256 = '3c6bf305047dccbe6215d1f1e625c4a7846bd63dd97eae431c8180cb42e2457c';

test('DW-P4: ресурсы заставки лежат в пакете без изменений', async (t) => {
  const executable = process.env.COCKPIT_PACKAGED_EXECUTABLE;

  if (!executable) {
    t.skip('Не задан путь готового пакета.');

    return;
  }

  const archive = path.join(path.dirname(executable), 'resources/app.asar');

  try {
    await access(archive);
  } catch {
    t.skip('app.asar отсутствует до выпуска пакета.');

    return;
  }

  const files = listPackage(archive, { isPack: false });

  for (const name of ['index.html', 'style.css', 'illustration.png']) {
    assert.ok(files.includes(`/dist/splash/${name}`), name);
  }

  const image = extractFile(archive, 'dist/splash/illustration.png');

  assert.equal(createHash('sha256').update(image).digest('hex'), IMAGE_SHA256);
});

/**
 * Живой процесс — есть в /proc и не зомби; отсутствие записи значит, что процесса нет.
 * Нужен, чтобы убедиться: свой сервер пакета завершился вместе с приложением.
 */
async function alive(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');

    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}

/**
 * Элемент пути принадлежит точке распаковки AppImage: сам каталог или вложенный в него.
 * Пустой элемент к распаковке не относится.
 */
function insideAppDir(value, appDir) {
  return (value ?? '').split(':').some((entry) => entry === appDir || entry.startsWith(appDir + '/'));
}

test('DW-P5: распакованный AppImage сам поднимает сервер с чистым окружением', { timeout: 120_000 },
  async (t) => {
    const extracted = process.env.COCKPIT_PACKAGED_EXTRACTED_EXECUTABLE;

    if (!extracted || process.env.XDG_DATA_HOME?.startsWith('/tmp/') !== true) {
      t.skip('Нужны распакованный AppImage и одноразовая сессия isolated-session.sh.');

      return;
    }

    const appDir = path.dirname(extracted);
    const appRun = path.join(appDir, 'AppRun');

    try {
      await access(appRun);
    } catch {
      t.skip('AppRun отсутствует до распаковки пакета.');

      return;
    }

    const root = await mkdtemp(path.join(tmpdir(), 'desktop-packaged-server-'));
    const fixture = path.join(root, 'cockpit');
    const fixtureLog = path.join(root, 'fixture.log');
    const runtimeFile = path.join(process.env.XDG_DATA_HOME, 'cockpit/desktop/runtime.json');
    const port = await freePort();
    let child;

    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');

        child.kill('SIGKILL');
        await exited;
      }

      for (const entry of await fixtureEntries(fixtureLog).catch(() => [])) {
        if (entry.event === 'start' && await alive(entry.pid)) {
          process.kill(entry.pid, 'SIGKILL');
        }
      }

      await rm(runtimeFile, { force: true });
      await rm(root, { recursive: true, force: true });
    });
    await writeServerFixture(fixture);
    await writeRuntimeDescriptor(runtimeFile, fixture);

    const selected = desktopLaunchOptions({
      root,
      dataDir: path.join(root, 'profile'),
      executablePath: appRun,
      args: [`--cockpit-url=http://127.0.0.1:${port}`, '--password-store=gnome-libsecret'],
      isolateEnv: true,
      env: {
        COCKPIT_PORT: String(port),
        COCKPIT_WINDOW_KEY_PATH: path.join(root, 'window-auth/key'),
        COCKPIT_E2E_FIXTURE_LOG: fixtureLog,
        COCKPIT_E2E_FIXTURE_PACKAGED_COOKIE: randomBytes(24).toString('base64url'),
      },
    });
    let log = '';

    child = spawn(selected.executablePath, selected.args, {
      env: selected.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', (chunk) => {
      log += chunk;
    });

    const exited = once(child, 'exit');
    let deadline;

    try {
      const [code, signal] = await Promise.race([
        exited,
        new Promise((_resolve, reject) => {
          deadline = setTimeout(() => {
            reject(new Error(`Пакет не закрылся за 60 с: ${log.slice(-2000)}`));
          }, 60_000);
        }),
      ]);

      assert.equal(signal, null);
      assert.equal(code, 0, `Пакет завершился с ошибкой: ${log.slice(-2000)}`);
    } finally {
      clearTimeout(deadline);
    }

    const entries = await fixtureEntries(fixtureLog);
    const start = entries.find((entry) => entry.event === 'start');
    const home = process.env.HOME;

    assert.ok(start, `Свой сервер не запускался: ${log.slice(-2000)}`);
    assert.equal(start.names.includes('APPDIR'), false);
    assert.equal(start.names.includes('APPIMAGE'), false);
    assert.equal(insideAppDir(start.path, appDir), false, start.path);
    assert.equal(insideAppDir(start.ldLibraryPath, appDir), false, String(start.ldLibraryPath));
    assert.ok(start.path.startsWith(`${home}/.kimi-code/bin:${home}/.local/bin:`), start.path);

    for (let attempt = 0; attempt < 100 && await alive(start.pid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.equal(await alive(start.pid), false, 'Свой сервер пакета жив после выхода.');
    assert.deepEqual(entries.filter((entry) => entry.event === 'exit').map((entry) => entry.code), [0]);
  });

for (const target of fuseTargets) {
  test(`UI-P1/${target.name}: пакет содержит целый интерфейс с проверяемым id`, async (t) => {
    if (!target.executable) {
      t.skip('Не задан путь готового пакета.');

      return;
    }

    const source = path.join(import.meta.dirname, '../../../desktop/dist/ui');
    const packaged = path.join(path.dirname(target.executable), 'resources/ui');
    const expected = await verifyUiRelease(source);
    const actual = await verifyUiRelease(packaged);

    assert.deepEqual(actual, expected);
    assert.ok(actual.files.some((file) => /assets\/CodePanel-.*\.js$/.test(file.path)));
    assert.ok(actual.files.some((file) => /assets\/SettingsWindowShell-.*\.js$/.test(file.path)));
    assert.equal(actual.files.some((file) => /(?:^|\/)(?:sw\.js|.*\.webmanifest)$/.test(file.path)), false);
  });
}
