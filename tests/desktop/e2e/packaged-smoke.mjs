import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { constants as fsConstants } from 'node:fs';
import { once } from 'node:events';
import { access, cp, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { extractFile, listPackage } from '../../../desktop/node_modules/@electron/asar/lib/asar.js';
import {
  FuseV1Options, getCurrentFuseWire,
} from '../../../desktop/node_modules/@electron/fuses/dist/index.js';
import { FuseState } from '../../../desktop/node_modules/@electron/fuses/dist/constants.js';
import { desktopLaunchOptions } from './launch.mjs';
import { freePort } from '../../server/helpers/pluginBootFixture.js';
import { fixtureEntries, writeRuntimeDescriptor, writeServerFixture } from './server-fixture.mjs';
import { sealUiRelease, verifyUiRelease } from '../../../desktop/src/uiRelease.ts';

const execute = promisify(execFile);
const modes = [
  { name: 'linux-unpacked', executable: process.env.GRIGDESK_PACKAGED_EXECUTABLE },
  { name: 'AppImage', executable: process.env.GRIGDESK_PACKAGED_APPIMAGE },
];

/**
 * AppImage может оставить оболочку между spawn и главным процессом Electron.
 * Читается только дерево собственного child, чтобы завершить приложение штатным SIGTERM.
 */
async function electronMain(pid) {
  try {
    const executable = await readlink(`/proc/${pid}/exe`);

    if (path.basename(executable) === 'grigdesk') {
      return pid;
    }

    const children = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');

    for (const child of children.trim().split(/\s+/).filter(Boolean)) {
      const main = await electronMain(Number(child));

      if (main) {
        return main;
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Пакет запускается обычным spawn: защитные fuses остаются штатными.
 * Видимость проверяет собственный Xvfb; кадр сохраняется для визуальной проверки экрана машин.
 */
async function standaloneRun(t, mode) {
  const root = await mkdtemp(path.join(tmpdir(), 'grigdesk-package-'));
  const dataDir = path.join(root, 'profile');
  const screenshotDir = process.env.GRIGDESK_E2E_ARTIFACTS;

  assert.ok(screenshotDir && path.isAbsolute(screenshotDir));
  await mkdir(screenshotDir, { recursive: true });

  const selected = desktopLaunchOptions({
    root,
    dataDir,
    isolateEnv: true,
    executablePath: mode.executable,
    args: [...(mode.name === 'AppImage' ? ['--appimage-extract-and-run'] : []),
      '--password-store=gnome-libsecret'],
    env: {
      GRIGDESK_HOME: path.join(root, 'server-data'),
      GRIGDESK_WINDOW_KEY_PATH: path.join(root, 'auth/key'),
    },
  });
  const child = spawn(selected.executablePath, selected.args, {
    env: selected.env,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  });
  const exited = once(child, 'exit');
  let log = '';

  child.stderr.on('data', (chunk) => {
    log += chunk;
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid, 'SIGKILL');
      await exited;
    }

    await rm(root, { recursive: true, force: true });
  });

  const deadline = Date.now() + 30000;
  let screen;
  let visible = false;

  while (Date.now() < deadline && child.exitCode === null) {
    const { stdout } = await execute('python3', ['-I',
      path.join(import.meta.dirname, 'x11-windows.py')]);

    screen = JSON.parse(stdout);
    visible = screen.windows.some((window) => window.visible && window.width > 800);

    if (visible) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  t.diagnostic(JSON.stringify(screen));
  await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab',
    '-video_size', `${screen.width}x${screen.height}`, '-i', process.env.DISPLAY,
    '-frames:v', '1', '-y', path.join(screenshotDir, `${mode.name}.png`)]);
  assert.equal(visible, true, log.slice(-2000));

  const mainPid = await electronMain(child.pid);

  assert.ok(mainPid, 'должен работать главный процесс Electron');
  process.kill(mainPid, 'SIGTERM');

  const [code, signal] = await exited;

  assert.equal(code, 0, log.slice(-2000));
  assert.equal(signal, null);

  const settings = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8'));

  assert.equal(settings.version, 2);
  assert.deepEqual(settings.profiles, []);
  assert.equal(settings.selected, null);
}

for (const mode of modes) {
  test(`UC-P1/${mode.name}: пакет без сервера показывает встроенный экран`,
    { timeout: 60000 }, async (t) => {
      if (!mode.executable) {
        t.skip('Не задан путь пакета.');

        return;
      }

      await standaloneRun(t, mode);
    });
}

const fuseTargets = [
  {
    name: 'linux-unpacked',
    executable: process.env.GRIGDESK_PACKAGED_EXECUTABLE,
  },
  {
    name: 'AppImage-ELF',
    executable: process.env.GRIGDESK_PACKAGED_EXTRACTED_EXECUTABLE,
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

const SPLASH_HASHES = {
  'background.png': 'dfdcded22be22703db57e8a5b96e2ab34019f7789d1e9ff6e142021ea43a9188',
  'wordmark.svg': '732ca732444dd5df453748cbec861562ec5fa344c124210f43fb6b7dd8925ba7',
  'index.html': 'acf8133f47d09ab8e2b49842fd25f16551197434df3cdbe10a19bc082a1a65e5',
  'style.css': 'b8a9538d1b90ec7792923f708d61a2ef2b5f94680883821a7522cd8b914aa18f',
};

test('DW-P4: ресурсы заставки лежат в пакете без изменений', async (t) => {
  const executable = process.env.GRIGDESK_PACKAGED_EXECUTABLE;

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

  for (const [name, expected] of Object.entries(SPLASH_HASHES)) {
    assert.ok(files.includes(`/dist/splash/${name}`), name);

    const bytes = extractFile(archive, `dist/splash/${name}`);

    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, name);
  }

  assert.equal(files.includes('/dist/splash/illustration.png'), false);
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
    assert.deepEqual(JSON.parse(await readFile(path.join(packaged, 'api-version.json'), 'utf8')),
      { major: 0, minor: 1 });
    assert.ok(actual.files.some((file) => /assets\/CodePanel-.*\.js$/.test(file.path)));
    assert.ok(actual.files.some((file) => /assets\/SettingsModal-.*\.js$/.test(file.path)));
    assert.equal(actual.files.some((file) => /(?:^|\/)(?:sw\.js|.*\.webmanifest)$/.test(file.path)), false);
  });
}

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
    const extracted = process.env.GRIGDESK_PACKAGED_EXTRACTED_EXECUTABLE;

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
    const fixture = path.join(root, 'grigdesk');
    const fixtureLog = path.join(root, 'fixture.log');
    const runtimeFile = path.join(process.env.XDG_DATA_HOME, 'grigdesk/desktop/runtime.json');
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
      args: [`--grigdesk-url=http://127.0.0.1:${port}`, '--password-store=gnome-libsecret'],
      isolateEnv: true,
      env: {
        GRIGDESK_PORT: String(port),
        GRIGDESK_WINDOW_KEY_PATH: path.join(root, 'window-auth/key'),
        GRIGDESK_E2E_FIXTURE_LOG: fixtureLog,
        GRIGDESK_E2E_FIXTURE_PACKAGED_COOKIE: randomBytes(24).toString('base64url'),
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
      const ready = Date.now() + 30000;

      while (Date.now() < ready && child.exitCode === null) {
        if ((await fixtureEntries(fixtureLog)).some((entry) => entry.event === 'listen')) {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      assert.ok((await fixtureEntries(fixtureLog)).some((entry) => entry.event === 'listen'),
        `Свой сервер не запущен: ${log.slice(-2000)}`);

      const mainPid = await electronMain(child.pid);

      assert.ok(mainPid);
      process.kill(mainPid, 'SIGTERM');

      const [code, signal] = await Promise.race([
        exited,
        new Promise((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('Пакет не закрылся за 60 с.')), 60000);
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

/**
 * Копия готового пакета сохраняет main и fuses, заменяется только запечатанный UI фикстуры.
 * Renderer сообщает typeof require/process через обычный API трубы без inspector/CDP.
 */
async function rendererProbe(t, executable) {
  const root = await mkdtemp(path.join(tmpdir(), 'grigdesk-packaged-renderer-'));
  const packageCopy = path.join(root, 'package');
  const uiDir = path.join(packageCopy, 'resources/ui');
  const key = randomBytes(32).toString('base64url');
  const keyFile = path.join(root, 'auth/key');
  const probes = [];
  let child;
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-GrigDesk-Api', '0.1');
    response.setHeader('Content-Type', 'application/json');

    if (request.url === '/api/auth/window-session') {
      response.setHeader('Set-Cookie', 'grigdesk_sid=packaged-fixture; HttpOnly');
      response.end('{}');
    } else if (request.url === '/api/auth/state') {
      response.end('{"configured":true,"authenticated":true}');
    } else if (request.url === '/api/packaged-probe') {
      let body = '';

      for await (const chunk of request) {
        body += chunk;
      }

      probes.push(JSON.parse(body));
      response.end('{}');
    } else {
      response.end('{}');
    }
  });

  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');

      process.kill(-child.pid, 'SIGKILL');
      await exited;
    }

    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await cp(path.dirname(executable), packageCopy, {
    recursive: true, mode: fsConstants.COPYFILE_FICLONE,
  });
  await rm(uiDir, { recursive: true, force: true });
  await mkdir(uiDir, { recursive: true });
  await mkdir(path.dirname(keyFile), { mode: 0o700 });
  await writeFile(keyFile, key, { mode: 0o600 });
  await writeFile(path.join(uiDir, 'api-version.json'), '{"major":0,"minor":1}');
  await writeFile(path.join(uiDir, 'index.html'), `<!doctype html><meta charset="utf-8">
<title>GrigDesk — проверка renderer</title><h1>Проверка renderer</h1><script>
(async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await fetch('/__shell/state').then(response => response.json());
    if (state.status === 'online') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await fetch('/api/packaged-probe', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requireType: typeof require, processType: typeof process }),
  });
  window.close();
})();
</script>`);
  await sealUiRelease(uiDir);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const selected = desktopLaunchOptions({
    root,
    dataDir: path.join(root, 'profile'),
    isolateEnv: true,
    executablePath: path.join(packageCopy, path.basename(executable)),
    args: [`--grigdesk-url=http://127.0.0.1:${server.address().port}`, '--password-store=gnome-libsecret'],
    env: { GRIGDESK_HOME: path.join(root, 'server-data'), GRIGDESK_WINDOW_KEY_PATH: keyFile },

  });

  child = spawn(selected.executablePath, selected.args, {
    env: selected.env,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,

  });

  let log = '';

  child.stderr.on('data', (chunk) => {
    log += chunk;
  });

  let timer;

  try {
    const [code, signal] = await Promise.race([
      once(child, 'exit'),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Renderer не завершил probe: ${log.slice(-2000)}`)), 30000);
      }),
    ]);

    assert.equal(code, 0, log.slice(-2000));
    assert.equal(signal, null);
    assert.deepEqual(probes, [{ requireType: 'undefined', processType: 'undefined' }]);
  } finally {
    clearTimeout(timer);
  }
}

for (const target of fuseTargets) {
  test(`DW-P1/${target.name}: renderer готового пакета не имеет require/process`,
    { timeout: 60000 }, async (t) => {
      if (!target.executable) {
        t.skip('Не задан путь готового ELF пакета.');

        return;
      }

      await rendererProbe(t, target.executable);
    });
}
