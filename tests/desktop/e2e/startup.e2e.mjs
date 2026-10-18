import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { probeGrigDesk } from '../../../shared/runtime/grigDeskReadiness.ts';
import { splashBounds } from '../../../desktop/src/splashWindow.ts';
import { freePort, isolatedEnv } from '../../server/helpers/pluginBootFixture.js';
import { desktopLaunchOptions, isSplashPage, launchDesktopRaw } from './launch.mjs';
import {
  fixtureEntries as readFixtureLog,
  writeRuntimeDescriptor,
  writeServerFixture,
} from './server-fixture.mjs';
import { startStub } from './stub.mjs';

const repo = path.resolve(import.meta.dirname, '../../..');
const desktop = path.join(repo, 'desktop');
const options = { timeout: 150_000 };
// Descriptor пишется в XDG_DATA_HOME сессии: только одноразовая сессия isolated-session.sh.
const isolated = process.env.XDG_DATA_HOME?.startsWith('/tmp/') === true;

/**
 * Ожидание ограничено контрактом теста и проверяет наблюдаемое состояние.
 * Обычная ошибка предиката повторяется до срока; нарушенный assert прерывает ожидание.
 * Сообщение-функция вычисляется в момент отказа, чтобы видеть свежий stderr.
 */
async function waitFor(predicate, timeout = 20_000, message = 'Наблюдаемое состояние не достигнуто.') {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      if (error instanceof assert.AssertionError) {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.fail(typeof message === 'function' ? message() : message);
}

/**
 * Живой процесс — есть в /proc и не зомби: зомби уже завершился, его просто не прибрали.
 * Отсутствие записи означает, что процесса нет.
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
 * Обещание с пределом: завис — понятная ошибка проверки вместо таймаута всего теста.
 * Таймер снимается при любом исходе.
 */
async function within(promise, ms, message) {
  let timer;

  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Состояние окон из главного процесса: адрес и видимость каждого BrowserWindow.
 * Окно уже закрывающегося приложения даёт пустой список.
 */
async function windowsState(app) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .filter((window) => !window.isDestroyed())
    .map((window) => ({
      url: window.webContents.getURL(),
      visible: window.isVisible(),
    })));
}

/**
 * Один запуск сценария: временный корень, порт, профиль, путь ключа и descriptor сессии.
 * Уборка закрывает приложение раньше фикстур и удаляет только свои файлы.
 */
async function createRun(t, { descriptor = true } = {}) {
  if (!isolated) {
    t.skip('Сценарии старта пишут runtime.json и идут только в isolated-session.sh.');

    return null;
  }

  const root = await mkdtemp(path.join(tmpdir(), 'desktop-startup-e2e-'));
  const port = await freePort();
  const children = [];
  const run = {
    root,
    port,
    origin: `http://127.0.0.1:${port}`,
    fixture: path.join(root, 'grigdesk'),
    dataDir: path.join(root, 'profile'),
    keyFile: path.join(root, 'window-auth/key'),
    fixtureLog: path.join(root, 'fixture.log'),
    gatePid: path.join(root, 'gate.pid'),
    runtimeFile: path.join(process.env.XDG_DATA_HOME, 'grigdesk/desktop/runtime.json'),
    app: null,
    child: null,
    stderr: '',
    exited: null,
    splashSeen: false,
  };

  await writeServerFixture(run.fixture);

  if (descriptor) {
    await writeRuntimeDescriptor(run.runtimeFile, run.fixture);
  }

  t.after(async () => {
    try {
      await closeApp(run);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');

          child.kill('SIGKILL');
          await exited;
        }
      }

      for (const entry of await fixtureEntries(run).catch(() => [])) {
        if (entry.event === 'start' && await alive(entry.pid)) {
          process.kill(entry.pid, 'SIGKILL');
        }
      }

      await rm(run.runtimeFile, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  // Окружение по списку-разрешению не несёт XDG_CURRENT_DESKTOP: связку ключей задаём явно,
  // как packaged smoke, иначе Chromium выберет открытое хранилище и окно откажется стартовать.
  run.launchOptions = (extra = {}) => ({
    root,
    dataDir: run.dataDir,
    args: [desktop, `--grigdesk-url=${run.origin}`, '--password-store=gnome-libsecret'],
    isolateEnv: true,
    env: {
      GRIGDESK_PORT: String(port),
      GRIGDESK_WINDOW_KEY_PATH: run.keyFile,
      GRIGDESK_REQUIRE_VPN: '0',
      GRIGDESK_E2E_FIXTURE_LOG: run.fixtureLog,
      ...extra,
    },
  });
  run.launch = async (extra = {}) => {
    const { app } = await launchDesktopRaw(run.launchOptions(extra));

    run.app = app;
    run.child = app.process();
    run.stderr = '';
    run.exited = once(run.child, 'exit');
    run.child.stderr?.on('data', (chunk) => {
      run.stderr += chunk;
    });
    app.on('window', (page) => {
      if (isSplashPage(page)) {
        run.splashSeen = true;
      }
    });

    return app;
  };
  run.spawn = (command, args, spawnOptions) => {
    const child = spawn(command, args, spawnOptions);

    children.push(child);
    child.stderr?.resume();
    child.stdout?.resume();

    return child;
  };

  return run;
}

/**
 * Штатное закрытие через Playwright (app.quit), а зависшее — SIGKILL своего процесса.
 * Уже завершившийся процесс не трогается.
 */
async function closeApp(run) {
  const child = run.child;

  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    await within(run.app.close(), 60_000, 'Приложение не закрылось за 60 с.');
  } catch {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await run.exited;
    }
  }
}

/**
 * Журнал фикстуры этого запуска: события start, listen и exit каждого процесса.
 * Нет файла — фикстура ещё не запускалась.
 */
function fixtureEntries(run) {
  return readFixtureLog(run.fixtureLog);
}

/**
 * Внешний для приложения сервер: та же фикстура, запущенная тестом без IPC.
 * Готовность — запись listen в журнале фикстуры.
 */
async function startExternal(run) {
  const child = run.spawn(process.execPath, [path.join(run.fixture, 'server/src/app.ts')], {
    cwd: path.join(run.fixture, 'server'),
    env: {
      PATH: '/usr/bin:/bin',
      HOME: process.env.HOME,
      GRIGDESK_PORT: String(run.port),
      GRIGDESK_WINDOW_KEY_PATH: run.keyFile,
      GRIGDESK_E2E_FIXTURE_LOG: run.fixtureLog,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  await waitFor(async () => (await fixtureEntries(run)).some((entry) => entry.event === 'listen'));

  return child;
}

/**
 * Заставка видна: возвращает момент первого наблюдения и её страницу Playwright.
 * Наблюдение не раньше настоящего 'show', поэтому интервал до показа главного не завышается.
 */
async function waitForSplash(run, timeout = 30_000) {
  let at = 0;

  await waitFor(async () => {
    const windows = await windowsState(run.app);

    at = Date.now();

    return windows.some((window) => window.visible && window.url.endsWith('/splash/index.html'));
  }, timeout, () => `Заставка не появилась. stderr: ${run.stderr.slice(-1500)}`);

  const page = run.app.windows().find(isSplashPage);

  return {
    at,
    page,
  };
}

/**
 * Главное окно показано: заставки нет, видимое окно открыло свой origin.
 * Пока заставка жива, главное не должно быть видимым ни в одном наблюдении.
 */
async function waitForMain(run, timeout = 60_000) {
  let at = 0;

  await waitFor(async () => {
    const windows = await windowsState(run.app);
    const splash = windows.some((window) => window.url.endsWith('/splash/index.html'));
    const main = windows.some((window) => window.visible && window.url.startsWith(run.origin + '/'));

    at = Date.now();
    assert.equal(splash && main, false, 'Главное окно видно, пока жива заставка.');

    return main && !splash;
  }, timeout, () => `Главное окно не показано. stderr: ${run.stderr.slice(-1500)}`);

  const page = run.app.windows().find((candidate) => candidate.url().startsWith(run.origin + '/'));

  page?.setDefaultTimeout(30_000);

  return {
    at,
    page,
  };
}

/**
 * Отказ старта: строка «GrigDesk: …» в stderr, затем SIGTERM закрывает диалог и даёт код 1.
 * Нативный диалог тест не трогает.
 */
async function expectFailure(run, pattern) {
  const failed = () => run.stderr.split('\n')
    .some((line) => line.startsWith('GrigDesk: ') && pattern.test(line));

  await waitFor(failed, 100_000, `Нет строки отказа ${pattern} в stderr.`);

  const windows = await windowsState(run.app).catch(() => []);

  assert.equal(windows.some((window) => window.visible && window.url.startsWith(run.origin + '/')), false);
  run.child.kill('SIGTERM');

  const [code] = await within(run.exited, 10_000, 'Приложение не вышло после SIGTERM.');

  assert.equal(code, 1);
}

/**
 * Pid процесса фикстуры по журналу: n-й запуск по порядку событий start.
 * Нужен, чтобы проверять жизнь и выход именно своего сервера.
 */
async function startedPid(run, index = 0) {
  return (await fixtureEntries(run)).filter((entry) => entry.event === 'start')[index]?.pid;
}

/**
 * Закрывает заставку как человек: close() порождает событие 'close', в отличие от destroy().
 * Приложение при этом может уже выходить, поэтому отказ evaluate не ошибка.
 */
async function closeSplashLikeHuman(run) {
  await run.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().endsWith('/splash/index.html'))
      ?.close();
  }).catch(() => undefined);
}

test('SE-01: готовый внешний сервер — заставка, главное не раньше 2 с', options, async (t) => {
  const run = await createRun(t);

  if (!run) {
    return;
  }

  const external = await startExternal(run);

  await run.launch();

  const splash = await waitForSplash(run);

  assert.deepEqual(await splash.page.evaluate(() => {
    const image = document.querySelector('img');

    return [image.naturalWidth, image.naturalHeight, document.body.innerText.trim()];
  }), [1536, 1024, 'Загрузка…']);

  const main = await waitForMain(run);

  assert.ok(main.at - splash.at >= 1900, `Главное показано через ${main.at - splash.at} мс после заставки.`);

  const windows = await windowsState(run.app);

  assert.equal(windows.length, 1);
  assert.equal(windows[0].visible, true);

  await t.test('SE-03: закрытие не трогает внешний сервер', async () => {
    await run.app.close();

    const [code] = await run.exited;

    assert.equal(code, 0);
    assert.equal(external.exitCode, null);
    assert.equal(await alive(external.pid), true);
    assert.equal(await probeGrigDesk(run.origin), 'grigdesk');
  });
});

test('SE-02: сервера нет — приложение запускает свой с чистым окружением', options, async (t) => {
  const run = await createRun(t);

  if (!run) {
    return;
  }

  await run.launch({
    APPDIR: '/tmp/.mount_grigdesk-e2e',
    APPIMAGE: '/tmp/grigdesk-e2e.AppImage',
    LD_LIBRARY_PATH: '/tmp/.mount_grigdesk-e2e/usr/lib',
    INVOCATION_ID: 'e2e-invocation',
    CLAUDECODE: '1',
  });
  await waitForMain(run);

  const start = (await fixtureEntries(run)).find((entry) => entry.event === 'start');
  const home = process.env.HOME;

  assert.ok(start, 'Фикстура не запускалась.');

  const leaked = ['APPDIR', 'APPIMAGE', 'LD_LIBRARY_PATH', 'INVOCATION_ID', 'CLAUDECODE', 'CHROME_DESKTOP'];

  for (const name of leaked) {
    assert.equal(start.names.includes(name), false, name);
  }

  assert.equal(start.desktopChild, '1');
  assert.equal(start.connected, true);

  const prefix = `${home}/.kimi-code/bin:${home}/.local/bin:${path.dirname(process.execPath)}:`;

  assert.ok(start.path.startsWith(prefix), start.path);

  await t.test('SE-04: закрытие гасит свой сервер', async () => {
    await run.app.close();

    const [code] = await run.exited;

    assert.equal(code, 0);
    await waitFor(async () => !await alive(start.pid), 10_000, 'Свой сервер жив после выхода.');
    assert.equal(await probeGrigDesk(run.origin), 'refused');
    assert.deepEqual((await fixtureEntries(run)).filter((entry) => entry.event === 'exit')
      .map((entry) => entry.code), [0]);
  });
});

test('SE-05: закрытие заставки во время ворот — ворота остановлены, сервер не запущен', options,
  async (t) => {
    const run = await createRun(t);

    if (!run) {
      return;
    }

    await run.launch({ GRIGDESK_E2E_GATE_HOLD: run.gatePid });
    await waitFor(async () => /^\d+$/u.test((await readFile(run.gatePid, 'utf8')).trim()));

    const gate = Number((await readFile(run.gatePid, 'utf8')).trim());

    assert.equal(await alive(gate), true);
    await closeSplashLikeHuman(run);

    const [code] = await within(run.exited, 20_000, 'Приложение не вышло после закрытия заставки.');

    assert.equal(code, 0);
    await waitFor(async () => !await alive(gate), 10_000, 'Процесс ворот жив после выхода.');
    assert.deepEqual(await fixtureEntries(run), []);
  });

test('SE-06: второй экземпляр во время заставки не создаёт окон и второго сервера', options, async (t) => {
  const run = await createRun(t);

  if (!run) {
    return;
  }

  const extra = { GRIGDESK_E2E_GATE_HOLD: run.gatePid };

  await run.launch(extra);
  await waitFor(async () => /^\d+$/u.test((await readFile(run.gatePid, 'utf8')).trim()));
  await waitForSplash(run);

  const gate = (await readFile(run.gatePid, 'utf8')).trim();
  const before = await windowsState(run.app);
  const selected = desktopLaunchOptions(run.launchOptions(extra));
  const second = run.spawn(selected.executablePath, selected.args, {
    env: selected.env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const [code] = await within(once(second, 'exit'), 30_000, 'Второй экземпляр не завершился.');

  assert.equal(code, 0);
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const after = await windowsState(run.app);

  assert.equal(after.length, before.length);
  assert.equal(after.some((window) => window.visible && window.url.startsWith(run.origin + '/')), false);
  assert.equal((await readFile(run.gatePid, 'utf8')).trim(), gate);
  assert.deepEqual(await fixtureEntries(run), []);
  await run.app.close();
  assert.equal((await run.exited)[0], 0);
});

test('SE-07: после показа перезагрузка и 401 не создают заставку', options, async (t) => {
  const run = await createRun(t);

  if (!run) {
    return;
  }

  const authKey = randomBytes(32).toString('base64url');

  await mkdir(path.dirname(run.keyFile), { recursive: true, mode: 0o700 });
  await writeFile(run.keyFile, authKey, { mode: 0o600 });

  const stub = await startStub({
    port: run.port,
    authKey,
  });

  t.after(() => stub.close());
  await run.launch();

  const { page } = await waitForMain(run);

  await page.locator('#stub').waitFor();
  run.splashSeen = false;
  await page.reload();
  await page.locator('#stub').waitFor();
  stub.revokeSessions();
  await page.reload().catch(() => undefined);
  await page.locator('#stub').waitFor({ timeout: 20_000 });
  assert.equal(run.splashSeen, false);
  assert.equal((await windowsState(run.app)).length, 1);
});

test('SE-08: чужой HTTP на порту — отказ «это не GrigDesk», чужой сервер жив', options, async (t) => {
  const run = await createRun(t);

  if (!run) {
    return;
  }

  const foreign = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });

  await new Promise((resolve) => foreign.listen(run.port, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => foreign.close(resolve)));
  await run.launch();
  await expectFailure(run, /это не GrigDesk\./u);
  assert.equal((await fetch(run.origin + '/api/auth/state')).status, 200);
});

test('SE-09: закрытие настроек не выключает приложение; закрытие главного — код 0', options, async (t) => {
  const run = await createRun(t);

  if (!run) {
    return;
  }

  await run.launch();

  const { page } = await waitForMain(run);

  await page.locator('#stub').waitFor();

  const pid = await startedPid(run);
  const opened = run.app.waitForEvent('window');

  await page.evaluate((origin) => window.open(origin + '/?window=settings#/settings'), run.origin);

  const child = await opened;

  await child.locator('#stub').waitFor();
  await run.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((window) => window.isModal())?.close();
  });
  await waitFor(async () => (await windowsState(run.app)).length === 1);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(run.child.exitCode, null);
  assert.equal(await alive(pid), true);
  await run.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close();
  }).catch(() => undefined);

  const [code] = await within(run.exited, 60_000, 'Приложение не вышло после закрытия главного окна.');

  assert.equal(code, 0);
  await waitFor(async () => !await alive(pid), 10_000, 'Свой сервер жив после выхода.');
});

test('SE-10: настоящий GrigDesk под приложением (нестабильный)', { timeout: 240_000 }, async (t) => {
  const webDist = process.env.GRIGDESK_E2E_WEB_DIST;

  if (!webDist) {
    t.skip('Не задан GRIGDESK_E2E_WEB_DIST со сборкой web.');

    return;
  }

  const run = await createRun(t);

  if (!run) {
    return;
  }

  const real = path.join(run.root, 'real');
  const envFile = path.join(real, '.env');

  await mkdir(path.join(real, 'deploy'), { recursive: true });
  await symlink(path.join(repo, 'server'), path.join(real, 'server'));
  await symlink(path.join(repo, 'shared'), path.join(real, 'shared'));
  await writeFile(path.join(real, 'deploy/require-vpn.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  await writeFile(envFile, 'GRIGDESK_REQUIRE_VPN=0\n');
  assert.notEqual(await realpath(envFile), await realpath(path.join(repo, '.env')).catch(() => ''));
  await writeRuntimeDescriptor(run.runtimeFile, real);
  await run.launch({
    ...isolatedEnv(real, run.port),
    GRIGDESK_ENV_FILE: envFile,
    GRIGDESK_WEB_DIST: webDist,
    GRIGDESK_LOG: path.join(run.root, 'grigdesk-server.log'),
  });

  const { page } = await waitForMain(run, 200_000);

  await page.locator('.shell').waitFor({ timeout: 60_000 });

  const server = await page.evaluate(async () => (await fetch('/api/system/server')).json());

  assert.equal(server.mode, 'desktop');
  assert.equal(server.systemd, false);
  await run.app.close();
  assert.equal((await run.exited)[0], 0);
  await waitFor(async () => !await alive(server.pid), 60_000, 'Настоящий сервер жив после выхода.');
  assert.equal(await probeGrigDesk(run.origin), 'refused');
});

test('SE-11: перезапуск своего сервера кодом 75 — новое поколение без заставки', options, async (t) => {
  const run = await createRun(t);

  if (!run) {
    return;
  }

  await run.launch();

  const { page } = await waitForMain(run);

  await page.locator('#stub').waitFor();

  const first = await startedPid(run);

  const listening = async () => (await fixtureEntries(run))
    .filter((entry) => entry.event === 'listen').length;

  run.splashSeen = false;
  process.kill(first, 'SIGUSR2');
  await waitFor(async () => await listening() === 2, 60_000, 'Новое поколение сервера не поднялось.');

  const second = await startedPid(run, 1);

  assert.notEqual(second, first);
  assert.equal(await alive(first), false);
  await page.reload().catch(() => undefined);
  await page.locator('#stub').waitFor({ timeout: 30_000 });
  assert.equal(run.splashSeen, false);
  await run.app.close();
  assert.equal((await run.exited)[0], 0);
  await waitFor(async () => !await alive(second), 10_000, 'Новое поколение живо после выхода.');
});

test('SE-12: геометрия и вид заставки', options, async (t) => {
  const run = await createRun(t);

  if (!run) {
    return;
  }

  await run.launch({ GRIGDESK_E2E_FIXTURE_DELAY_MS: '6000' });

  const { page } = await waitForSplash(run);
  const geometry = await run.app.evaluate(({ BrowserWindow, screen }) => {
    const splash = BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().endsWith('/splash/index.html'));

    return {
      bounds: splash.getBounds(),
      workArea: screen.getPrimaryDisplay().workArea,
      background: splash.getBackgroundColor(),
    };
  });

  assert.deepEqual(geometry.bounds, splashBounds(geometry.workArea));
  assert.equal(geometry.background.toLowerCase(), '#15191f');

  const text = await page.evaluate(() => {
    const status = document.querySelector('.status');
    const rect = status.getBoundingClientRect();
    const style = getComputedStyle(status);

    return {
      left: rect.left,
      bottom: innerHeight - rect.bottom,
      fontSize: style.fontSize,
      color: style.color,
      background: getComputedStyle(document.body).backgroundColor,
    };
  });

  assert.ok(Math.abs(text.left - 24) <= 1, String(text.left));
  assert.ok(Math.abs(text.bottom - 24) <= 1, String(text.bottom));
  assert.equal(text.fontSize, '14px');
  assert.equal(text.color, 'rgb(231, 234, 240)');
  assert.equal(text.background, 'rgb(21, 25, 31)');

  if (process.env.GRIGDESK_E2E_ARTIFACTS) {
    await mkdir(process.env.GRIGDESK_E2E_ARTIFACTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.GRIGDESK_E2E_ARTIFACTS, 'splash.png') });
  }

  await waitForMain(run);
});

test('SE-13: сервер не отвечает и runtime.json нет — отказ «не установлен»', options, async (t) => {
  const run = await createRun(t, { descriptor: false });

  if (!run) {
    return;
  }

  await rm(run.runtimeFile, { force: true });
  await run.launch();
  await expectFailure(run, /не установлен для приложения/u);
});

test('SE-14: SIGTERM приложению после показа — код 0, свой сервер завершён', options, async (t) => {
  const run = await createRun(t);

  if (!run) {
    return;
  }

  await run.launch();
  await waitForMain(run);

  const pid = await startedPid(run);

  run.child.kill('SIGTERM');

  const [code] = await within(run.exited, 60_000, 'Приложение не вышло после SIGTERM.');

  assert.equal(code, 0);
  await waitFor(async () => !await alive(pid), 10_000, 'Свой сервер жив после SIGTERM приложению.');
});

test('SE-15: закрытие заставки до показа не трогает settings.json', options, async (t) => {
  const run = await createRun(t);

  if (!run) {
    return;
  }

  const file = path.join(run.dataDir, 'settings.json');
  const content = JSON.stringify({
    version: 1,
    connection: null,
    window: {
      width: 1111,
      height: 777,
      maximized: true,
    },
  }) + '\n';

  await mkdir(run.dataDir, { recursive: true });
  await writeFile(file, content);
  await run.launch({ GRIGDESK_E2E_GATE_HOLD: run.gatePid });
  await waitFor(async () => /^\d+$/u.test((await readFile(run.gatePid, 'utf8')).trim()));
  await closeSplashLikeHuman(run);

  const [code] = await within(run.exited, 20_000, 'Приложение не вышло после закрытия заставки.');

  assert.equal(code, 0);
  assert.equal(await readFile(file, 'utf8'), content);
});

// Нестабильный: 95 с свободный порт сценария никто не держит, и под общей нагрузкой (например,
// параллельный run-all) его может занять чужой HTTP — приложение верно ответит «не GrigDesk».
test('SE-16: VPN дольше 90 с не роняет старт — окно ждёт ворота (нестабильный)', {
  timeout: 240_000,
}, async (t) => {
  const run = await createRun(t);

  if (!run) {
    return;
  }

  const open = path.join(run.root, 'vpn-up');
  const started = Date.now();

  await run.launch({ GRIGDESK_E2E_GATE_OPEN_FILE: open });
  await waitForSplash(run);
  await new Promise((resolve) => setTimeout(resolve, 95_000));
  assert.equal(run.child.exitCode, null, `Окно вышло во время ожидания VPN: ${run.stderr.slice(-1500)}`);
  assert.equal(run.stderr.includes('GrigDesk: '), false, run.stderr.slice(-1500));
  assert.deepEqual(await fixtureEntries(run), []);
  await writeFile(open, '');
  await waitForMain(run, 60_000);
  assert.ok(Date.now() - started > 95_000);
  assert.equal(run.stderr.includes('GrigDesk: '), false, run.stderr.slice(-1500));
  await run.app.close();
  assert.equal((await run.exited)[0], 0);
});
