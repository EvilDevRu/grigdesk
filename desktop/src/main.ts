import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  safeStorage,
  screen,
  session,
  shell,
} from 'electron';
import type { BrowserWindowConstructorOptions, Session } from 'electron';
import type { ChildProcess } from 'node:child_process';
import { closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { delayWithAbort } from '../../shared/lib/delay.ts';

import { probeGrigDesk } from '../../shared/runtime/grigDeskReadiness.ts';
import { desktopUserAgent } from '../../shared/desktop/desktopWindowContract.ts';
import { uiReleaseUrl } from '../../shared/runtime/uiRelease.ts';
import { publishUiRelease } from './uiRelease.ts';
import { createSettingsWindow } from './settingsWindowFactory.ts';
import type { SettingsWindowController } from './settingsWindowController.ts';

import { windowKeyPath } from '../../shared/desktop/windowKeyPath.ts';
import { ensureSession, sessionCookieActive } from './autoLogin.ts';
import { localPort, resolveConnection } from './connection.ts';
import { createConnectionLifecycle } from './connectionLifecycle.ts';
import { loadDocument, loadPinnedDocument } from './windowDocuments.ts';
import type { ConnectionLifecycle } from './connectionLifecycle.ts';
import {
  applicationMenuTemplate, contextMenuTemplate, isReloadShortcut, isSettingsShortcut,
} from './menu.ts';
import { grigDeskAlive, offlineUrl, waitForGrigDesk } from './offline.ts';
import { accessUnavailableUrl } from './accessUnavailable.ts';
import { createQuitController } from './quitController.ts';
import { loadServerRuntime, runtimeDependencies } from './runtimeConfig.ts';
import type { ServerRuntime } from './runtimeConfig.ts';
import { openServerLog, readUnitState, runVpnGate, spawnServer } from './serverProcess.ts';
import { createServerSupervisor } from './serverSupervisor.ts';
import { readSettings, writeSettings } from './settings.ts';
import type { DesktopSettings } from './settings.ts';
import { guardSplash, splashBounds, splashWindowOptions } from './splashWindow.ts';
import {
  createFrameTracker,
  createStartupController,
  FRAME_LIMIT_MS,
  STARTUP_DEADLINE_MS,
  STARTUP_HOLD_LIMIT_MS,
} from './startupController.ts';
import type { StartupPhase } from './startupController.ts';
import { requireProtectedStorage } from './storageProtection.ts';
import {
  configureSession,
  guardContents,
  LOCAL_PARTITION,
  sameOrigin,
  windowOptions,
} from './windowSecurity.ts';

let settingsController: SettingsWindowController | null = null;
let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let localSession: Session | null = null;
let lifecycle: ConnectionLifecycle | null = null;
let settings: DesktopSettings | null = null;
let settingsFile: string | null = null;
let saving: Promise<void> = Promise.resolve();
// Адрес выбирается при подготовке старта; supervisor проверяет именно его.
let selectedOrigin: string | null = null;
let pinnedUi: { id: string; url: string } | null = null;
// Код последнего главного документа своего origin: показ окна — только после 200.
let mainDocumentCode: number | null = null;
let connected = false;
let bootStartedAt = 0;
let exiting = false;

const configuredWindows = new WeakSet<BrowserWindow>();
const frames = createFrameTracker();

app.setName('GrigDesk');

const dataDirectory = process.env.GRIGDESK_DESKTOP_DATA_DIR;

if (dataDirectory !== undefined) {
  if (!path.isAbsolute(dataDirectory)) {
    dialog.showErrorBox('GrigDesk', 'Каталог данных приложения должен быть абсолютным.');
    app.exit(1);
  } else {
    app.setPath('userData', dataDirectory);
  }
}

app.enableSandbox();

function writeLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

function setTimer(ms: number, callback: () => void): () => void {
  const timer = setTimeout(callback, ms);

  return () => clearTimeout(timer);
}

/**
 * Свой сервер пишет stdout и stderr в журнал; дескриптор main закрывает сразу после spawn.
 * Постоянный обработчик error не даёт позднему отказу kill уронить главный процесс.
 */
function startOwnServer(runtime: ServerRuntime): ChildProcess {
  const descriptor = openServerLog(runtime.logPath);

  try {
    const child = spawnServer(runtime, descriptor);

    child.on('error', (error) => writeLog(`GrigDesk: процесс сервера: ${error.message}`));

    return child;
  } finally {
    closeSync(descriptor);
  }
}

// Каталог пакета для очистки окружения своего сервера: распакованный AppRun не экспортирует APPDIR.
const packageDir = app.isPackaged ? path.dirname(process.execPath) : null;

const supervisor = createServerSupervisor({
  loadRuntime: () => loadServerRuntime({
    env: process.env,
    home: os.homedir(),
    deps: runtimeDependencies,
    appDir: packageDir,
    bundledUi: true,
  }),
  probe: (signal) => probeGrigDesk(selectedOrigin ?? '', { signal }),
  unitState: (signal) => readUnitState(signal),
  runGate: (runtime, signal) => runVpnGate(runtime, signal),
  spawnServer: (runtime) => startOwnServer(runtime),
  sleep: (ms, signal) => delayWithAbort(ms, signal),
  now: () => Date.now(),
  log: (message) => writeLog(message),
});

/**
 * Окно показано: дальше перезагрузка, 401 и потеря связи идут обычным offline-путём.
 * До показа те же события остаются частью старта и не трогают главное окно.
 */
function revealed(): boolean {
  return startup.state === 'revealed';
}

/**
 * Второй экземпляр после показа возвращает главное окно, не меняя его подключение.
 * Открытое окно настроек получает фокус вместо главного.
 */
function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (settingsController?.focusOpen()) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

/**
 * Второй экземпляр во время старта поднимает заставку, главное окно ещё скрыто.
 * Уже уничтоженная заставка запрос игнорирует.
 */
function focusSplash(): void {
  const window = splashWindow;

  if (!window || window.isDestroyed()) {
    return;
  }

  if (window.isMinimized()) {
    window.restore();
  }

  window.show();
  window.focus();
}

/**
 * Программное закрытие заставки — только destroy(): он не порождает 'close',
 * поэтому не путается с закрытием человеком.
 */
function destroySplash(): void {
  const window = splashWindow;

  splashWindow = null;

  if (window && !window.isDestroyed()) {
    window.destroy();
  }
}

/**
 * Только главное окно сохраняет обычные размеры и признак maximized.
 * Ошибку записи увидит контроллер выхода, который ждёт `saving`.
 */
function saveMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed() || !settings || !settingsFile) {
    return;
  }

  const bounds = mainWindow.getNormalBounds();

  settings = {
    ...settings,
    window: {
      width: bounds.width,
      height: bounds.height,
      maximized: mainWindow.isMaximized(),
    },
  };
  saving = writeSettings(settingsFile, settings);
  saving.catch(() => undefined);
}

/**
 * Ссылка вызывает текущий метод shell при каждом обращении, включая подмену E2E.
 * Отказ системного браузера завершается внутри adapter без необработанного Promise.
 */
function openExternal(url: string): Promise<void> {
  return shell.openExternal(url).catch(() => undefined);
}

/**
 * Главное и дочерние окна получают одинаковые guards и контекстное меню.
 * Защита потомков ставится синхронно при did-create-window, без отдельного входа.
 */
function configureWindow(
  window: BrowserWindow,
  origin: string,
  options: BrowserWindowConstructorOptions,
): void {
  if (configuredWindows.has(window)) {
    return;
  }

  configuredWindows.add(window);
  window.setMenuBarVisibility(false);
  window.webContents.on('before-input-event', (event, input) => {
    // Одиночный Alt не показывает меню и не уходит в страницу.
    // Сочетания с Alt обрабатываются по основной клавише, включая Ctrl+Alt+S.
    if (input.key === 'Alt' || isReloadShortcut(input)) {
      event.preventDefault();
    }
  });
  guardContents(window.webContents, {
    origin,
    openExternal,
    childOptions: options,
    onSettingsRequest: () => {
      void settingsController?.open();
    },
    onChild: (child) => configureWindow(child, origin, options),
  });
  window.webContents.on('context-menu', (_event, params) => {
    const template = contextMenuTemplate(params, (url) => clipboard.writeText(url));

    if (template.length > 0 && !window.isDestroyed()) {
      Menu.buildFromTemplate(template).popup({ window });
    }
  });
}

/**
 * Нативный ввод обрабатывается до страницы, включая xterm с preventDefault.
 * Оба управляемых окна открывают или фокусируют единственное окно настроек.
 */
function installSettingsShortcut(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (isSettingsShortcut(input)) {
      event.preventDefault();
      void settingsController?.open();
    }
  });
}

/**
 * Отказ рабочей фазы окна — тот же выход с кодом 1 и сообщением, что и отказ старта.
 * Повторные отказы присоединяются к уже идущему выходу.
 */
function fatal(error: unknown): void {
  void quit.request({
    reason: 'failure',
    exitCode: 1,
    message: error instanceof Error && error.message ? error.message : 'Окно не удалось запустить.',
  });
}

/**
 * Отказ показывается нативным окном без родителя: главное окно может быть скрыто.
 * dialog берётся в момент вызова; сигнал процесса закрывает окно через signal.
 */
async function showFatalDialog(message: string, signal: AbortSignal): Promise<void> {
  if (!app.isReady()) {
    return;
  }

  await dialog.showMessageBox({
    type: 'error',
    title: 'GrigDesk',
    message,
    buttons: ['Закрыть'],
    signal,
  });
}

/**
 * Ожидание VPN-ворот своего сервера: после загрузки машины VPN поднимается минутами, а
 * служба в этом случае ждала молча. Такое ожидание не расходует срок старта окна.
 */
function waitingForVpn(): boolean {
  return supervisor.waitReason?.startsWith('VPN-ворота') === true;
}

/**
 * Сообщение о сроке называет фазу, на которой старт остановился.
 * Для сервера добавляется то, чего supervisor ждал последним.
 */
function timeoutMessage(phase: StartupPhase): string {
  if (phase === 'splash') {
    return 'Заставка не загрузилась за 90 секунд.';
  }

  if (phase === 'server') {
    const reason = supervisor.waitReason;

    if (waitingForVpn()) {
      return `VPN не поднялся за 10 минут (${reason}).`;
    }

    return reason
      ? `Сервер GrigDesk не готов за 90 секунд (${reason}).`
      : 'Сервер GrigDesk не готов за 90 секунд.';
  }

  if (phase === 'connect') {
    return 'Не удалось войти по локальному ключу за 90 секунд.';
  }

  return 'Интерфейс GrigDesk не отрисовался.';
}

/**
 * Заставка показывается, когда разрешился loadFile и пришёл ready-to-show: встречаются
 * оба порядка. Обещание разрешается на 'show' — от него считается минимум показа.
 */
function showSplash(signal: AbortSignal): Promise<void> {
  const splashSession = session.fromPartition('grigdesk-splash');
  const window = new BrowserWindow(splashWindowOptions({
    icon: path.join(__dirname, 'icon.png'),
    packaged: app.isPackaged,
    bounds: splashBounds(screen.getPrimaryDisplay().workArea),
    session: splashSession,
  }));

  splashWindow = window;
  window.removeMenu();
  guardSplash(window.webContents, splashSession);
  // destroy() не порождает 'close': это событие означает закрытие заставки человеком.
  window.on('close', () => {
    void quit.request({
      reason: 'splash-closed',
      exitCode: 0,
    });
  });

  return new Promise((resolve, reject) => {
    let loaded = false;
    let painted = false;
    let settled = false;

    /**
     * Один исход на заставку: показ, отказ загрузки или отмена старта.
     * Подписка на отмену снимается при любом исходе.
     */
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      signal.removeEventListener('abort', cancel);

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const cancel = () => finish(new Error('Старт окна отменён.'));

    /**
     * Показ ждёт оба условия: документ загружен и пришёл ready-to-show.
     * 'show' может прийти синхронно, поэтому видимость проверяется и сразу после вызова.
     */
    const show = () => {
      if (!loaded || !painted || settled || window.isDestroyed()) {
        return;
      }

      window.once('show', () => finish());
      window.show();

      if (window.isVisible()) {
        finish();
      }
    };

    window.once('ready-to-show', () => {
      painted = true;
      show();
    });
    signal.addEventListener('abort', cancel, { once: true });
    window.loadFile(path.join(__dirname, 'splash', 'index.html')).then(() => {
      loaded = true;
      show();
    }, (error: unknown) => {
      const detail = error instanceof Error ? ` ${error.message}` : '';

      finish(new Error(`Заставка не загрузилась.${detail}`));
    });
  });
}

/**
 * Создаёт скрытое главное окно со всеми обработчиками и lifecycle, без показа.
 * До показа offline и страница отказа ничего не грузят, а повтор входа — через 500 мс.
 */
async function createMainWindow(
  origin: string,
  runtime: ServerRuntime | null,
  stored: DesktopSettings,
): Promise<void> {
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate({
    openSettings: () => {
      void settingsController?.open();
    },
  })));

  const grigDeskSession = session.fromPartition(LOCAL_PARTITION);

  localSession = grigDeskSession;
  await configureSession(grigDeskSession, origin);

  const base = windowOptions(path.join(__dirname, 'icon.png'), app.isPackaged, stored.window);
  const options: BrowserWindowConstructorOptions = {
    ...base,
    webPreferences: {
      ...base.webPreferences,
      session: grigDeskSession,
    },
  };
  const window = new BrowserWindow(options);
  // Ярлык запускает приложение без --grigdesk-url и пути ключа: путь берётся из окружения сервера.
  const keyFile = windowKeyPath({
    env: runtime?.env ?? process.env,
    uid: process.getuid?.(),
    port: localPort(origin),
  });
  const connection = createConnectionLifecycle({
    origin,
    alive: (signal) => grigDeskAlive(origin, { signal }),
    wait: (signal) => waitForGrigDesk(origin, { signal }),
    ensureSession: (signal) => ensureSession({
      origin,
      keyFile,
      cookies: grigDeskSession.cookies,
      signal,
    }),
    loadOffline: (signal) => revealed()
      ? loadDocument(window, offlineUrl(origin), signal)
      : Promise.resolve(),
    showUnavailable: (signal) => revealed()
      ? loadDocument(window, accessUnavailableUrl(origin), signal)
      : Promise.resolve(),
    /**
     * Проверяет выбранную версию до загрузки документа и сохраняет её при восстановлении входа.
     * Старый сервер не подменяет интерфейс рабочей сборкой и не запускает бесконечный retry.
     */
    loadGrigDesk: (address, signal) => loadPinnedDocument({
      fetch: (url, init) => grigDeskSession.fetch(url, init),
      pinned: pinnedUi,
      window,
      address,
      signal
    }),
    onConnected: () => {
      connected = true;
    },
    retryMs: () => revealed() ? 10_000 : 500,
  });

  mainWindow = window;
  window.webContents.setUserAgent(desktopUserAgent(window.webContents.getUserAgent(), 'main'));
  installSettingsShortcut(window);
  settingsController = createSettingsWindow({
    parent: window,
    session: grigDeskSession,
    origin,
    icon: path.join(__dirname, 'icon.png'),
    packaged: app.isPackaged,
    createWindow: (childOptions) => new BrowserWindow(childOptions),
    workArea: (bounds) => screen.getDisplayMatching(bounds).workArea,
    revealed,
    sessionActive: () => sessionCookieActive({ origin, cookies: grigDeskSession.cookies }),
    pinnedUrl: () => pinnedUi?.url,
    configureChild: (child) => configureWindow(child, origin, options),
    installShortcut: installSettingsShortcut,
    showLoadError: () => dialog.showErrorBox('GrigDesk', 'Не удалось открыть настройки.')
  });
  lifecycle = connection;
  configureWindow(window, origin, options);
  // У ни разу не показанного окна ready-to-show приходит на каждый документ: это кадр.
  window.on('ready-to-show', () => frames.painted());
  window.on('close', () => {
    if (revealed() && !quit.stopping) {
      saveMainWindow();
    }
  });
  window.on('closed', () => {
    connection.stop();
    mainWindow = null;
    void quit.request({
      reason: 'main-closed',
      exitCode: 0,
    });
  });
  window.webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (sameOrigin(url, origin)) {
      void connection.loadFailed({
        code,
        url,
        isMainFrame,
      }).catch(fatal);
    }
  });
  // Решение о восстановлении входа принимает lifecycle: окно передаёт только
  // адрес главного документа и код ответа, включая навигацию внутри страницы.
  // Сбой восстановления обрабатывается как сбой загрузки, а не теряется.
  window.webContents.on('did-navigate', (_event, url, httpResponseCode) => {
    if (sameOrigin(url, origin)) {
      frames.navigated();
      mainDocumentCode = httpResponseCode;
    }

    void connection.navigated({
      url,
      httpResponseCode,
    }).catch(fatal);
  });
  window.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    void connection.navigated({
      url,
      isMainFrame,
    }).catch(fatal);
  });
}

/**
 * Подготовка после показа заставки: настройки, установка сервера, адрес и скрытое окно.
 * Затем supervisor — единственный опрос сервера на время старта, при нужде свой запуск.
 */
async function prepare(signal: AbortSignal): Promise<void> {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');

  const stored = await readSettings(settingsFile);

  signal.throwIfAborted();

  const loaded = await loadServerRuntime({
    env: process.env,
    home: os.homedir(),
    deps: runtimeDependencies,
    appDir: packageDir,
    bundledUi: true,
  });

  signal.throwIfAborted();

  const runtime = 'runtime' in loaded ? loaded.runtime : null;
  const resolved = resolveConnection({
    argv: process.argv,
    saved: stored.connection,
    installed: runtime?.origin ?? null,
  });

  if ('error' in resolved) {
    throw new Error(resolved.error);
  }

  stored.connection = resolved.connection;
  settings = stored;
  selectedOrigin = resolved.connection.origin;

  // Без описания установки окно не связано с сервером: папку данных оно не выбирает само,
  // иначе создало бы её до переноса, а в Windows-сборке упало бы на чужом формате пути.
  const releases = runtime
    ? runtime.uiReleasesDir
    : process.env.GRIGDESK_UI_RELEASES_DIR;

  if (releases) {
    if (!path.isAbsolute(releases)) {
      throw new Error('Каталог релизов интерфейса должен быть абсолютным.');
    }

    const source = app.isPackaged
      ? path.join(process.resourcesPath, 'ui') : path.join(__dirname, 'ui');
    const release = await publishUiRelease(source, releases);

    pinnedUi = { id: release.id, url: uiReleaseUrl(selectedOrigin, release.id) };
  } else if (app.isPackaged) {
    throw new Error('Приложение не связано с установкой сервера. Выполните grigdesk-ctl desktop install.');
  }

  signal.throwIfAborted();
  await createMainWindow(selectedOrigin, runtime, stored);
  signal.throwIfAborted();
  // Срок supervisor-а покрывает и удержание на VPN; обычный срок 90 с держит контроллер старта.
  await supervisor.ensure({
    origin: selectedOrigin,
    signal,
    deadline: bootStartedAt + STARTUP_HOLD_LIMIT_MS + STARTUP_DEADLINE_MS,
  });
}

/**
 * Подключение главного окна успешно только по onConnected lifecycle и коду 200
 * последнего главного документа своего origin; иначе отказ с причиной.
 */
async function connectMain(signal: AbortSignal): Promise<void> {
  const connection = lifecycle;

  if (!connection) {
    throw new Error('Главное окно GrigDesk не создано.');
  }

  connected = false;
  await connection.connect();
  signal.throwIfAborted();

  if (!connected) {
    throw new Error('Интерфейс GrigDesk не загрузился.');
  }

  if (mainDocumentCode !== 200) {
    throw new Error(mainDocumentCode
      ? `Интерфейс GrigDesk не загрузился (HTTP ${mainDocumentCode}).`
      : 'Интерфейс GrigDesk не загрузился.');
  }
}

/**
 * Показ синхронно в одном обработчике: развернуть по настройке, показать главное,
 * уничтожить заставку и отдать фокус главному.
 */
function revealMain(): void {
  const window = mainWindow;

  if (!window || window.isDestroyed()) {
    destroySplash();

    return;
  }

  if (settings?.window.maximized) {
    window.maximize();
  }

  window.show();
  destroySplash();
  window.focus();
}

const startup = createStartupController({
  now: () => Date.now(),
  setTimer,
  showSplash: (signal) => showSplash(signal),
  focusSplash: () => focusSplash(),
  prepare: (signal) => prepare(signal),
  connect: (signal) => connectMain(signal),
  waitFrame: (signal) => frames.wait(signal, FRAME_LIMIT_MS, setTimer),
  reveal: () => revealMain(),
  focusMain: () => focusMainWindow(),
  timeoutMessage: (phase) => timeoutMessage(phase),
  holdDeadline: () => waitingForVpn(),
  fail: (message) => {
    void quit.request({
      reason: 'failure',
      exitCode: 1,
      message,
    });
  },
});

const quit = createQuitController({
  cancelStartup: () => {
    startup.cancel();
    lifecycle?.stop();
  },
  closeSplash: () => destroySplash(),
  showError: (message, signal) => showFatalDialog(message, signal),
  stopOwnServer: () => supervisor.stop(),
  revealed: () => revealed(),
  saveWindow: () => {
    saveMainWindow();

    return saving;
  },
  flushCookies: () => localSession?.cookies.flushStore() ?? Promise.resolve(),
  log: (message) => writeLog(message),
  exit: (code) => {
    exiting = true;
    app.exit(code);
  },
});

/**
 * Связка ключей проверяется до заставки: её запрос пароля появится раньше окна.
 * Отказ проверки — тот же выход с диалогом и кодом 1.
 */
async function boot(): Promise<void> {
  try {
    await app.whenReady();
    requireProtectedStorage(safeStorage);
  } catch (error) {
    fatal(error);

    return;
  }

  if (quit.stopping) {
    return;
  }

  bootStartedAt = Date.now();
  await startup.start();
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    if (!quit.stopping) {
      startup.focusRequest();
    }
  });
  app.on('before-quit', (event) => {
    if (exiting) {
      return;
    }

    event.preventDefault();
    void quit.request({
      reason: 'user',
      exitCode: 0,
    });
  });
  app.on('window-all-closed', () => {
    void quit.request({
      reason: 'user',
      exitCode: 0,
    });
  });
  process.on('SIGTERM', () => {
    void quit.request({
      reason: 'signal',
      exitCode: 0,
    });
  });
  process.on('SIGINT', () => {
    void quit.request({
      reason: 'signal',
      exitCode: 0,
    });
  });
  void boot();
} else {
  app.quit();
}
