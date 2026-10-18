import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pluginBootFixture } from '../../server/helpers/pluginBootFixture.js';
import { desktopLaunchOptions, launchDesktop } from './launch.mjs';
import { startStub } from './stub.mjs';
import { chromium } from '../../../desktop/node_modules/playwright-core/index.mjs';
import { artifactsPath } from '../../../shared/runtime/dataHome.ts';

const desktop = path.resolve(import.meta.dirname, '../../../desktop');
const screens = path.join(artifactsPath({ env: process.env, home: homedir() }), 'desktop-window-e2e/screens');
const options = { timeout: 90_000 };

/**
 * Ожидание ограничено контрактом теста и проверяет наблюдаемое состояние.
 * Оно не заменяет события окна и HTTP готовностью по фиксированному sleep.
 */
async function waitFor(predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.fail('Наблюдаемое состояние не достигнуто до срока проверки.');
}

/**
 * Один владелец закрывает Electron раньше серверов и удаления файлов.
 * Boot-фикстура регистрирует cleanup в этом же владельце, без гонки разных t.after.
 */
async function createRun(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'desktop-window-e2e-'));
  const dataDir = path.join(root, 'profile');
  const keyFile = path.join(root, 'window-auth/key');
  const stubs = [];
  const bootCleanups = [];
  const children = [];
  const run = {
    root,
    dataDir,
    keyFile,
    current: null,
    bootContext: {
      after: (callback) => bootCleanups.push(callback),
    },
  };

  t.after(async () => {
    try {
      await run.current?.app.close();
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');

          child.kill('SIGKILL');
          await exited;
        }
      }

      for (const stub of stubs) {
        await stub.close();
      }

      for (const cleanup of bootCleanups) {
        await cleanup();
      }

      await rm(root, { recursive: true, force: true });
    }
  });

  run.stub = async (input = {}) => {
    const authKey = input.authKey ?? (run.stubKey ??= randomBytes(32).toString('base64url'));

    await mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    await writeFile(keyFile, authKey, { mode: 0o600 });

    const stub = await startStub({ ...input, authKey });

    stubs.push(stub);

    return stub;
  };
  run.launch = async (address, selectedKey = keyFile, extraEnv = {}) => {
    run.current = await launchDesktop({
      root,
      dataDir,
      args: [desktop, `--grigdesk-url=${address}`],
      env: {
        GRIGDESK_WINDOW_KEY_PATH: selectedKey,
        ...extraEnv,
      },
    });

    return run.current;
  };
  run.closeApp = async () => {
    await run.current?.app.close();
    run.current = null;
  };
  run.spawnSecond = (input) => {
    const selected = desktopLaunchOptions(input);
    const child = spawn(selected.executablePath, selected.args, {
      env: selected.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    children.push(child);
    child.stderr.resume();

    return child;
  };

  return run;
}

/**
 * Перехват проверяется внутри main до первого внешнего клика.
 * Исходный descriptor сохраняется и восстанавливается перед штатным закрытием.
 */
async function interceptShell(app) {
  const installed = await app.evaluate(({ shell }) => {
    const descriptor = Object.getOwnPropertyDescriptor(shell, 'openExternal');
    const original = shell.openExternal;
    const opened = [];
    const replacement = async (url) => {
      opened.push(url);
    };

    globalThis.__opened = opened;
    globalThis.__restoreShell = () => {
      if (descriptor) {
        Object.defineProperty(shell, 'openExternal', descriptor);
      } else {
        shell.openExternal = original;
      }
    };

    try {
      shell.openExternal = replacement;

      if (shell.openExternal !== replacement) {
        Object.defineProperty(shell, 'openExternal', { ...descriptor, value: replacement });
      }
    } catch {
      return false;
    }

    return shell.openExternal === replacement;
  });

  assert.equal(installed, true, 'Перехват shell обязателен до внешних действий.');
}

/**
 * Без готового веба пропускается только соответствующий реальный GrigDesk-сценарий.
 * Заглушки и обязательные dev-проверки продолжаются независимо от наличия сборки веба.
 */
async function requireWeb(t) {
  return requireSettingsWeb(t);
}

/**
 * Публикация ключа следует после listen, поэтому один ответ HTTP её ещё не доказывает.
 * Читается только собственный файл effective env, значение не выводится в assertions.
 */
async function waitForKey(fixture) {
  await waitFor(async () => {
    try {
      return (await readFile(fixture.env.GRIGDESK_WINDOW_KEY_PATH, 'utf8')).length === 43;
    } catch {
      return false;
    }
  });
}

/**
 * Listeners ставятся перед управляемым reload, когда начальная страница уже могла загрузиться.
 * SSE проверяется по заголовкам, а тело постоянного EventSource не ожидается до завершения.
 */
async function verifyWebReload(page) {
  const errors = [];
  const denied = [];

  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() === 401) {
      denied.push(new URL(response.url()).pathname);
    }
  });

  const stream = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/events');

  await page.reload({ waitUntil: 'domcontentloaded' });

  const response = await stream;

  assert.equal(response.status(), 200);
  assert.match(response.headers()['content-type'], /^text\/event-stream/u);
  await page.locator('.shell').waitFor();
  assert.equal(await page.locator('input[type=password]').count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(denied, [], 'Обычная загрузка не получает неожиданных 401.');
}

test('DW-E1: окно загружает выбранный origin с sandbox', options, async (t) => {
  const run = await createRun(t);
  const stub = await run.stub();
  const { app, page } = await run.launch(stub.address);

  await page.locator('#same').waitFor();
  assert.equal(new URL(page.url()).origin, stub.address);
  assert.deepEqual(await page.evaluate(() => [typeof require, typeof process]), ['undefined', 'undefined']);

  const security = await app.evaluate(({ app, BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();

    return {
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
      webviewTag: preferences.webviewTag,
      preload: preferences.preload ?? '',
      noSandbox: app.commandLine.hasSwitch('no-sandbox'),
    };
  });

  assert.deepEqual(security, {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: false,
    preload: '',
    noSandbox: false,
  });

  const paths = stub.observations.requests.map((request) => request.pathname);

  assert.equal(paths[0], '/api/auth/state');
  assert.ok(paths.indexOf('/') > paths.indexOf('/api/auth/state'));
  assert.ok(stub.observations.requests.every((request) => request.host === new URL(stub.address).host));
});

test('DW-E2: дочернее окно видно и использует общую сессию', options, async (t) => {
  const run = await createRun(t);
  const stub = await run.stub();
  const { app, page } = await run.launch(stub.address);
  const childReady = app.waitForEvent('window');

  await page.locator('#same').click();

  const child = await childReady;

  await child.locator('#cookie').waitFor();
  assert.equal(await child.locator('#cookie').textContent(), 'cookie:yes');

  const grandchildReady = app.waitForEvent('window');

  await child.locator('#same').click();

  const grandchild = await grandchildReady;

  await grandchild.locator('#cookie').waitFor();
  assert.equal(await grandchild.locator('#cookie').textContent(), 'cookie:yes');
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const session = windows[0].webContents.session;

    return windows.map((window) => ({
      visible: window.isVisible(),
      sameSession: window.webContents.session === session,
      sandbox: window.webContents.getLastWebPreferences().sandbox,
      contextIsolation: window.webContents.getLastWebPreferences().contextIsolation,
      preload: window.webContents.getLastWebPreferences().preload ?? '',
    }));
  }), Array.from({ length: 3 }, () => ({
    visible: true,
    sameSession: true,
    sandbox: true,
    contextIsolation: true,
    preload: '',
  })));
});

test('DW-E3: внешняя навигация, popup и redirect идут в shell', options, async (t) => {
  const run = await createRun(t);
  const external = await run.stub();
  const stub = await run.stub({ externalOrigin: external.address });
  const { app, page } = await run.launch(stub.address);

  await interceptShell(app);
  await waitFor(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()));
  await page.locator('#ext').click({ trial: true });

  const targets = await page.evaluate(() =>
    ['#ext', '#nav-ext', '#stand', '#redirect'].map((selector) => {
      const bounds = document.querySelector(selector).getBoundingClientRect();

      return {
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
      };
    }));

  // Отменённая main-навигация оставляет ожидание locator в Playwright незавершённым.
  // Нативный mouse.click сохраняет user activation, результат проверяет журнал shell.
  for (const [index, target] of targets.entries()) {
    await page.mouse.click(target.x, target.y);

    try {
      await waitFor(async () => await app.evaluate(() => globalThis.__opened.length) === index + 1);
    } catch (error) {
      t.diagnostic(`DW-E3: клик ${index + 1}, открыто ${JSON.stringify(
        await app.evaluate(() => globalThis.__opened),
      )}`);

      throw error;
    }
  }

  assert.deepEqual(await app.evaluate(() => globalThis.__opened), Object.values(stub.links));
  assert.equal(new URL(page.url()).origin, stub.address);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  assert.deepEqual(external.observations.requests, []);
  await app.evaluate(() => globalThis.__restoreShell());
});

test('DW-E4: уведомления разрешены, геолокация запрещена', options, async (t) => {
  const run = await createRun(t);
  const stub = await run.stub();
  const { page } = await run.launch(stub.address);

  await page.locator('#notify').click();
  await page.waitForFunction(() => document.querySelector('#notification-result').textContent !== '');
  assert.equal(await page.locator('#notification-result').textContent(), 'granted');
  assert.equal(await page.evaluate(async () =>
    (await navigator.permissions.query({ name: 'geolocation' })).state), 'denied');
});

test('DW-E5: SW не регистрируется, обычная сеть работает', options, async (t) => {
  const run = await createRun(t);
  const stub = await run.stub();
  const { page } = await run.launch(stub.address);

  await page.addScriptTag({ url: stub.address + '/assets/probe.js' });
  assert.equal(await page.evaluate(() => globalThis.desktopNetworkProbe), 'loaded');

  for (const url of ['/sw.js', '/sw.js?probe=1']) {
    const rejected = await page.evaluate(async (source) => {
      try {
        await navigator.serviceWorker.register(source);

        return false;
      } catch {
        return true;
      }
    }, url);

    assert.equal(rejected, true);
  }

  assert.equal(stub.observations.swRequests, 0);
  assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0);
});

test('DW-E7: провал reload и восстановление', options, async (t) => {
  const run = await createRun(t);
  const stub = await run.stub();
  const port = new URL(stub.address).port;
  const { page } = await run.launch(stub.address);

  await page.locator('#stub').waitFor();
  await stub.close();
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await page.waitForURL(/^data:/u);
  assert.match(await page.locator('body').textContent(), /Ждём сервер GrigDesk/u);
  await run.stub({ port: Number(port) });
  await page.locator('#stub').waitFor({ timeout: 20_000 });
  assert.equal(new URL(page.url()).origin, stub.address);
});

test('DW-E8: второй экземпляр отдаёт управление первому', options, async (t) => {
  const run = await createRun(t);
  const stub = await run.stub();
  const other = await run.stub();
  const { app, page } = await run.launch(stub.address);

  await page.locator('#stub').waitFor();
  await app.evaluate(({ app }) => {
    globalThis.__secondEvents = 0;
    app.on('second-instance', () => {
      globalThis.__secondEvents += 1;
    });
  });

  const child = run.spawnSecond({
    root: run.root,
    dataDir: run.dataDir,
    args: [desktop, `--grigdesk-url=${other.address}`],
    env: {
      GRIGDESK_WINDOW_KEY_PATH: run.keyFile,
    },
  });

  await waitFor(() => child.exitCode !== null || child.signalCode !== null);
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
  await waitFor(async () => await app.evaluate(() => globalThis.__secondEvents) === 1);
  assert.equal(new URL(page.url()).origin, stub.address);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  assert.deepEqual(other.observations.requests, []);
  await run.closeApp();

  const settings = JSON.parse(await readFile(path.join(run.dataDir, 'settings.json'), 'utf8'));

  assert.equal(settings.connection.origin, stub.address);
});

test('DW-E9: настоящий GrigDesk входит без пароля и открывает SSE', options, async (t) => {
  if (!await requireWeb(t)) {
    return;
  }

  const run = await createRun(t);
  const fixture = await pluginBootFixture(run.bootContext, {
    root: run.root,
    apiSession: false,
    env: { GRIGDESK_WEB_DIST: await requireWeb(t) },
  });

  await waitForKey(fixture);

  const { page } = await run.launch(fixture.address, fixture.env.GRIGDESK_WINDOW_KEY_PATH);

  await page.locator('.shell').waitFor();

  const state = await page.evaluate(async () => (await fetch('/api/auth/state')).json());

  assert.equal(state.configured, true);
  assert.equal(state.method, 'window-key');
  assert.equal(state.authenticated, true);
  await verifyWebReload(page);

  const firstEvent = await page.evaluate(async () => {
    const response = await fetch('/api/events', { signal: AbortSignal.timeout(5000) });
    const reader = response.body.getReader();
    const chunk = await reader.read();

    await reader.cancel();

    return new TextDecoder().decode(chunk.value);
  });

  assert.match(firstEvent, /event: hello/u);
  assert.equal(await page.evaluate(async () =>
    Boolean(await navigator.serviceWorker.getRegistration())), false);
});

test('DW-E10: после показа отсутствующий ключ и неверные права восстанавливаются без формы', options,
  async (t) => {
    const run = await createRun(t);
    const stub = await run.stub();
    const { page } = await run.launch(stub.address);
    const key = await readFile(run.keyFile);

    await page.locator('#stub').waitFor();
    stub.revokeSessions();
    await rm(run.keyFile);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.waitForURL(/^data:/u);
    assert.match(await page.locator('body').textContent(), /Не удалось войти по локальному ключу/u);
    assert.equal(await page.locator('input').count(), 0);
    await writeFile(run.keyFile, key, { mode: 0o644 });
    await chmod(run.keyFile, 0o644);
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    assert.match(page.url(), /^data:/u);
    await chmod(run.keyFile, 0o600);
    await page.locator('#stub').waitFor({ timeout: 20_000 });
    assert.equal(await page.locator('input[type=password]').count(), 0);
  });

test('DW-E11: постоянная сессия переживает окно и сервер без нового обмена', options, async (t) => {
  const run = await launchSettingsGrigDesk(t);

  if (!run) {
    return;
  }

  const before = await readSessions(run);

  assert.equal(Object.keys(before.sessions).length, 1);
  await run.closeApp();
  await restartOwnServer(run);
  Object.assign(run, await run.launch(run.fixture.address, run.fixture.env.GRIGDESK_WINDOW_KEY_PATH));
  await run.page.locator('.shell').waitFor();
  assert.deepEqual(await readSessions(run), before);
});

test('DW-E12: размер и maximized переживают закрытие', options, async (t) => {
  const run = await createRun(t);
  const stub = await run.stub();
  let { app, page } = await run.launch(stub.address);

  await page.locator('#stub').waitFor();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1010, 710);
  });
  await waitFor(async () => await app.evaluate(({ BrowserWindow }) => {
    const bounds = BrowserWindow.getAllWindows()[0].getNormalBounds();

    return bounds.width === 1010 && bounds.height === 710;
  }));

  const childReady = app.waitForEvent('window');

  await page.locator('#same').click();

  const child = await childReady;

  await child.locator('#stub').waitFor();
  await app.evaluate(({ BrowserWindow }) => {
    const child = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().endsWith('/second'));

    child.setSize(820, 630);
    child.close();
  });
  await run.closeApp();
  ({ app, page } = await run.launch(stub.address));
  await page.locator('#stub').waitFor();
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => {
    const bounds = BrowserWindow.getAllWindows()[0].getNormalBounds();

    return [bounds.width, bounds.height];
  }), [1010, 710]);

  const settings = JSON.parse(await readFile(path.join(run.dataDir, 'settings.json'), 'utf8'));

  assert.deepEqual(settings.window, {
    width: 1010,
    height: 710,
    maximized: false,
  });

  await t.test('DW-E12/maximized: восстановление с оконным менеджером', async (subtest) => {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].maximize();
    });

    if (!await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())) {
      subtest.skip('В одноразовом Xvfb нет оконного менеджера.');

      return;
    }

    await run.closeApp();
    ({ app, page } = await run.launch(stub.address));
    await page.locator('#stub').waitFor();
    await waitFor(async () => await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isMaximized()));
  });
});


/**
 * Фикстура получает вход только через собственный ключ, как настоящее окно.
 * Отсутствующий ключ оставляет локальный отказ без подстановки сессионной cookie.
 */
async function launchSettingsStub(t) {
  const run = await createRun(t);
  const authKey = randomBytes(32).toString('base64url');
  const stub = await run.stub({ authKey });
  const launched = await run.launch(stub.address);

  await launched.page.locator('#stub').waitFor();

  return {
    run,
    stub,
    ...launched,
  };
}

/**
 * Listener нового окна ставится раньше запроса из страницы.
 * Контракт модальности проверяется в main, а не по видимости меню.
 */
async function openNativeSettings(app, page, origin) {
  const opened = app.waitForEvent('window');

  await page.evaluate((origin) => window.open(origin + '/?window=settings#/settings'), origin);

  const child = await opened;

  await child.locator('#stub').waitFor();

  return child;
}

/**
 * Нативное событие проходит before-input-event в отличие от клавиш CDP.
 * Выбирается окно с нужной ролью, даже если модальное окно отключило родителя.
 */
async function sendSettingsShortcut(app, modal = false) {
  await app.evaluate(({ BrowserWindow }, modal) => {
    const window = BrowserWindow.getAllWindows().find((window) => window.isModal() === modal);

    window.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: 'S',
      modifiers: ['control', 'alt'],
    });
  }, modal);
}

test('SW-E01 точный адрес открывает модальное окно', options, async (t) => {
  const { app, page, stub } = await launchSettingsStub(t);
  const child = await openNativeSettings(app, page, stub.address);
  const state = await app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const main = windows.find((window) => !window.getParentWindow());
    const child = windows.find((window) => window !== main);

    return {
      modal: child.isModal(),
      title: child.getTitle(),
      enabled: main.isEnabled(),
    };
  });

  assert.equal(state.modal, true);
  assert.equal(state.title, 'Настройки — GrigDesk');
  assert.equal(state.enabled, false);
  assert.match(await page.evaluate(() => navigator.userAgent), /GrigDeskWindow\/main$/);
  assert.match(await child.evaluate(() => navigator.userAgent), /GrigDeskWindow\/settings$/);
  assert.equal(await child.evaluate(async () => (await (await fetch('/api/auth/state')).json())
    .authenticated), true);
  await child.close();
  await waitFor(() => app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0];

    return main.isEnabled() && BrowserWindow.getFocusedWindow() === main;
  }));
});

test('SW-E02 одно окно на любые запросы', options, async (t) => {
  const { run, app, page, stub } = await launchSettingsStub(t);
  const child = await openNativeSettings(app, page, stub.address);

  await page.evaluate((origin) => {
    window.open(origin + '/?window=settings#/settings');
    window.open(origin + '/?window=settings#/settings');
  }, stub.address);
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items[0].click());
  await sendSettingsShortcut(app);
  await sendSettingsShortcut(app, true);

  const second = run.spawnSecond({
    root: run.root,
    dataDir: run.dataDir,
    args: [desktop, '--grigdesk-url=' + stub.address],
    env: { GRIGDESK_WINDOW_KEY_PATH: run.keyFile },
  });

  await once(second, 'exit');
  await waitFor(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.isModal()));
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2);
  assert.equal(child.isClosed(), false);
});

test('SW-E03 без входа окна нет', options, async (t) => {
  const { run, app, page, stub } = await launchSettingsStub(t);

  stub.revokeSessions();
  await rm(run.keyFile);
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await page.waitForURL(/^data:/u);
  assert.match(await page.locator('body').textContent(), /Не удалось войти по локальному ключу/u);
  await page.evaluate((origin) => window.open(origin + '/?window=settings#/settings'), stub.address);
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items[0].click());
  await sendSettingsShortcut(app);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
});

test('SW-E04 закрытие главного закрывает настройки', options, async (t) => {
  const { run, app, page, stub } = await launchSettingsStub(t);

  await openNativeSettings(app, page, stub.address);

  const closed = app.waitForEvent('close');

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((window) => !window.getParentWindow()).close();
  });
  await closed;
  run.current = null;
});

/**
 * Читается только файл сессий собственного сервера без вывода значений cookie.
 * Число и неизменность записей подтверждают отсутствие повторного обмена ключа.
 */
async function readSessions(run) {
  return JSON.parse(await readFile(run.fixture.env.GRIGDESK_AUTH_SESSIONS, 'utf8'));
}

/**
 * Перезапускается только child, созданный этой фикстурой, на прежнем отдельном порту.
 * Между процессами тест может изменить собственные файлы миграции или сессий.
 */
async function restartOwnServer(run, change = async () => {}) {
  const previous = run.fixture;

  previous.child.kill('SIGKILL');
  await previous.exited;
  await change(previous.env);

  run.fixture = await pluginBootFixture(run.bootContext, {
    root: run.root,
    port: Number(new URL(previous.address).port),
    env: previous.env,
    apiSession: false,
  });
  await waitForKey(run.fixture);
}

/**
 * Потеря сессии моделируется файлом и рестартом своего сервера, без удалённого logout.
 * Настройки закрываются по 401, основной документ восстанавливает тот же раздел по ключу.
 */
async function loseSessionAndRecover(run, child = null) {
  const address = run.page.url();
  const denied = [];
  let markedRequests = 0;
  const observe = (page) => {
    page.on('response', (response) => {
      if (response.status() === 401) {
        denied.push(new URL(response.url()).pathname);
      }
    });
    page.on('request', (request) => {
      if (request.url().endsWith('/api/providers?refresh=1')) {
        markedRequests += 1;
      }
    });
  };

  observe(run.page);

  if (child) {
    observe(child);
  }

  // Ответ наблюдается до рестарта: фоновый GET тоже может первым обнаружить потерю сессии.
  const recovered = run.page.waitForResponse((response) =>
    response.request().isNavigationRequest() && response.status() === 200);

  await restartOwnServer(run, async (env) => {
    const state = await readSessions(run);

    await writeFile(env.GRIGDESK_AUTH_SESSIONS, JSON.stringify({ ...state, sessions: {} }));
  });

  if (child) {
    const closed = child.waitForEvent('close', { timeout: 10_000 });

    await child.evaluate(() => {
      void document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('providers')
        .load(true);
    });

    await closed;
  }

  await run.page.evaluate(() => {
    void document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('providers')
      .load(true);
  });
  await recovered;
  await run.page.locator('.shell').waitFor();
  assert.equal(run.page.url(), address);
  assert.equal(Object.keys((await readSessions(run)).sessions).length, 1, 'Ровно один обмен ключа.');
  assert.equal(markedRequests, child ? 2 : 1, 'Запросы с 401 автоматически не повторяются.');
  assert.ok(denied.length > 0 && denied.length < 12, 'Нет шквала отказов.');
  assert.equal(await run.page.locator('input[type=password]').count(), 0);
}

/**
 * Сквозные настройки используют отдельный свежий бандл до финальной рабочей сборки.
 * Отсутствие файлов является явным NOT RUN, а устаревший интерфейс остаётся FAIL.
 */
async function requireSettingsWeb(t) {
  const directory = process.env.GRIGDESK_E2E_WEB_DIST ?? path.resolve(desktop, '../web/dist');

  try {
    await access(path.join(directory, 'index.html'));

    return directory;
  } catch {
    t.skip('Нет готового бандла index.html.');

    return null;
  }
}

/**
 * Настоящий сервер стартует со своими каталогами и принимает вход через собственный ключ.
 * Listeners ошибок ставятся до действий в обоих документах и проверяются при завершении.
 */
async function launchSettingsGrigDesk(t) {
  const webDist = await requireSettingsWeb(t);

  if (!webDist) {
    return null;
  }

  const run = await createRun(t);
  const fixture = await pluginBootFixture(run.bootContext, {
    root: run.root,
    apiSession: false,
    env: { GRIGDESK_WEB_DIST: webDist },
  });

  await waitForKey(fixture);

  const launched = await run.launch(fixture.address, fixture.env.GRIGDESK_WINDOW_KEY_PATH);
  const errors = [];
  const observe = (page) => page.on('pageerror', (error) => errors.push(error.message));

  observe(launched.page);
  launched.app.on('window', observe);
  t.after(() => assert.deepEqual(errors, []));
  await launched.page.locator('.shell').waitFor();
  Object.assign(run, launched, { fixture, errors });

  return run;
}

/**
 * Listener предшествует клику, null от renderer не используется как признак отказа.
 * Ограниченный срок отличает устаревший web-бандл от отсутствующего файла подготовки.
 */
async function openSettings(run) {
  const opened = run.app.waitForEvent('window', { timeout: 10_000 });

  await run.page.locator('.settings-link').click();

  const page = await opened;

  try {
    await page.locator('[data-settings-window]').waitFor({ timeout: 10_000 });
  } catch {
    assert.fail('Бандл без окна настроек: проверь GRIGDESK_E2E_WEB_DIST.');
  }

  await page.locator('[data-role=settings-nav]').first().waitFor();

  return page;
}

/**
 * Выбор раздела идёт настоящим кликом с прокруткой узкой полосы навигации.
 * aria-current подтверждает смену раздела после обработки события Vue.
 */
async function settingsTab(page, id) {
  const tab = page.locator(`[data-settings-tab=${id}]`);

  await tab.scrollIntoViewIfNeeded();
  await tab.click();
  await waitFor(async () => await tab.getAttribute('aria-current') === 'page');
}

/**
 * Снимки пишутся в папку артефактов, а не во временный root сервера из cleanup.
 * По умолчанию — постоянная папка E2E: указатель чужого прогона может отсутствовать.
 */
async function settingsScreenshot(page, name, screenshotOptions = {}) {
  const directory = process.env.GRIGDESK_E2E_ARTIFACTS ?? screens;

  assert.equal(path.isAbsolute(directory), true, 'Каталог снимков должен быть абсолютным.');

  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name), ...screenshotOptions });
}

test('SW-E05 открытие из верхней панели сохраняет основное окно', options, async (t) => {
  const run = await launchSettingsGrigDesk(t);

  if (!run) {
    return;
  }

  await run.page.evaluate(() => {
    location.hash = '#/chats';
    window.__swMarker = 1;
  });
  await run.page.locator('.agents').waitFor();

  let field = run.page.locator('.composer textarea:enabled').first();

  if (!await field.count()) {
    field = run.page.locator(
      'input[type=text]:enabled, input[type=search]:enabled, textarea:enabled',
    ).first();
    t.diagnostic('SW-E05: composer недоступен, используется поле поиска/формы страницы чатов.');
  }

  if (!await field.count()) {
    await run.page.evaluate(() => {
      const field = document.createElement('input');

      field.id = 'sw-draft-fixture';
      document.querySelector('main').append(field);
    });
    field = run.page.locator('#sw-draft-fixture');
    t.diagnostic('SW-E05: в пустом чате нет доступного поля; добавлено собственное текстовое поле страницы.');
  }

  await field.fill('Несохранённый текст проверки');

  const before = await run.page.evaluate(() => [window.__swMarker, performance.timeOrigin, location.hash]);
  const child = await openSettings(run);

  assert.equal(await run.app.evaluate(({ BrowserWindow }) => {
    const modal = BrowserWindow.getAllWindows().find((window) => window.isModal());

    return Boolean(modal) && !modal.getParentWindow().isEnabled();
  }), true);
  assert.equal(await child.locator('[data-role=settings-nav]').count(), 8);
  assert.equal(await child.locator('.shell, .settings-hero').count(), 0);
  await settingsScreenshot(child, 'settings-1120x820.png');
  await child.close();
  await waitFor(() => run.app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0];

    return main.isEnabled() && BrowserWindow.getFocusedWindow() === main;
  }));
  assert.deepEqual(await run.page.evaluate(() =>
    [window.__swMarker, performance.timeOrigin, location.hash]), before);
  assert.equal(await field.inputValue(), 'Несохранённый текст проверки');
});

test('SW-E06 раздел из ссылки', options, async (t) => {
  const run = await launchSettingsGrigDesk(t);

  if (!run) {
    return;
  }

  await run.page.evaluate(() => {
    localStorage.setItem('grigdesk-settings-tab', 'providers');
    location.hash = '#/board';
  });

  const opened = run.app.waitForEvent('window');

  await run.page.getByText('→ Настройки', { exact: true }).click();

  const child = await opened;

  await child.locator('[data-settings-tab=providers][aria-current=page]').waitFor();
});

test('SW-E07 href #/settings', options, async (t) => {
  const run = await launchSettingsGrigDesk(t);

  if (!run) {
    return;
  }

  await run.page.evaluate(() => {
    location.hash = '#/chats';
  });
  await run.page.locator('.agents').waitFor();

  const opened = run.app.waitForEvent('window');

  await run.page.evaluate(() => {
    location.hash = '#/settings';
  });

  const child = await opened;

  await child.locator('[data-settings-window]').waitFor();
  await waitFor(async () => await run.page.evaluate(() => location.hash) === '#/chats');
});

/**
 * Второй Escape закрывает renderer уже на keyDown, раньше keyUp протокола Playwright.
 * Ошибка закрытого target допускается только вместе с наблюдаемым событием close.
 */
async function closeSettingsWithEscape(page) {
  const closed = page.waitForEvent('close', { timeout: 5000 });

  await page.keyboard.press('Escape').catch((error) => {
    if (!error.message.includes('Target page, context or browser has been closed')) {
      throw error;
    }
  });
  await closed;
}

test('SW-E08 Escape по слоям', options, async (t) => {
  const run = await launchSettingsGrigDesk(t);

  if (!run) {
    return;
  }

  let child = await openSettings(run);

  await settingsTab(child, 'runs');

  const field = child.getByRole('spinbutton', {
    name: 'Порог сжатия контекста чата в токенах', exact: true,
  });

  await field.focus();
  await child.keyboard.press('Escape');
  assert.equal(child.isClosed(), false);
  assert.equal(await field.evaluate((field) => document.activeElement === field), false);
  await closeSettingsWithEscape(child);
  child = await openSettings(run);
  await settingsTab(child, 'access');
  await child.locator('[data-testid=mobile-open-add]').click();
  await child.getByRole('dialog').waitFor();
  await child.keyboard.press('Escape');
  await child.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(child.isClosed(), false);
  await settingsTab(child, 'app');
  await child.locator('[data-testid=hotkey-record-terminal]').click();
  await child.keyboard.press('Escape');
  assert.equal(await child.locator('[data-testid=hotkey-record-terminal]').textContent(), 'Изменить');
  assert.equal(child.isClosed(), false);
  await loseSessionAndRecover(run, child);
});

test('SW-E09 сохранённое доходит до основного окна без перезагрузки', options, async (t) => {
  const run = await launchSettingsGrigDesk(t);

  if (!run) {
    return;
  }

  await run.page.evaluate(() => {
    window.__swMarker = 1;
  });

  let child = await openSettings(run);

  await settingsTab(child, 'app');
  await child.locator('[data-testid=hotkey-record-terminal]').click();
  await child.keyboard.press('Control+Shift+Digit9');
  await child.close();
  await run.page.keyboard.press('Control+Shift+Digit9');
  await run.page.locator('.xterm').first().waitFor();
  child = await openSettings(run);
  await settingsTab(child, 'plugins');

  const nav = run.page.locator('.sidebar a[href="#/inbox"]');
  const hadNav = await nav.count() > 0;
  const tile = child.locator('[data-plugin-id=inbox]');

  await tile.locator('.plugin-tile-power button').click();
  await waitFor(async () => (await nav.count() > 0) !== hadNav);
  t.diagnostic('SW-E09: переключён системный плагин inbox с пунктом навигации.');
  await settingsTab(child, 'runs');

  const field = child.getByRole('spinbutton', { name: 'Порог сжатия контекста чата в токенах', exact: true });

  await field.fill('64000');
  await field.locator('xpath=ancestor::div[contains(@class,"run-value-control")]')
    .getByRole('button', { name: 'Сохранить', exact: true }).click();
  await waitFor(() => run.page.evaluate(() => document.querySelector('#app').__vue_app__
    .config.globalProperties.$pinia._s.get('chat').compactWindow === 64000));
  assert.equal(await run.page.evaluate(() => window.__swMarker), 1);
});

test('SW-E10 установка исполнителя через терминал основного окна', options, async (t) => {
  const run = await launchSettingsGrigDesk(t);

  if (!run) {
    return;
  }

  const child = await openSettings(run);

  await settingsTab(child, 'providers');
  await child.locator('[data-testid=provider-panel]').first().waitFor({ state: 'attached' });

  const toggle = child.locator('[aria-controls^="provider-panel-"]').first();

  await toggle.click();

  const command = child.locator('[data-role=settings-command]:visible').first();
  const insert = (await command.textContent()).trim();

  await command.click();
  await waitFor(() => child.isClosed());
  await run.page.locator('.xterm').first().waitFor();
  await waitFor(async () => (await run.page.locator('.xterm-rows').first().textContent()).includes(insert));

  const before = await run.page.locator('.xterm-rows').first().textContent();

  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(await run.page.locator('.xterm-rows').first().textContent(), before);
  t.diagnostic('SW-E10: команда вставлена, Enter не отправлялся; вывод через 2 с прежний.');
});

test('SW-E11 потеря сессии закрывает настройки, главное входит само', options, async (t) => {
  const run = await launchSettingsGrigDesk(t);

  if (!run) {
    return;
  }

  await run.page.evaluate(() => {
    location.hash = '#/chats';
  });
  await run.page.locator('.agents').waitFor();

  const child = await openSettings(run);

  await loseSessionAndRecover(run, child);
  assert.equal(new URL(run.page.url()).hash, '#/chats');
});

test('SW-E12 Ctrl+Alt+S поверх терминала', options, async (t) => {
  const run = await launchSettingsGrigDesk(t);

  if (!run) {
    return;
  }

  await run.page.evaluate(() => {
    location.hash = '#/terminal';
  });
  await run.page.locator('.xterm').first().waitFor();
  await run.page.locator('.xterm-helper-textarea').first().focus();

  const opened = run.app.waitForEvent('window');

  await sendSettingsShortcut(run.app);

  const child = await opened;

  await child.locator('[data-settings-window]').waitFor();
});

test('SW-E13 узкое окно', options, async (t) => {
  const run = await launchSettingsGrigDesk(t);

  if (!run) {
    return;
  }

  const child = await openSettings(run);

  await run.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((window) => window.isModal()).setSize(800, 600);
  });

  for (const id of ['app', 'speech', 'b24', 'providers', 'runs', 'plugins', 'server', 'access']) {
    await settingsTab(child, id);
    assert.equal(await child.locator('.settings-window-scroll').evaluate((scroll) =>
      scroll.scrollWidth <= scroll.clientWidth + 1), true, id);
  }

  await settingsTab(child, 'app');
  await settingsScreenshot(child, 'settings-800x600.png');
  await settingsTab(child, 'access');
  await child.locator('[data-testid=mobile-open-add]').click();
  await child.getByRole('dialog').waitFor();
  await settingsScreenshot(child, 'settings-dialog.png');
  await loseSessionAndRecover(run, child);
});

test('SW-E14 окно без маркеров — страница', options, async (t) => {
  const run = await launchSettingsGrigDesk(t);

  if (!run) {
    return;
  }

  const opened = run.app.waitForEvent('window');

  await run.page.evaluate(() => window.open('/#/settings'));

  const child = await opened;

  await child.locator('.shell .settings').waitFor();
  assert.doesNotMatch(await child.evaluate(() => navigator.userAgent), /GrigDeskSettings|GrigDeskWindow/);
  assert.equal(await run.app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();

    return windows.length === 2 && windows.every((window) => !window.isModal() && window.isEnabled());
  }), true);
});

test('DW-E13: чистый браузер не получает документ, deep link и JS', options, async (t) => {
  const run = await launchSettingsGrigDesk(t);

  if (!run) {
    return;
  }

  // Отдельный Chromium context не использует cookie Electron и не получает ключ окна.
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });

  t.after(() => browser.close());

  const context = await browser.newContext();
  const page = await context.newPage();
  const asset = await run.page.evaluate(() => document.querySelector('script[type=module]').src);

  for (const pathname of ['/', '/chats', '/#/chats']) {
    const response = await page.goto(run.fixture.address + pathname);

    assert.equal(response.status(), 401);
    assert.match(await page.locator('body').textContent(), /GrigDesk открывается в приложении/u);
    assert.equal(await page.locator('.shell, input[type=password], script').count(), 0);
  }

  const response = await context.request.get(asset);

  assert.equal(response.status(), 401);
  assert.match(response.headers()['content-type'], /application\/json/u);
});

test('DW-E14: старая cookie отзывается, Electron входит снова и сохраняет scope', options, async (t) => {
  const run = await launchSettingsGrigDesk(t);

  if (!run) {
    return;
  }

  const previous = await readSessions(run);
  const oldId = Object.keys(previous.sessions)[0];

  await run.page.evaluate(async () => {
    await fetch('/api/plugins/studio3d/toggle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    const state = await (await fetch('/api/studio3d/state')).json();
    const request = indexedDB.open('grigdesk-studio3d-intents', 1);
    const database = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => request.result.createObjectStore('intents', { keyPath: 'key' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction('intents', 'readwrite');
    const done = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });

    transaction.objectStore('intents').put({
      key: 'legacy-pending',
      owner: 'legacy-owner',
      libraryId: state.libraryId,
      kind: 'run',
      fingerprint: 'legacy',
      at: Date.now(),
      blocked: 'Исход прежнего заказа неизвестен',
      request: { idempotencyKey: 'legacy-pending', libraryId: state.libraryId },
    });
    await done;
    database.close();
  });

  await run.closeApp();
  await restartOwnServer(run, async (env) => {
    await writeFile(env.GRIGDESK_AUTH_ACCOUNT, JSON.stringify({ login: 'legacy-owner', hash: 'unused' }));
    await writeFile(env.GRIGDESK_AUTH_SESSIONS, JSON.stringify(previous.sessions));
  });

  const browser = await chromium.launch({ headless: true, channel: 'chromium' });

  t.after(() => browser.close());

  const context = await browser.newContext();

  await context.addCookies([{
    name: 'grigdesk_sid',
    value: oldId,
    url: run.fixture.address,
  }]);

  const page = await context.newPage();
  const response = await page.goto(run.fixture.address + '/#/chats');

  assert.equal(response.status(), 401);
  Object.assign(run, await run.launch(run.fixture.address, run.fixture.env.GRIGDESK_WINDOW_KEY_PATH));
  await run.page.locator('.shell').waitFor();

  const state = await readSessions(run);
  const scope = await run.page.evaluate(() => document.querySelector('#app').__vue_app__
    .config.globalProperties.$pinia._s.get('auth').clientScope);

  assert.equal(state.clientScope, 'legacy-owner');
  assert.equal(scope, 'legacy-owner');
  assert.equal(Object.keys(state.sessions).length, 1);
  assert.equal(Object.hasOwn(state.sessions, oldId), false);

  await run.page.waitForFunction(() => document.querySelector('#app').__vue_app__
    .config.globalProperties.$pinia._s.get('studio3d')?.pending.length === 1);

  const pending = await run.page.evaluate(() => document.querySelector('#app').__vue_app__
    .config.globalProperties.$pinia._s.get('studio3d').pending[0]);

  assert.equal(pending.key, 'legacy-pending');
  assert.equal(pending.owner, 'legacy-owner');
  assert.equal(pending.blocked, 'Исход прежнего заказа неизвестен');
  assert.equal(pending.request.idempotencyKey, 'legacy-pending');
});

test('DW-E16: восстановление того же hash загружает новый документ', options, async (t) => {
  const run = await createRun(t);
  const stub = await run.stub();
  const { page } = await run.launch(stub.address);

  await page.locator('#stub').waitFor();
  await page.evaluate(() => {
    location.hash = '#/chats';
  });
  stub.revokeSessions();

  const recovered = page.waitForResponse((response) =>
    response.request().isNavigationRequest() && response.status() === 200, { timeout: 5000 });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await recovered;
  await page.locator('#stub').waitFor();
  assert.equal(new URL(page.url()).hash, '#/chats');
  assert.equal(stub.observations.exchanges, 2);
});

test('DW-E15: потеря сессии в чате восстанавливает тот же адрес', options, async (t) => {
  const run = await launchSettingsGrigDesk(t);

  if (!run) {
    return;
  }

  await run.page.evaluate(() => {
    location.hash = '#/chats';
  });
  await run.page.locator('.agents').waitFor();
  await loseSessionAndRecover(run);
});

/**
 * Настоящий новый чат создаётся в отдельном профиле через UI. История синтетическая,
 * исполнитель не запускается; durable запись проверяется штатным методом chat store.
 */
async function launchLayoutChat(t) {
  const run = await launchSettingsGrigDesk(t);

  if (!run) {
    return null;
  }

  await run.page.evaluate(() => {
    localStorage.setItem('grigdesk-chats-list-width', '357');
    localStorage.setItem('grigdesk-chat-composer-h', '140');
    localStorage.setItem('grigdesk-code-dock-nav-width', '330');
    localStorage.setItem('grigdesk-sidebar', '0');
    location.hash = '#/chats';
  });
  await run.page.getByRole('button', { name: 'Новый чат', exact: true }).click();
  await run.page.locator('.cs').waitFor();
  await run.page.evaluate(() => {
    const chat = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat');
    const session = chat.sessions.find((entry) => entry.id === chat.activeId);

    session.title = 'Синтетический разговор геометрии';
    session.messages = Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      text: `Синтетическая реплика ${index + 1}. Проверка чтения и состояния.\n\nВторой абзац.`,
    }));
  });
  await run.page.locator('[data-role=chat-composer]').fill('Черновик проверки геометрии');
  await waitFor(() => run.page.evaluate(() => {
    const chat = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat');

    return chat.sessions.find((entry) => entry.id === chat.activeId)?.draft === 'Черновик проверки геометрии';
  }));
  await run.page.evaluate(async () => {
    const chat = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat');

    await chat._writeChat(chat.activeId);
    window.__duChatNode = document.querySelector('.cs');
  });

  return run;
}

/**
 * Настройки остаются отдельным окном с общими controls.
 * У единственного desktop-вида больше нет переключателя плотности.
 */
async function layoutSettings(run) {
  const child = await openSettings(run);

  await settingsTab(child, 'app');
  assert.equal(await child.getByRole('group', { name: 'Плотность интерфейса' }).count(), 0);

  return child;
}

/**
 * Снимок содержит только геометрию собственного профиля и идентичность документа.
 * Открытие настроек не должно менять ключи размеров или активный разговор.
 */
async function layoutState(page) {
  return page.evaluate(() => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;

    return {
      time: performance.timeOrigin,
      active: pinia._s.get('chat').activeId,
      draft: document.querySelector('[data-role=chat-composer]')?.value,
      sizes: ['grigdesk-chats-list-width', 'grigdesk-chat-composer-h',
        'grigdesk-code-dock-nav-width', 'grigdesk-sidebar'].map((key) => localStorage.getItem(key)),
    };
  });
}

/**
 * Проверяет фактическую область системных кнопок: её нельзя перекрыть настройками
 * или статусами при ресайзе и масштабе, а drag-зоны не должны поглощать их клики.
 */
async function titlebarGeometry(page) {
  return page.evaluate(() => {
    const overlay = navigator.windowControlsOverlay;
    const safe = overlay.getTitlebarAreaRect();
    const header = document.querySelector('.topbar');
    const settings = document.querySelector('.settings-link');
    const mark = document.querySelector('.app-mark');
    const status = document.querySelector('.status');
    const headerBox = header.getBoundingClientRect();
    const settingsBox = settings.getBoundingClientRect();
    const markBox = mark.getBoundingClientRect();

    return {
      visible: overlay.visible,
      safe: safe.toJSON(),
      header: headerBox.toJSON(),
      settings: settingsBox.toJSON(),
      mark: markBox.toJSON(),
      drag: getComputedStyle(header).getPropertyValue('-webkit-app-region'),
      statusDrag: getComputedStyle(status).getPropertyValue('-webkit-app-region'),
      actionsDrag: getComputedStyle(settings.parentElement).getPropertyValue('-webkit-app-region'),
      viewport: innerWidth,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

test('WT-E01 системные кнопки встроены в топбар при ресайзе и масштабе', options, async (t) => {
  const run = await launchSettingsGrigDesk(t);

  if (!run) {
    return;
  }

  await run.page.evaluate(() => {
    window.__titlebarKeys = [];
    document.addEventListener('keydown', (event) => window.__titlebarKeys.push(event.key));
    document.addEventListener('keyup', (event) => window.__titlebarKeys.push(event.key));
  });
  await run.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((entry) => !entry.isModal());

    window.focus();
    window.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: 'Alt',
      modifiers: ['alt'],
    });
    window.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: 'Alt',
    });
    window.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: 'Tab',
    });
    window.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: 'Tab',
    });
  });
  await run.page.waitForFunction(() => window.__titlebarKeys.includes('Tab'));
  assert.equal(await run.page.evaluate(() => window.__titlebarKeys.includes('Alt')), false);
  assert.equal(await run.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((window) => window.isMenuBarVisible())), false);

  for (const [width, zoom] of [[1280, 1], [600, 1], [900, 1.25], [900, 0.8]]) {
    await run.app.evaluate(({ BrowserWindow }, { width, zoom }) => {
      const window = BrowserWindow.getAllWindows().find((entry) => !entry.isModal());

      window.setContentSize(width, 860);
      window.webContents.setZoomFactor(zoom);
    }, { width, zoom });
    await run.page.waitForFunction(({ width, zoom }) =>
      Math.abs(innerWidth - width / zoom) <= 1, { width, zoom });
    await waitFor(async () => {
      const state = await titlebarGeometry(run.page);

      return state.visible && state.safe.width > 0 && state.safe.right < state.viewport
        && state.settings.right <= state.safe.right + 1;
    });

    const state = await titlebarGeometry(run.page);

    assert.equal(state.header.top, 0);
    assert.equal(state.mark.left >= state.safe.left, true);
    assert.equal(state.header.height >= state.safe.height, true);
    assert.equal(state.overflow, false);
    assert.equal(state.drag, 'drag');
    assert.equal(state.statusDrag, 'no-drag');
    assert.equal(state.actionsDrag, 'no-drag');

    const child = await openSettings(run);

    assert.equal(await child.evaluate(() => navigator.windowControlsOverlay.visible), false);
    await child.close();
  }

  await run.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((entry) => !entry.isModal());

    window.webContents.setZoomFactor(1);
    window.setContentSize(1280, 860);
  });
  await run.page.waitForFunction(() => innerWidth === 1280);
  await settingsScreenshot(run.page, 'window-titlebar.png');

  // Скриншот renderer не включает системные кнопки: снимается собственный Xvfb-дисплей.
  const nativeImage = await run.app.evaluate(async ({ desktopCapturer }) => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1280, height: 1024 },
    });

    return sources[0].thumbnail.toPNG().toString('base64');
  });
  const directory = process.env.GRIGDESK_E2E_ARTIFACTS ?? screens;

  await writeFile(path.join(directory, 'window-titlebar-native.png'), Buffer.from(nativeImage, 'base64'));
});

test('DU-E01 первый кадр и прежняя плотность используют одну геометрию', options, async (t) => {
  const run = await launchSettingsGrigDesk(t);

  if (!run) {
    return;
  }

  await run.page.addInitScript(() => {
    const capture = () => {
      const shell = document.querySelector('.shell');

      if (!shell) {
        requestAnimationFrame(capture);

        return;
      }

      window.__duFirstFrame = {
        height: document.querySelector('.topbar').getBoundingClientRect().height,
      };
    };

    requestAnimationFrame(capture);
  });
  await run.page.reload();
  await run.page.waitForFunction(() => Boolean(window.__duFirstFrame));
  assert.deepEqual(await run.page.evaluate(() => window.__duFirstFrame), { height: 36 });
  await run.page.evaluate(() => localStorage.setItem('grigdesk-ui-density', 'compact'));
  await run.page.reload();
  await run.page.waitForFunction(() => Boolean(window.__duFirstFrame));
  assert.deepEqual(await run.page.evaluate(() => window.__duFirstFrame), { height: 36 });
});

test('DU-E02 отдельные настройки сохраняют документ и состояние разговора', options, async (t) => {
  const run = await launchLayoutChat(t);

  if (!run) {
    return;
  }

  const before = await layoutState(run.page);
  const child = await layoutSettings(run);

  assert.deepEqual(await layoutState(run.page), before);
  assert.equal(await run.page.evaluate(() => window.__duChatNode === document.querySelector('.cs')), true);
  assert.equal(await child.locator('.shell, .tool-surface, .xterm').count(), 0);
  await run.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((window) => window.isModal()).setContentSize(800, 600);
  });
  await child.waitForFunction(() => innerWidth === 800 && innerHeight === 600);
  assert.equal(await child.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await settingsScreenshot(child, 'layout-settings.png');
  await child.close();
  await run.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((window) => !window.isModal()).setContentSize(1600, 900);
  });
  await run.page.waitForFunction(() => innerWidth === 1600 && innerHeight === 900);
  // Снимок публикует синтетическую переписку. Метаданные машины закрываются
  // средствами screenshot, не меняя DOM, состояние и проверяемую сборку.
  await settingsScreenshot(run.page, 'layout-main-1600x900.png', {
    mask: [run.page.locator('.host'), run.page.locator('.netbox .ip')],
    maskColor: '#202731',
  });
  assert.deepEqual(await layoutState(run.page), before);
});

test('DU-E03 повтор окна сохраняет размеры и durable черновик', options, async (t) => {
  const run = await launchLayoutChat(t);

  if (!run) {
    return;
  }

  const before = await layoutState(run.page);
  const child = await layoutSettings(run);

  await child.close();
  await run.closeApp();
  Object.assign(run, await run.launch(run.fixture.address, run.fixture.env.GRIGDESK_WINDOW_KEY_PATH));
  run.page.on('pageerror', (error) => run.errors.push(error.message));
  await run.page.locator('.shell').waitFor();
  await run.page.evaluate(() => {
    location.hash = '#/chats';
  });
  await run.page.locator('.cs').waitFor();

  const after = await layoutState(run.page);

  assert.equal(await run.page.locator('.topbar').evaluate((el) => el.getBoundingClientRect().height), 36);
  assert.equal(after.active, before.active);
  assert.equal(after.draft, before.draft);
  assert.deepEqual(after.sizes, before.sizes);
  assert.equal(await run.page.locator('[data-role=chat-composer]')
    .evaluate((el) => el.getBoundingClientRect().height), 140);
});

test('DU-E04 body overlays сохраняют controls, Escape и возврат фокуса', options, async (t) => {
  const run = await launchLayoutChat(t);

  if (!run) {
    return;
  }

  const child = await layoutSettings(run);

  await settingsTab(child, 'access');

  const trigger = child.locator('[data-testid=mobile-open-add]');

  await trigger.click();
  await child.getByRole('dialog').waitFor();
  assert.equal(await child.getByRole('dialog').evaluate((el) =>
    getComputedStyle(el).getPropertyValue('--control-height').trim()), '44px');
  await child.keyboard.press('Escape');
  await child.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(child.isClosed(), false);
  assert.equal(await trigger.evaluate((el) => document.activeElement === el), true);
  await child.close();
  await run.page.locator('.settings-link').hover();
  await run.page.getByRole('tooltip').waitFor();
  assert.equal(await run.page.getByRole('tooltip').evaluate((el) =>
    getComputedStyle(el).getPropertyValue('--control-height').trim()), '36px');
  await run.page.mouse.move(300, 400);

});

test('DU-E05 настройки и ресайз сохраняют terminal/PTY, expanded и Escape', options, async (t) => {
  const run = await launchLayoutChat(t);

  if (!run) {
    return;
  }

  let terminals = 0;

  run.page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname === '/api/terminal') {
      terminals += 1;
    }
  });
  await run.page.locator('.tool-rail [aria-label="Терминал"]').click();
  await run.page.locator('.xterm').waitFor();
  await waitFor(() => terminals === 1);
  await run.page.evaluate(() => {
    window.__duTerminal = document.querySelector('.xterm');
  });

  const child = await layoutSettings(run);

  await child.close();
  await run.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((window) => !window.isModal()).setContentSize(1400, 860);
  });
  await run.page.waitForFunction(() => innerWidth === 1400);
  assert.equal(await run.page.evaluate(() => window.__duTerminal === document.querySelector('.xterm')), true);
  assert.equal(await run.page.locator('.xterm').count(), 1);
  assert.equal(terminals, 1);
  await run.page.getByRole('button', { name: 'Во весь экран', exact: true }).click();
  await run.page.locator('.tool-surface.is-expanded').waitFor();
  assert.equal(await run.page.locator('.content').evaluate((el) => el.inert), true);
  await run.page.keyboard.press('Escape');
  await run.page.locator('.tool-surface.is-expanded').waitFor({ state: 'hidden' });
  assert.equal(await run.page.locator('.tool-surface.is-dock').count(), 1);
  await run.page.keyboard.press('Escape');
  await run.page.locator('.tool-surface.is-dock').waitFor({ state: 'hidden' });
  assert.equal(await run.page.locator('.xterm').count(), 1);
  assert.equal(terminals, 1);
});

test('DU-E06 узкое окно и zoom сохраняют боковую рейку и выбор размеров', options, async (t) => {
  const run = await launchLayoutChat(t);

  if (!run) {
    return;
  }

  const child = await layoutSettings(run);

  await child.close();

  const before = await layoutState(run.page);

  for (const width of [600, 760, 900, 1100, 1280]) {
    await run.app.evaluate(({ BrowserWindow }, width) => {
      BrowserWindow.getAllWindows().find((window) => !window.isModal()).setContentSize(width, 860);
    }, width);
    await run.page.waitForFunction((width) => innerWidth === width, width);
    await waitFor(async () => await run.page.locator('.sidebar').evaluate((el) =>
      Math.abs(el.getBoundingClientRect().width - 36) < 1));
    assert.equal(await run.page.locator('.sidebar').evaluate((el) => {
      const box = el.getBoundingClientRect();

      return box.x === 0 && box.y === 36 && box.height === innerHeight - 36;
    }), true);
    assert.equal(await run.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }

  await run.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((window) => !window.isModal()).webContents.setZoomFactor(1.25);
  });
  await run.page.waitForFunction(() => innerWidth === 1024);
  assert.equal(await run.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await layoutState(run.page), before);
  await settingsScreenshot(run.page, 'layout-zoom-125.png');
});

test('DU-E07 key-only recovery сохраняет геометрию и состояние главного окна', options, async (t) => {
  const run = await launchLayoutChat(t);

  if (!run) {
    return;
  }

  const child = await layoutSettings(run);
  const before = await layoutState(run.page);

  await loseSessionAndRecover(run, child);
  await run.page.locator('.cs').waitFor();

  const after = await layoutState(run.page);

  assert.equal(await run.page.locator('.topbar').evaluate((el) => el.getBoundingClientRect().height), 36);
  assert.equal(after.active, before.active);
  assert.equal(after.draft, before.draft);
  assert.deepEqual(after.sizes, before.sizes);

  const reopened = await openSettings(run);

  assert.equal(await reopened.locator('[data-settings-window]').count(), 1);
});

/**
 * Нативный ввод проходит через before-input-event, в отличие от Playwright keyboard.
 * Контрольный Tab подтверждает доставку, timeOrigin и маркер — сохранение документа.
 */
async function checkReloadBlocked(run, page) {
  const before = await page.evaluate(() => {
    window.__reloadMarker = 'сохранился';
    window.__reloadKeys = [];
    document.addEventListener('keydown', (event) => window.__reloadKeys.push(event.key), true);

    return performance.timeOrigin;
  });

  await run.app.evaluate(({ BrowserWindow }, url) => {
    const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL() === url);

    window.focus();

    for (const [keyCode, modifiers] of [
      ['R', ['control']], ['R', ['control', 'shift']], ['F5', []], ['Alt', ['alt']], ['Tab', []],
    ]) {
      window.webContents.sendInputEvent({
        type: 'keyDown',
        keyCode,
        modifiers,
      });
      window.webContents.sendInputEvent({
        type: 'keyUp',
        keyCode,
        modifiers,
      });
    }
  }, page.url());
  await page.waitForFunction(() => window.__reloadKeys?.includes('Tab')
    || window.__reloadMarker !== 'сохранился');
  assert.deepEqual(await page.evaluate(() => ({
    time: performance.timeOrigin,
    marker: window.__reloadMarker,
    blocked: window.__reloadKeys.filter((key) => ['r', 'R', 'F5', 'Alt'].includes(key)),
  })), {
    time: before,
    marker: 'сохранился',
    blocked: [],
  });
}

test('UI-E01 закреплённая версия переживает замену dist, открывает разделы и настройки',
  { timeout: 150_000 }, async (t) => {
    const run = await createRun(t);
    const working = path.join(run.root, 'working-dist');

    await mkdir(working);
    await writeFile(path.join(working, 'index.html'), '<h1>Рабочая сборка</h1>');

    const fixture = await pluginBootFixture(run.bootContext, {
      root: run.root,
      apiSession: false,
      env: { GRIGDESK_WEB_DIST: working },
      async before({ env }) {
        await mkdir(path.dirname(env.GRIGDESK_PREFS_PATH), { recursive: true });
        await writeFile(env.GRIGDESK_PREFS_PATH, JSON.stringify({
          plugins: {
            studio3d: true,
            ssh: true,
            db: true,
            docker: true,
          },
        }));
      },
    });

    await waitForKey(fixture);

    const launched = await run.launch(fixture.address, fixture.env.GRIGDESK_WINDOW_KEY_PATH, {
      GRIGDESK_UI_RELEASES_DIR: fixture.env.GRIGDESK_UI_RELEASES_DIR,
    });

    Object.assign(run, launched, { fixture });
    await run.page.locator('.shell').waitFor();
    assert.match(new URL(run.page.url()).pathname, /^\/ui\/[a-f0-9]{64}\/$/);

    const errors = [];
    const assets = [];

    run.page.on('pageerror', (error) => errors.push(error.message));
    run.page.on('response', (response) => {
      if (new URL(response.url()).pathname.includes('/assets/')) {
        assets.push({ url: response.url(), status: response.status() });
      }
    });
    await rm(working, { recursive: true });
    await mkdir(working);
    await writeFile(path.join(working, 'index.html'), '<h1>Другая рабочая сборка</h1>');

    for (const [route, selector] of [
      ['pipeline', '.pipeline'], ['sandboxes', '.sandboxes'], ['agents', '.agents-page'],
      ['routes', '.routes-page'], ['projects', '.projects'],
    ]) {
      await run.page.locator(`a[href="#/${route}"]`).first().click();
      await run.page.locator(selector).waitFor();
    }

    for (const [label, selector] of [
      ['Код', '.code-panel'], ['Полка', '.task-shelf-panel'], ['3D', '.studio-panel'],
      ['SSH', '.ssh-panel'], ['Базы', '.db-panel'], ['Докер', '.docker-panel'],
      ['Терминал', '.term-view'],
    ]) {
      await run.page.locator(`.tool-rail [aria-label="${label}"]`).click();
      await run.page.locator(selector).waitFor();
    }

    await checkReloadBlocked(run, run.page);

    const child = await openSettings(run);

    assert.equal(new URL(child.url()).pathname, new URL(run.page.url()).pathname);
    await checkReloadBlocked(run, child);
    await child.close();
    await settingsScreenshot(run.page, 'packaged-ui-after-dist-replacement.png');
    assert.ok(assets.length >= 7, 'Lazy-ресурсы действительно загружались после замены рабочей сборки.');
    assert.ok(assets.every((asset) => asset.status === 200 && /\/ui\/[a-f0-9]{64}\//.test(asset.url)));
    assert.deepEqual(errors, []);

    // Новый документ получает намеренный отказ lazy-ресурса: проверяем видимое сообщение.
    await run.closeApp();
    Object.assign(run, await run.launch(fixture.address, fixture.env.GRIGDESK_WINDOW_KEY_PATH, {
      GRIGDESK_UI_RELEASES_DIR: fixture.env.GRIGDESK_UI_RELEASES_DIR,
    }));
    await run.page.locator('.shell').waitFor();
    await run.page.route(/\/CodePanel-[^/]+\.js$/, (route) => route.abort('failed'));
    await run.page.locator('.tool-rail [aria-label="Код"]').click();
    await run.page.getByRole('alert').filter({ hasText: 'Не удалось загрузить раздел' }).waitFor();
    await settingsScreenshot(run.page, 'packaged-ui-load-error.png');
    await run.page.route(/\/VideoView-[^/]+\.js$/, (route) => route.abort('failed'));
    await run.page.evaluate(() => {
      location.hash = '#/video';
    });
    await run.page.getByText('Не удалось открыть раздел.', { exact: false }).waitFor();
  });
