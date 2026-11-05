import { showStyledContextMenu } from './contextMenu.ts';
import { desktopLocale, desktopText, setDesktopLocale } from './locale.ts';
import { createApplicationLauncher } from './applicationLauncher.ts';
import {
  app,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  safeStorage,
  screen,
  session,
  shell,
} from 'electron';
import type { BrowserWindowConstructorOptions, Rectangle, Session } from 'electron';
import type { ChildProcess } from 'node:child_process';
import { execFile, spawn } from 'node:child_process';

import { createBrowserApi } from './browser/browserApi.ts';
import { createBrowserInputGuard } from './browser/browserInputGuard.ts';
import { createBrowserApps } from './browser/browserApps.ts';
import { createBrowserEvents } from './browser/browserEvents.ts';
import { openExternalBrowser } from './browser/externalBrowser.ts';
import { createNativeBrowserView, browserChildWindowOptions } from './browser/browserView.ts';
import { attachBrowserIpc } from './browser/browserIpc.ts';
import { normalizeBrowserPreferences } from '../../shared/browser/browserContract.ts';
import { cleanDesktopChildEnvironment } from './childEnvironment.ts';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { delayWithAbort } from '../../shared/lib/delay.ts';

import { probeGrigDesk } from '../../shared/runtime/grigDeskReadiness.ts';
import { desktopUserAgent } from '../../shared/desktop/desktopWindowContract.ts';
import { createSettingsRequest } from './settingsRequest.ts';
import { createWindowControls } from './windowControls.ts';
import { attachMainRendererRecovery } from './mainRendererRecovery.ts';
import { createDesktopExitController } from './desktopExitController.ts';
import { createDesktopExitPreference } from './desktopExitPreference.ts';
import { createSurfaceWindows } from './surfaceWindows.ts';
import { fitSurfaceBounds, placeSurfaceBounds } from './surfaceGeometry.ts';
import type { SurfaceTarget } from '../../shared/desktop/surfaceContract.ts';

import { windowKeyPath } from '../../shared/desktop/windowKeyPath.ts';
import { clientUiDirectory } from './clientUi.ts';
import { loadDocument } from './windowDocuments.ts';
import {
  applicationMenuTemplate, contextMenuTemplate, isReloadShortcut, isSettingsShortcut, isHelpShortcut,
} from './menu.ts';
import { createQuitController } from './quitController.ts';
import { loadServerRuntime, runtimeDependencies } from './runtimeConfig.ts';
import type { ServerRuntime } from './runtimeConfig.ts';
import { readUnitState, runVpnGate, spawnServer } from './serverProcess.ts';
import { RotatingLog } from '../../shared/node/rotatingLog.ts';
import { finished } from 'node:stream/promises';
import { createServerSupervisor } from './serverSupervisor.ts';
import type { ServerStartupStage } from './serverSupervisor.ts';
import { readSettings, writeSettings, updateSettings } from './settings.ts';
import { API_VERSION } from '../../shared/client/apiVersion.ts';
import { createClientRuntime } from './clientRuntime.ts';
import { createKeyboardLayoutReader } from './keyboardLayout.ts';
import { createPortableRuntime } from './portableRuntime.ts';
import { offerPortableIntegration } from './portableIntegration.ts';
import { Profiles } from './profiles.ts';
import { electronSealer, sealedIdentity } from './identity.ts';
import { readWindowKey } from './autoLogin.ts';
import { localPort, originFromArgs } from './connection.ts';
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
import {
  configureSession,
  clearLegacyCookies,
  guardContents,
  LOCAL_PARTITION,
  sameOrigin,
  windowOptions,
} from './windowSecurity.ts';

let surfaceWindows: ReturnType<typeof createSurfaceWindows> | null = null;
let browserApi: ReturnType<typeof createBrowserApi> | null = null;
let browserDocumentEpoch = 0;
let removeBrowserIpc: (() => void) | null = null;

const surfaceWindowOrder: BrowserWindow[] = [];
const maximizeOnShow = new WeakSet<object>();
let settingsRequest: ReturnType<typeof createSettingsRequest> | null = null;
let helpRequest: ReturnType<typeof createSettingsRequest> | null = null;
let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let localSession: Session | null = null;
let client: ReturnType<typeof createClientRuntime> | null = null;
let pipeOrigin: string | null = null;
const pipeOrigins = new Set<string>();
const lifetime = new AbortController();
const pipeSecret = randomBytes(32).toString('base64url');
let settings: DesktopSettings | null = null;
let settingsFile: string | null = null;
let saving: Promise<void> = Promise.resolve();
// Адрес выбирается при подготовке старта; supervisor проверяет именно его.
let selectedOrigin: string | null = null;
// Код последнего главного документа своего origin: показ окна — только после 200.
let mainDocumentCode: number | null = null;
let bootStartedAt = 0;
let exiting = false;
const windowControls = createWindowControls({
  getWindow: () => mainWindow,
  origin: () => pipeOrigin,
  stopping: () => quit.stopping,
});

const configuredWindows = new WeakSet<BrowserWindow>();
const frames = createFrameTracker();

app.setName('GrigDesk');

const dataDirectory = process.env.GRIGDESK_DESKTOP_DATA_DIR;

if (dataDirectory !== undefined) {
  if (!path.isAbsolute(dataDirectory)) {
    setDesktopLocale('system', app.getPreferredSystemLanguages()[0] ?? '');
    dialog.showErrorBox('GrigDesk', desktopText('desktop.dataDirectoryNotAbsolute'));
    app.exit(1);
  } else {
    app.setPath('userData', dataDirectory);
  }
}

app.enableSandbox();

// Скрытая поверхность не получает подтверждение показа кадра на экране.
// CDP ждёт новую поверхность вместо presentation ACK; прочие features сохраняются.
const captureFeatures = app.commandLine.getSwitchValue('enable-features').split(',').filter(Boolean);

app.commandLine.appendSwitch('enable-features',
  [...new Set([...captureFeatures, 'CDPScreenshotNewSurface'])].join(','));

function writeLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

function setTimer(ms: number, callback: () => void): () => void {
  const timer = setTimeout(callback, ms);

  return () => clearTimeout(timer);
}

/**
 * Все поколения своего сервера пишут через один ротируемый потребитель на путь.
 * Потомки старого поколения не удерживают fd закрытого архива и не теряют хвост.
 */
function startOwnServer(runtime: ServerRuntime): ChildProcess {
  let log = serverLogs.get(runtime.logPath);

  if (!log || log.destroyed) {
    log = new RotatingLog(runtime.logPath);
    log.on('error', () => writeLog(`GrigDesk: журнал сервера недоступен: ${runtime.logPath}`));
    serverLogs.set(runtime.logPath, log);
  }

  const child = spawnServer(runtime, 'pipe');

  serverLogChildren.set(child, log);
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.on('error', (error) => writeLog(`GrigDesk: процесс сервера: ${error.message}`));

  /**
   * Отказ диска не должен заполнить трубы и заблокировать работающий сервер.
   * После отказа остаток вывода уходит в stderr владельца приложения.
   */
  const failed = () => {
    child.stdout?.unpipe(log);
    child.stderr?.unpipe(log);
    child.stdout?.pipe(process.stderr, { end: false });
    child.stderr?.pipe(process.stderr, { end: false });
  };

  log.once('error', failed);
  child.once('close', () => {
    log?.off('error', failed);
    serverLogChildren.delete(child);
  });

  return child;
}

const serverLogs = new Map<string, RotatingLog>();
const serverLogChildren = new Map<ChildProcess, RotatingLog>();

/**
 * Exit сервера приходит раньше конца stdio: сначала дожидаемся хвоста труб.
 * Осиротевший потомок не задерживает выход окна дольше дополнительного бюджета.
 */
async function closeServerLogs(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = [...serverLogChildren.keys()].map((child) => new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  }));

  try {
    await Promise.race([
      Promise.all(closed),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }

  for (const [child, log] of serverLogChildren) {
    child.stdout?.unpipe(log);
    child.stderr?.unpipe(log);
    child.stdout?.resume();
    child.stderr?.resume();
  }

  await Promise.all([...serverLogs.values()].map(async (log) => {
    const done = finished(log);

    log.end();
    await done;
  }));
}

// Каталог пакета для очистки окружения своего сервера: распакованный AppRun не экспортирует APPDIR.
const packageDir = app.isPackaged ? path.dirname(process.execPath) : null;

let portable: ReturnType<typeof createPortableRuntime> | null = null;
let portablePreparing = false;
let startupLocalId: string | null = null;
let splashStatus: string | null = null;
let portableWindow: string | null = null;
let markMainShown = () => {};
const mainShown = new Promise<void>((resolve) => {
  markMainShown = resolve;
});

/**
 * После смены ELF нужен новый supervisor: stop завершает прежний контроллер навсегда.
 * Все поколения используют общий descriptor, а владение процессом остаётся внутри supervisor.
 */
function createOwnSupervisor() {
  return createServerSupervisor({
    loadRuntime: ({ purpose }) => loadServerRuntime({
      purpose,
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
}

let supervisor = createOwnSupervisor();
let exitPreference: ReturnType<typeof createDesktopExitPreference> | null = null;

function desktopExitPreference() {
  exitPreference ??= createDesktopExitPreference({
    settings: settings!,
    save: () => writeSettings(settingsFile!, settings!),
  });

  return exitPreference;
}

const desktopExit = createDesktopExitController({
  context: () => {
    const profile = settings?.profiles.find((item) => item.id === settings?.selected);

    return mainWindow && pipeOrigin && profile ? {
      window: mainWindow,
      origin: pipeOrigin,
      profileId: profile.id,
      address: profile.address,
      local: profile.kind === 'local',
      selectedOrigin,
      supervisor,
    } : null;
  },
  revealed: () => revealed(),
  quitting: () => quit.stopping,
  preference: () => desktopExitPreference(),
  log: writeLog,
  exit: () => {
    exiting = true;
    browserApi?.dispose();
    removeBrowserIpc?.();
    removeBrowserIpc = null;
    app.exit(0);
  },
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
 * Общий модал остаётся в том же документе и получает фокус вместе с ним.
 */
function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
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

  settings.window = {
    width: bounds.width,
    height: bounds.height,
    maximized: mainWindow.isMaximized(),
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
 * Карточки сохраняют нормальные размеры отдельно от главного окна.
 * Скрытые и уничтоженные окна не подменяют последнее видимое положение.
 */
function captureSurfaceGeometry(window: BrowserWindow, target: SurfaceTarget): void {
  if (window.isDestroyed() || !window.isVisible() || !settings) {
    return;
  }

  const geometry = { ...window.getNormalBounds(), maximized: window.isMaximized() };

  settings.surfaceWindows = target.kind === 'task'
    ? { ...settings.surfaceWindows, task: geometry }
    : { ...settings.surfaceWindows, tools: { ...settings.surfaceWindows?.tools, [target.id]: geometry } };
}

/**
 * Закрытие страницы может дать только closed: сохраняем уже снятое состояние.
 * Выход приложения записывает всю настройку обычной очередью saveMainWindow.
 */
function persistSurfaceGeometry(): void {
  if (!settings?.surfaceWindows || !settingsFile || quit.stopping) {
    return;
  }

  saving = writeSettings(settingsFile, settings);
  saving.catch(() => writeLog('GrigDesk: не удалось сохранить положение карточки.'));
}

/**
 * Предпочитаем экран главного окна, если сохранённый монитор больше недоступен.
 * Остальные рабочие области сохраняют возможность отрицательных координат.
 */
function surfaceWorkAreas(): [Rectangle, ...Rectangle[]] {
  const primary = screen.getPrimaryDisplay();
  const preferred = screen.getDisplayMatching(mainWindow?.getNormalBounds() ?? primary.workArea);

  return [
    preferred.workArea,
    ...screen.getAllDisplays().filter((display) => display.id !== preferred.id)
      .map((display) => display.workArea),
  ];
}

/**
 * Загрузки могут завершиться в обратном порядке: размещение проверяется перед показом.
 * Разворачивается только первое видимое окно, остальные оставляют предыдущее доступным.
 */
function prepareSurfaceShow(window: BrowserWindow): void {
  const visible = surfaceWindowOrder.filter((other) => other !== window
    && !other.isDestroyed() && other.isVisible());
  const previous = visible.at(-1);
  const bounds = window.getBounds();
  const placed = placeSurfaceBounds({ ...bounds, maximized: false }, 0,
    surfaceWorkAreas(), previous?.getBounds(), visible.map((other) => other.getBounds()));

  window.setMinimumSize(Math.min(600, placed.width), Math.min(600, placed.height));
  window.setBounds(placed);

  if (maximizeOnShow.delete(window) && !previous) {
    window.maximize();
  }
}

/**
 * Только встроенный документ текущей машины получает окно в стиле приложения.
 * UA и guards назначаются до первой загрузки, сессия совпадает с главным окном.
 */
function createSurfaceWindow(url: string, target: SurfaceTarget, index: number): BrowserWindow {
  const areas = surfaceWorkAreas();
  const saved = (target.kind === 'task' ? settings?.surfaceWindows?.task
    : settings?.surfaceWindows?.tools?.[target.id]) ?? {
    x: areas[0].x,
    y: areas[0].y,
    width: 1000,
    height: 800,
    maximized: false,
  };
  const previous = surfaceWindowOrder.findLast((other) => !other.isDestroyed());
  const bounds = target.kind === 'task' ? placeSurfaceBounds(saved, index, areas, previous?.getBounds())
    : fitSurfaceBounds(saved, areas);
  const options = windowOptions(path.join(__dirname, 'icon.png'), app.isPackaged, {
    width: bounds.width,
    height: bounds.height,
    maximized: false,
  });
  const window = new BrowserWindow({
    ...options,
    ...bounds,
    // Карточка оформляется целиком своей шапкой: системных кнопок поверх неё нет,
    // окно двигают за шапку, а закрывает его собственная кнопка карточки.
    titleBarOverlay: false,
    minWidth: Math.min(600, bounds.width),
    minHeight: Math.min(600, bounds.height),
    webPreferences: {
      ...options.webPreferences,
      session: session.fromPartition(LOCAL_PARTITION),
    },
  });

  if (target.kind === 'task') {
    surfaceWindowOrder.push(window);
  }

  const remember = () => captureSurfaceGeometry(window, target);

  window.on('move', remember);
  window.on('resize', remember);
  window.on('maximize', remember);
  window.on('unmaximize', remember);
  window.on('close', (event) => {
    remember();

    if (target.kind !== 'tool' || !settings || !settingsFile || quit.stopping) {
      return;
    }

    event.preventDefault();
    saving = writeSettings(settingsFile, settings);
    void saving.catch(() => writeLog('GrigDesk: не удалось сохранить положение инструмента.'))
      .finally(() => {
        if (!window.isDestroyed()) {
          window.destroy();
        }
      });
  });
  window.on('closed', () => {
    const index = surfaceWindowOrder.indexOf(window);

    if (index >= 0) {
      surfaceWindowOrder.splice(index, 1);
    }

    persistSurfaceGeometry();
  });

  if (saved.maximized && (target.kind === 'tool' || !previous)) {
    maximizeOnShow.add(window);
  }

  window.webContents.setUserAgent(desktopUserAgent(window.webContents.getUserAgent(), 'surface'));
  configureWindow(window, new URL(url).origin, options);

  return window;
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

  const childOptions = browserChildWindowOptions(options);

  window.setMenuBarVisibility(false);
  window.webContents.on('before-input-event', (event, input) => {
    // Одиночный Alt не показывает меню и не уходит в страницу.
    // Сочетания с Alt обрабатываются по основной клавише, включая Ctrl+Alt+S.
    if (input.key === 'Alt' || isReloadShortcut(input)) {
      event.preventDefault();
    }
  });
  guardContents(window.webContents, {
    origin: pipeOrigins,
    openExternal,
    childOptions,
    onSettingsRequest: () => {
      settingsRequest?.open();
    },
    onChild: (child) => configureWindow(child, origin, childOptions),
  });
  window.webContents.on('context-menu', async (_event, params) => {
    const template = contextMenuTemplate(params, (url) => clipboard.writeText(url), desktopLocale());

    if (template.length > 0 && !window.isDestroyed()) {
      try {
        if (await showStyledContextMenu(window, params, template)) {
          return;
        }
      } catch {
        // Во время навигации документ может исчезнуть до ответа на запрос меню.
      }

      if (!window.isDestroyed()) {
        Menu.buildFromTemplate(template).popup({ window });
      }
    }
  });
}

/**
 * Нативный ввод обрабатывается до страницы, включая xterm с preventDefault.
 * Фиксированное событие открывает общий модал в главном документе.
 */
function installSettingsShortcut(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (isSettingsShortcut(input)) {
      event.preventDefault();
      settingsRequest?.open();
    } else if (isHelpShortcut(input)) {
      event.preventDefault();
      helpRequest?.open();
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
    message: error instanceof Error && error.message
      ? error.message : desktopText('desktop.windowStartFailure'),
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
    buttons: [desktopText('core.close')],
    signal,
  });
}

/**
 * Срок относится к локальной подготовке встроенного документа и его первому кадру.
 * Сервер и VPN работают в фоне и не могут задерживать показ окна.
 */
function timeoutMessage(phase: StartupPhase): string {
  if (phase === 'splash') {
    return desktopText('desktop.splashTimeout');
  }

  if (phase === 'server') {
    return desktopText('desktop.interfaceTimeout');
  }

  return desktopText('desktop.interfaceNotPainted');
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

    const cancel = () => finish(new Error(desktopText('desktop.windowStartAborted')));

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
    window.loadFile(path.join(__dirname, 'splash', 'index.html')).then(async () => {
      const text = JSON.stringify(desktopText('desktop.loading'));
      const language = JSON.stringify(desktopLocale());
      const script = `(async () => {
        document.documentElement.lang = ${language};
        document.querySelector('.status').textContent = ${text};
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      })()`;

      await window.webContents.executeJavaScript(script);
      loaded = true;
      show();
    }, (error: unknown) => {
      const detail = error instanceof Error ? ` ${error.message}` : '';

      finish(new Error(desktopText('desktop.splashLoadFailure', { detail })));
    });
  });
}

/**
 * Подпись меняется главным процессом в прежнем документе без скриптов и новых разрешений.
 * Повторы и поздние ответы уничтоженной заставки не создают эффектов.
 */
function setSplashStatus(text: string): void {
  const window = splashWindow;
  const language = desktopLocale();
  const status = JSON.stringify([language, text]);

  if (!window || window.isDestroyed() || splashStatus === status) {
    return;
  }

  splashStatus = status;

  const script = `document.documentElement.lang = ${JSON.stringify(language)};
    document.querySelector('.status').textContent = ${JSON.stringify(text)};`;

  void window.webContents.executeJavaScript(script).catch(() => {});
}

/**
 * Этап запуска переводится по стабильному коду, без разбора диагностического текста.
 * Подготовка переносимого сервера предшествует supervisor, а вход снова показывает проверку.
 */
function localStartupText(): string {
  const stage: ServerStartupStage = supervisor.stage ?? (portablePreparing ? 'preparing' : 'checking');

  if (stage === 'starting') {
    return desktopText('desktop.startingServer');
  }

  if (stage === 'preparing') {
    return desktopText('desktop.preparingServer');
  }

  if (stage === 'vpn') {
    return desktopText('desktop.waitingVpn');
  }

  return desktopText('desktop.checkingServer');
}

/**
 * Создаёт скрытое главное окно со всеми обработчиками и lifecycle, без показа.
 * Документ трубы грузится независимо от доступности выбранной машины.
 */
async function createMainWindow(origin: string, stored: DesktopSettings): Promise<void> {
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate({
    openHelp: () => helpRequest?.open(),
    openSettings: () => {
      settingsRequest?.open();
    },
  }, desktopLocale())));

  const grigDeskSession = session.fromPartition(LOCAL_PARTITION);

  localSession = grigDeskSession;
  await clearLegacyCookies(grigDeskSession.cookies);
  await configureSession(grigDeskSession, pipeOrigins);
  await grigDeskSession.cookies.set({
    url: 'http://127.0.0.1',
    name: 'grigdesk_pipe',
    value: pipeSecret,
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
  });

  const base = windowOptions(path.join(__dirname, 'icon.png'), app.isPackaged, stored.window);
  const options: BrowserWindowConstructorOptions = {
    ...base,
    webPreferences: {
      ...base.webPreferences,
      session: grigDeskSession,
      preload: path.join(__dirname, 'browserPreload.cjs'),
    },
  };
  const window = new BrowserWindow(options);

  mainWindow = window;
  attachMainRendererRecovery({
    window,
    signal: lifetime.signal,
    origin: () => pipeOrigin,
    stopping: () => quit.stopping,
    revealed,
    invalidate: () => {
      browserDocumentEpoch += 1;
      mainDocumentCode = null;
      browserApi?.documentChanged();
    },
    confirm: async (signal) => {
      const result = await dialog.showMessageBox(window, {
        type: 'error',
        title: 'GrigDesk',
        message: desktopText('desktop.rendererGone'),
        detail: desktopText('desktop.rendererRecoveryDetail'),
        buttons: [desktopText('desktop.rendererReload'), desktopText('desktop.rendererKeepWindow')],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        signal,
      });

      return result.response === 0;
    },
    reload: (origin) => loadDocument(window, origin + '/', lifetime.signal),
    failStartup: () => fatal(new Error(desktopText('desktop.rendererGone'))),
    log: (diagnostic) => writeLog(`GrigDesk: ${JSON.stringify({
      ...diagnostic,
      electron: process.versions.electron,
      chromium: process.versions.chrome,
    })}`),
  });
  window.webContents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) {
      browserDocumentEpoch += 1;
      browserApi?.documentChanged();
    }
  });
  window.on('resize', () => browserApi?.hideForResize());
  window.on('closed', () => browserApi?.machineChanged());

  pipeOrigin = origin;
  window.on('maximize', windowControls.changed);
  window.on('unmaximize', windowControls.changed);
  windowControls.changed();
  window.webContents.setUserAgent(desktopUserAgent(window.webContents.getUserAgent(), 'main'));
  installSettingsShortcut(window);
  settingsRequest = createSettingsRequest({
    getWindow: () => mainWindow,
    revealed,
    origin,
  });
  helpRequest = createSettingsRequest({
    getWindow: () => mainWindow,
    revealed,
    origin,
  }, 'grigdesk:open-help');
  configureWindow(window, origin, options);
  window.on('ready-to-show', () => frames.painted());
  window.on('close', (event) => {
    if (desktopExit.close(event)) {
      return;
    }

    if (revealed() && !quit.stopping) {
      saveMainWindow();
    }
  });
  window.webContents.on('will-prevent-unload', (event) => {
    if (desktopExit.finishing) {
      event.preventDefault();
    }
  });
  window.on('closed', () => {
    mainWindow = null;
    void quit.request({ reason: 'main-closed', exitCode: 0 });
  });
  window.webContents.on('did-navigate', (_event, url, httpResponseCode) => {
    if (sameOrigin(url, pipeOrigins)) {
      frames.navigated();
      mainDocumentCode = httpResponseCode;
    }
  });
}

/**
 * Подготовка после показа заставки: настройки, установка сервера, адрес и скрытое окно.
 * Supervisor запускается в фоне после выбора местного профиля и не задерживает создание документа.
 */
async function prepare(signal: AbortSignal): Promise<void> {
  const stored = settings!;
  const loaded = await loadServerRuntime({
    purpose: 'inspect',
    env: process.env,
    home: os.homedir(),
    deps: runtimeDependencies,
    appDir: packageDir,
    bundledUi: true,
  });
  let runtime = 'inspection' in loaded ? loaded.inspection : null;
  const argument = originFromArgs(process.argv);

  signal.throwIfAborted();

  if (argument && 'error' in argument) {
    throw new Error(argument.error);
  }

  settings = stored;

  const profiles = new Profiles({
    settings: stored,
    save: () => writeSettings(settingsFile!, stored),
  });

  portable = createPortableRuntime({
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    env: process.env,
    home: os.homedir(),
    explicitUrl: argument && 'origin' in argument ? argument.origin : null,
    profiles,
    ownsServer: () => supervisor.ownership === 'owned',
    async stopServer() {
      await supervisor.stop();
      supervisor = createOwnSupervisor();
      supervising = false;
    },
    /**
     * Выбранный descriptor перечитывается до подготовки payload новым supervisor.
     * Опрос сообщает ожидание только от текущего поколения контроллера.
     */
    async startServer(_binary, input) {
      portablePreparing = false;

      const inspected = await loadServerRuntime({
        purpose: 'inspect',
        env: process.env,
        home: os.homedir(),
        deps: runtimeDependencies,
        appDir: packageDir,
        bundledUi: true,
      });

      runtime = 'inspection' in inspected ? inspected.inspection : null;

      if (!runtime) {
        throw new Error(desktopText('desktop.serverNotPrepared'));
      }

      selectedOrigin = runtime.origin;
      supervising = true;

      const current = supervisor;
      const progress = setInterval(() => {
        const id = stored.selected;

        if (id && current === supervisor) {
          setSplashStatus(localStartupText());
        }

        if (id && current === supervisor && current.waitReason) {
          client?.shell.reportBackground(id, {
            status: 'connecting',
            detail: { code: 'server_starting', message: current.waitReason },
            serverApi: null,
          });
        }
      }, 500);

      try {
        await current.ensure({
          origin: runtime.origin,
          signal: input?.signal ?? lifetime.signal,
          deadline: Date.now() + STARTUP_HOLD_LIMIT_MS + STARTUP_DEADLINE_MS,
        });
      } finally {
        clearInterval(progress);
        supervising = false;
      }
    },
    async notify(message) {
      await mainShown;

      if (!lifetime.signal.aborted) {
        await dialog.showMessageBox({
          type: 'info',
          title: 'GrigDesk',
          message,
        });
      }
    },
    report(message) {
      portablePreparing = true;

      const id = stored.selected;

      if (id) {
        setSplashStatus(localStartupText());
        client?.shell.reportBackground(id, {
          status: 'connecting',
          detail: { code: 'server_starting', message },
          serverApi: null,
        });
      }
    },
  });

  const discovered = await portable.discover();

  portableWindow = discovered.windowPath;

  const uiDir = clientUiDirectory({
    packaged: app.isPackaged,
    resources: process.resourcesPath,
    source: __dirname,
    override: process.env.GRIGDESK_CLIENT_UI_DIR,
  });
  const appApi = await readFile(path.join(uiDir, 'api-version.json'), 'utf8')
    .then((text) => JSON.parse(text) as typeof API_VERSION).catch(() => API_VERSION);
  let supervising = false;

  surfaceWindows = createSurfaceWindows({
    allowedOrigin: () => quit.stopping ? null : pipeOrigin,
    create: createSurfaceWindow,
    beforeShow: (window) => {
      const native = window as BrowserWindow;

      if (surfaceWindowOrder.includes(native)) {
        prepareSurfaceShow(native);
      } else if (maximizeOnShow.delete(native)) {
        native.maximize();
      }
    },
    closed: (origin, target, instance) => {
      const window = mainWindow;

      if (origin !== pipeOrigin || !window || window.isDestroyed()) {
        return;
      }

      const frame = window.webContents.mainFrame;
      const payload = JSON.stringify({ id: target.id, instance });

      if (!frame.isDestroyed() && sameOrigin(frame.url, origin)) {
        void frame.executeJavaScript('window.grigdeskToolClosed?.(' + payload + ')').catch(() => {});
      }
    },
  });

  const manualBrowserApps = structuredClone(stored.manualBrowserApps ?? []);
  const browserEnvironment = cleanDesktopChildEnvironment(process.env, packageDir);
  const browserApps = createBrowserApps({
    dataHome: browserEnvironment.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'),
    dataDirs: (browserEnvironment.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(path.delimiter),
    searchPath: browserEnvironment.PATH ?? '',
    manual: manualBrowserApps,
    save: () => updateSettings(settingsFile!, stored, {
      manualBrowserApps: structuredClone(manualBrowserApps),
    }),
  });

  browserApi = createBrowserApi({
    inputGuard: createBrowserInputGuard({
      create: (options) => new WebContentsView(options),
      window: () => mainWindow,
    }),
    preferences: () => normalizeBrowserPreferences(stored.browser),
    commit: (value) => updateSettings(settingsFile!, stored, { browser: value }),
    apps: browserApps.list,
    chooseApp: async () => {
      const window = mainWindow;

      if (!window || window.isDestroyed()) {
        throw new Error('browser_unavailable');
      }

      const result = await dialog.showOpenDialog(window, { properties: ['openFile'] });

      return result.canceled || !result.filePaths[0]
        ? null : browserApps.registerManual(result.filePaths[0]);
    },
    external: (application, url) => openExternalBrowser({
      system: (target) => shell.openExternal(target),
      resolve: browserApps.resolve,
      spawn: (command, args) => new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, {
          shell: false,
          detached: true,
          stdio: 'ignore',
          env: browserEnvironment,
        });

        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      }),
    }, application, url),
    view: ({ scope, events }) => createNativeBrowserView({
      machine: stored.selected ?? 'unselected',
      scope,
      create: (options) => new WebContentsView(options),
      captureWindow: (options) => new BaseWindow(options),
      imageFromBuffer: (data) => nativeImage.createFromBuffer(data),
      window: () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          throw new Error('browser_unavailable');
        }

        return mainWindow;
      },
      pipeOrigins: () => pipeOrigins,
      events,
    }),
    bounds: () => {
      const window = mainWindow;
      const bounds = window?.getContentBounds();

      return {
        width: bounds?.width ?? 0,
        height: bounds?.height ?? 0,
        zoom: window?.webContents.getZoomFactor() ?? 1,
      };
    },
    ...createBrowserEvents({
      window: () => mainWindow,
      origin: () => pipeOrigin,
      stopping: () => quit.stopping,
    }),
  });
  removeBrowserIpc?.();
  removeBrowserIpc = attachBrowserIpc({
    ipc: ipcMain,
    window: () => mainWindow,
    origin: () => quit.stopping ? null : pipeOrigin,
    epoch: () => browserDocumentEpoch,
    execute: (request, valid) => browserApi!.invoke(request, valid),
    hide: (request) => browserApi!.hide(request),
  });

  client = createClientRuntime({
    keyboardLayout: createKeyboardLayoutReader({
      platform: process.platform,
      env: browserEnvironment,
    }),
    applicationLauncher: process.platform === 'linux' ? createApplicationLauncher({
      executablePath: process.env.APPIMAGE ?? process.execPath,
      arguments: app.isPackaged ? [] : [app.getAppPath()],
      home: os.homedir(),
      env: process.env,
      trustShortcut: (file) => new Promise((resolve) => {
        execFile('gio', ['set', file, 'metadata::trusted', 'true'], { timeout: 2000 }, () => resolve());
      }),
    }) : undefined,
    windowControls,
    nativeBrowser: {
      state: () => {
        const current = browserApi!.snapshot();

        return { preferences: current.preferences, revision: current.revision };
      },
      subscribe: browserApi!.subscribe,
    },
    desktopExit: desktopExitPreference(),
    settings: stored,
    save: () => writeSettings(settingsFile!, stored),
    uiDir,
    secret: pipeSecret,
    appApi,
    systemLanguage: app.getPreferredSystemLanguages()[0] ?? '',
    onLocale: (preference) => {
      setDesktopLocale(preference, app.getPreferredSystemLanguages()[0] ?? '');
      Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate({
        openHelp: () => helpRequest?.open(),
        openSettings: () => settingsRequest?.open(),
      }, desktopLocale())));
    },
    nativeWindows: {
      open: async (origin, target) => (await surfaceWindows?.open(origin, target)) === true,
/**
 * Закрытый native control не принимает произвольных адресов или параметров окна.
 * Проверку origin и instance выполняет общий реестр поверхностей.
 */
      async tool(origin, request) {
        if (request.action === 'status') {
          return surfaceWindows?.status(origin) ?? [];
        }

        const target = { kind: 'tool' as const, id: request.id };

        if (request.action === 'open') {
          return surfaceWindows?.open(origin, target) ?? { opened: false };
        }

        if (request.action === 'focus') {
          return { focused: surfaceWindows?.focus(origin, target, request.instance) ?? false };
        }

        if (request.action === 'close') {
          return { closed: surfaceWindows?.close(origin, target, request.instance) ?? false };
        }

        return surfaceWindows?.control(origin, target, request.instance, request.action)
          ?? { accepted: false };
      },

      /**
       * Закрытый запрос выполняется только в текущем главном документе своей машины.
       * Подтверждение страницы и повторная проверка поколения предшествуют фокусу.
       */
      async main(origin, request) {
        const window = mainWindow;

        if (quit.stopping || origin !== pipeOrigin || !revealed()
          || !window || window.isDestroyed() || window.webContents.isDestroyed()) {
          return false;
        }

        const frame = window.webContents.mainFrame;

        if (frame.isDestroyed() || frame.detached || !sameOrigin(frame.url, origin)
          || new URL(frame.url).pathname !== '/') {
          return false;
        }

        try {
          const script = 'typeof window.grigdeskSurfaceMain === "function"'
            + ' && window.grigdeskSurfaceMain(' + JSON.stringify(request) + ')';
          const opened = await frame.executeJavaScript(script);

          if (opened !== true || quit.stopping || mainWindow !== window || origin !== pipeOrigin
            || window.isDestroyed() || frame.isDestroyed() || frame.detached
            || window.webContents.mainFrame !== frame || !sameOrigin(frame.url, origin)
            || new URL(frame.url).pathname !== '/') {
            return false;
          }

          focusMainWindow();

          return true;
        } catch {
          return false;
        }
      },
    },

    identity: sealedIdentity(electronSealer(safeStorage, process.platform)),
    identityDirectory: path.join(app.getPath('userData'), 'identity'),
    localAvailable: () => runtime != null || discovered.localAvailable,
    localAddress: () => runtime?.origin || discovered.address,
    windowKey: async (profile) => {
      const file = windowKeyPath({
        env: runtime?.env || process.env,
        uid: process.getuid?.(),
        port: localPort(profile.address),
      });

      return await readWindowKey(file) || '';
    },
    beforeSelect: (profile) => portable!.activate(profile),
    /**
     * Supervisor работает независимо от показа окна и сообщает ожидание в shell.
     * Управление касается только собственного сервера исправной установки.
     */
    async prepareLocal(profile, input) {
      if (profile.serverBinary) {
        await portable!.prepareLocal(profile, input);

        return;
      }

      if (!runtime || supervising || profile.address !== runtime.origin) {
        return;
      }

      supervising = true;
      selectedOrigin = profile.address;

      const progress = setInterval(() => {
        setSplashStatus(localStartupText());

        if (supervisor.waitReason) {
          client?.shell.reportBackground(profile.id, {
            status: 'connecting',
            detail: { code: 'server_starting', message: supervisor.waitReason },
            serverApi: null,
          });
        }
      }, 500);

      void supervisor.ensure({
        origin: profile.address,
        signal: lifetime.signal,
        deadline: Date.now() + STARTUP_HOLD_LIMIT_MS + STARTUP_DEADLINE_MS,
      }).then(() => {
        clearInterval(progress);
        void client?.shell.connect(profile.id, false);
      }).catch((error: Error) => {
        clearInterval(progress);
        supervising = false;
        client?.shell.reportBackground(profile.id, {
          status: 'offline',
          detail: { code: 'server_start_failed', message: error.message },
          serverApi: null,
        });
      });
    },
    /**
     * Повторно занятый порт не наследует данные прежней удалённой машины.
     * Cookie хоста остаётся общей: очищаются только хранилища конкретного origin.
     */
    async onOrigin(origin, resetStorage) {
      if (resetStorage) {
        await session.fromPartition(LOCAL_PARTITION).clearStorageData({
          origin,
          storages: ['localstorage', 'indexdb', 'cachestorage', 'serviceworkers'],
        });
      }

      pipeOrigins.add(origin);
    },
    onOriginRemoved: (origin) => {
      pipeOrigins.delete(origin);
    },
    /**
     * Смена origin создаёт новый документ с отдельными настройками localStorage.
     * Дочерние окна прежней машины закрываются перед переходом главного.
     */
    async navigate(origin) {
      browserApi?.machineChanged();
      surfaceWindows?.closeAll();
      pipeOrigin = origin;

      for (const window of BrowserWindow.getAllWindows()) {
        if (window !== mainWindow && window !== splashWindow) {
          window.destroy();
        }
      }

      settingsRequest?.dispose();
      helpRequest?.dispose();
      settingsRequest = createSettingsRequest({
        getWindow: () => mainWindow,
        revealed,
        origin,
      });
      helpRequest = createSettingsRequest({
        getWindow: () => mainWindow,
        revealed,
        origin,
      }, 'grigdesk:open-help');

      if (mainWindow) {
        await loadDocument(mainWindow, origin + '/', lifetime.signal);
      }
    },
  });

  if (argument && 'origin' in argument) {
    const profile = await client.profiles.add({
      name: 'Этот компьютер',
      kind: 'local',
      address: argument.origin,
      fp: null,
    });

    await client.profiles.select(profile.id);
  }

  const origin = await client.start();

  signal.throwIfAborted();
  await createMainWindow(origin, stored);
}

/**
 * Загружается только встроенный документ трубы; доступность сервера здесь не ожидается.
 * HTTP-отказ локального пакета остаётся явной ошибкой установки.
 */
async function connectMain(signal: AbortSignal): Promise<void> {
  if (!mainWindow || !pipeOrigin) {
    throw new Error(desktopText('desktop.mainWindowMissing'));
  }

  await loadDocument(mainWindow, pipeOrigin + '/', signal);
  signal.throwIfAborted();

  if (mainDocumentCode !== 200) {
    throw new Error(desktopText('desktop.installationDamaged'));
  }
}

/**
 * Соединение online ещё не означает вход страницы: ждём рабочую область в документе трубы.
 * Два кадра и повторный снимок защищают показ от смены машины или потери связи во время входа.
 */
async function waitLocalServer(signal: AbortSignal): Promise<void> {
  const id = client?.shell.state().profile?.id;

  startupLocalId = id ?? null;

  while (id) {
    signal.throwIfAborted();

    const state = client?.shell.state();
    const detail = typeof state?.detail === 'object' ? state?.detail : null;

    if (!state || state.profile?.id !== id || detail?.code === 'disconnected'
      || !['none', 'offline', 'connecting', 'online'].includes(state.status)) {
      return;
    }

    setSplashStatus(localStartupText());

    if (detail?.code === 'server_start_failed') {
      throw new Error(detail.message);
    }

    const window = mainWindow;
    const origin = pipeOrigin;

    if (state.status === 'online' && window && !window.isDestroyed() && origin
      && sameOrigin(window.webContents.getURL(), origin)) {
      const script = `(async () => {
        const ready = () => !!document.querySelector('.shell')
          && !document.querySelector('.workspace-waiting');

        if (!ready()) {
          return false;
        }

        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);

        return ready();
      })()`;
      const ready = await window.webContents.executeJavaScript(script).catch(() => false);

      signal.throwIfAborted();

      const current = client?.shell.state();

      if (ready === true && mainWindow === window && !window.isDestroyed() && pipeOrigin === origin
        && sameOrigin(window.webContents.getURL(), origin)
        && current?.profile?.id === id && current.status === 'online') {
        return;
      }
    }

    await delayWithAbort(100, signal);
    signal.throwIfAborted();
  }
}

/**
 * Ошибка сервера открывает обычный каркас с причиной, не затрагивая запуск и выход приложения.
 * Срок относится только к прежнему local: готовое соединение и явные причины сохраняются.
 */
function reportLocalStartupFallback(kind: 'timeout' | 'failed', message?: string): void {
  const state = client?.shell.state();
  const detail = typeof state?.detail === 'object' ? state?.detail : null;

  if (!state || !startupLocalId || state.profile?.id !== startupLocalId || state.profile.kind !== 'local'
    || !['offline', 'connecting'].includes(state.status)
    || ['server_start_failed', 'disconnected'].includes(detail?.code ?? '')) {
    return;
  }

  const reason = (typeof state.detail === 'string' ? state.detail : detail?.message) || localStartupText();

  client?.shell.report(startupLocalId, {
    status: state.status,
    detail: {
      code: kind === 'timeout' ? 'server_start_timeout' : 'server_start_failed',
      message: kind === 'timeout'
        ? desktopText('desktop.serverStartTimeout', { detail: ` ${reason}` })
        : message || reason,
    },
    serverApi: state.serverApi,
  });
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
  markMainShown();

  if (portableWindow) {
    void offerPortableIntegration({
      isPortable: true,
      windowPath: portableWindow,
      userData: app.getPath('userData'),
      home: os.homedir(),
      env: process.env,
      shown: mainShown,
      async ask() {
        const result = await dialog.showMessageBox(window, {
          type: 'question',
          title: 'GrigDesk',
          message: desktopText('desktop.portableMenuTitle'),
          buttons: [desktopText('desktop.portableMenuAdd'), desktopText('desktop.portableMenuLater')],
          defaultId: 0,
          cancelId: 1,
        });

        return result.response === 0;
      },
      reportError() {
        dialog.showErrorBox('GrigDesk', desktopText('desktop.portableMenuError'));
      },
    });
  }

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
  localSelected: () => client?.shell.state().profile?.kind === 'local',
  waitLocal: (signal) => waitLocalServer(signal),
  localFallback: (kind, message) => reportLocalStartupFallback(kind, message),
  reveal: () => revealMain(),
  focusMain: () => focusMainWindow(),
  timeoutMessage: (phase) => timeoutMessage(phase),
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
    desktopExit.cleanup();
    startup.cancel();
    surfaceWindows?.closeAll();
    browserApi?.dispose();
    removeBrowserIpc?.();
    removeBrowserIpc = null;
    lifetime.abort();
    portable?.close();
    client?.shell.close();
  },
  closeSplash: () => destroySplash(),
  showError: (message, signal) => showFatalDialog(message, signal),
  stopOwnServer: async () => {
    await client?.close();
    await supervisor.stop();
    await closeServerLogs();
  },
  revealed: () => revealed(),
  saveWindow: () => {
    saveMainWindow();

    return saving;
  },
  flushCookies: () => localSession?.cookies.flushStore() ?? Promise.resolve(),
  log: (message) => writeLog(message),
  exit: (code) => {
    desktopExit.exited();
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
  } catch (error) {
    fatal(error);

    return;
  }

  if (quit.stopping) {
    return;
  }

  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  settings = await readSettings(settingsFile);
  setDesktopLocale(settings.uiLanguage ?? 'system', app.getPreferredSystemLanguages()[0] ?? '');

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
    desktopExit.bypass();
    settingsRequest?.dispose();
    helpRequest?.dispose();

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
    desktopExit.bypass();
    void quit.request({
      reason: 'signal',
      exitCode: 0,
    });
  });
  process.on('SIGINT', () => {
    desktopExit.bypass();
    void quit.request({
      reason: 'signal',
      exitCode: 0,
    });
  });
  void boot();
} else {
  app.quit();
}
