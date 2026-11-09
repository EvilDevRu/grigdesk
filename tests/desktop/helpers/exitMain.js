import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

import { build } from '../../../desktop/node_modules/esbuild/lib/main.js';
import assert from 'node:assert/strict';

import { normalizeSettings } from '../../../desktop/src/settings.ts';
import { Profiles } from '../../../desktop/src/profiles.ts';

/**
 * Микрозадачи исполняются без движения внедрённых часов.
 * Это отделяет ожидание renderer и сервера от реального времени машины.
 */
export async function settle() {
  for (let index = 0; index < 30; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Проверяется настоящий main вместе с exit-модулями и quitController.
 * Подменены только Electron, startup и supervisor; пользовательские close остаются исходными.
 */
export async function exitMain(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-exit-main-'));
  const calls = [];
  const commands = [];
  const signals = new Map();
  const server = Promise.withResolvers();
  const save = Promise.withResolvers();
  let serverStopping;
  const cookies = Promise.withResolvers();
  const pipeline = Promise.withResolvers();
  const render = Promise.withResolvers();
  const inspect = Promise.withResolvers();
  const windows = [];
  const origin = 'http://127.0.0.1:19999';
  const address = options.remote ? 'https://remote.invalid' : 'http://127.0.0.1:19998';
  const state = {
    visible: options.visible ?? true,
    ownership: options.ownership ?? 'owned',
    generation: 1,
    decision: options.decision ?? 'pending',
    remember: options.remember ?? false,
    loading: false,
    crashed: false,
    destroyed: false,
    url: origin + '/',
    snapshot: options.snapshot ?? {
      chats: [{ chatKey: 'chat-one', title: 'Тестовый чат' }],
      pipelines: [{ task: '7', title: 'Тестовая задача' }],
    },
  };
  const stored = normalizeSettings({
    version: 2,
    skipExitConfirmation: options.skipConfirmation ?? false,
    profiles: [{
      id: 'local',
      name: 'Этот компьютер',
      kind: options.remote ? 'remote' : 'local',
      fp: options.remote ? 'a'.repeat(64) : null,
      address,
      port: 47101,
      createdAt: 0,
    }],
    selected: 'local',
  });
  const profile = stored.profiles[0];

  assert.ok(profile, 'Фикстура main содержит допустимый профиль после настоящей нормализации');
  assert.equal(stored.selected, profile.id);
  assert.equal(profile.address, address);

  const shellState = () => ({
    profile,
    profiles: stored.profiles,
    status: 'online',
  });
  const supervisor = {
    get stopping() {
      return !!serverStopping;
    },
    get ownership() {
      return state.ownership;
    },
    get generation() {
      return state.generation;
    },
    stopGraceMs: options.graceMs ?? 45000,
    /**
     * Отложенный supervisor удерживает завершение слива под управлением теста.
     * Потеря ownership после stop моделирует штатный переход в finishing.
     */
    stop() {
      if (serverStopping) {
        return serverStopping;
      }

      calls.push('server-stop');
      serverStopping = (async () => {
        if (options.blockServer) {
          await server.promise;
        }

        state.ownership = 'none';
        calls.push('server-stopped');
      })();

      return serverStopping;
    },
  };

  /**
   * Фиксированный скрипт исполняется в отдельном JS-контексте с renderer-портом.
   * Кавычки в данных проходят тот же executeJavaScript, что и в Electron.
   */
  async function execute(script) {
    calls.push('execute');

    if (options.executeError) {
      throw new Error('Тестовый отказ renderer');
    }

    /**
     * Renderer-порт отвечает на фиксированные команды протокола и записывает их порядок.
     * Долгие операции разрешаются отдельно, без подмены controller и bridge.
     */
    const dispatch = async (command) => {
      commands.push(structuredClone(command));
      calls.push(command.type ?? command.kind ?? command.command);

      if (options.renderer) {
        return options.renderer(structuredClone(command));
      }

      switch (command.type ?? command.kind ?? command.command) {
        case 'inspect':
          return options.blockInspect ? inspect.promise : state.snapshot;
        case 'stopping':
          return options.blockRender ? render.promise : { ok: true };
        case 'prompt':
        case 'cancel':
          return { ok: true };
        case 'decision':
          return { decision: state.decision, remember: state.remember };
        case 'stop-pipelines':
          if (options.blockPipelines) {
            await pipeline.promise;
          }

          calls.push('pipelines-stopped');

          return { ok: true };
        default:
          throw new Error('Неизвестная команда renderer');
      }
    };

    return vm.runInNewContext(script, {
      window: options.rendererMissing ? {} : { grigdeskDesktopExit: dispatch },
      grigdeskDesktopExit: dispatch,
    });
  }

  class BrowserWindow extends EventEmitter {
    constructor() {
      super();

      const contents = new EventEmitter();
      const frame = {
        url: state.url,
        parent: null,
        detached: false,
        isDestroyed: () => state.destroyed,
        executeJavaScript: execute,
      };

      Object.assign(contents, {
        mainFrame: frame,
        getURL: () => state.url,
        isDestroyed: () => state.destroyed,
        isCrashed: () => state.crashed,
        isLoading: () => state.loading,
        isLoadingMainFrame: () => state.loading,
        setUserAgent() {},
        getUserAgent: () => 'Synthetic Electron',
        setWindowOpenHandler() {},
        executeJavaScript: execute,
      });
      this.webContents = contents;
      this.destroyed = false;
      this.closes = 0;
      windows.push(this);
    }

    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return state.visible;
    }
    isMaximized() {
      return false;
    }
    getNormalBounds() {
      return {
        x: 0,
        y: 0,
        width: 1000,
        height: 800,
      };
    }
    getBounds() {
      return this.getNormalBounds();
    }
    setMenuBarVisibility() {}
    setMinimumSize() {}
    setBounds() {}

    /**
     * Последнее уничтоженное окно порождает системное событие Electron.
     * Оно нужно для проверки выхода при ошибке ещё до появления main.
     */
    destroy() {
      if (this.destroyed) {
        return;
      }

      this.destroyed = true;
      this.emit('closed');

      if (options.emitAllClosed && windows.every((window) => window.isDestroyed())) {
        app.emit('window-all-closed');
      }
    }

    /**
     * Fake Electron соблюдает close → beforeunload → closed и отмену обоих событий.
     * Guard несохранённых правок снимается только реальным will-prevent-unload listener.
     */
    close() {
      const event = { defaultPrevented: false, preventDefault() {
        this.defaultPrevented = true;
      } };

      this.closes += 1;
      this.emit('close', event);

      if (event.defaultPrevented) {
        calls.push('close-held');

        return event;
      }

      if (options.dirtyPage) {
        const unload = { defaultPrevented: false, preventDefault() {
          this.defaultPrevented = true;
        } };

        this.webContents.emit('will-prevent-unload', unload);

        if (!unload.defaultPrevented) {
          calls.push('unload-held');

          return event;
        }

        calls.push('unload-overridden');
      }

      calls.push('native-close');
      this.destroy();

      return event;
    }
  }

  const app = new EventEmitter();
  const session = {
    webRequest: { onBeforeRequest() {} },
    clearStorageData: async () => {},
    setSpellCheckerEnabled() {},
    setSpellCheckerLanguages() {},
    setSpellCheckerDictionaryDownloadURL() {},
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    cookies: {
      get: async () => [],
      remove: async () => {},
      set: async () => {},
      async flushStore() {
        calls.push('cookies');

        if (options.blockCookies) {
          await cookies.promise;
        }
      },
    },
  };

  Object.assign(app, {
    commandLine: { getSwitchValue: () => '', appendSwitch() {} },
    setName() {},
    setPath() {},
    enableSandbox() {},
    getPath: () => directory,
    getPreferredSystemLanguages: () => ['ru-RU'],
    isPackaged: false,
    whenReady: async () => {},
    requestSingleInstanceLock: () => true,
    quit() {},
    exit: (code) => calls.push(`exit:${code}`),
  });

  const client = {
    profiles: new Profiles({ settings: stored, save: async () => {} }),
    shell: {
      state: shellState,
      close: () => calls.push('shell-close'),
    },
    close: async () => calls.push('client-close'),
  };
  const fakeProcess = Object.create(process);

  fakeProcess.on = (name, callback) => {
    signals.set(name, callback);
  };

  const f = {
    app,
    BrowserWindow,
    session,
    supervisor,
    stored,
    calls,
    process: fakeProcess,
    origin,
    selectedOrigin: options.selectedOrigin ?? 'http://127.0.0.1:19998',
    save,
    options,
    client,
    file: path.join(directory, 'settings.json'),
  };

  globalThis.__exitMain = f;

  const main = new URL('../../../desktop/src/main.ts', import.meta.url);
  const stubs = {
    electron: `
      const f = globalThis.__exitMain;
      export const app = f.app;
      export const BrowserWindow = f.BrowserWindow;
      export const BaseWindow = f.BrowserWindow;
      export const nativeImage = { createFromPath: () => ({ isEmpty: () => true }) };
      export class WebContentsView {}
      export const ipcMain = {
        handle() {}, on() {}, removeHandler() {}, removeListener() {},
      };
      export const session = { fromPartition: () => f.session };
      export const Menu = { setApplicationMenu() {}, buildFromTemplate: () => ({ popup() {} }) };
      const display = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
      export const screen = { getPrimaryDisplay: () => display,
        getDisplayMatching: () => display, getAllDisplays: () => [display] };
      export const dialog = { showErrorBox() {}, showMessageBox: async () => ({ response: 0 }) };
      export const safeStorage = {};
      export const clipboard = {};
      export const shell = { openExternal: async () => {} };
    `,
    './startupController.ts': `
      export const FRAME_LIMIT_MS = 100;
      export const STARTUP_DEADLINE_MS = 100;
      export const STARTUP_HOLD_LIMIT_MS = 100;
      export const createFrameTracker = () => ({ painted() {}, navigated() {} });
      export const createStartupController = () => ({
        state: 'revealed', start: async () => {}, cancel() {},
      });
    `,
    './serverSupervisor.ts': 'export const createServerSupervisor = () => globalThis.__exitMain.supervisor;',
    './runtimeConfig.ts': `
      export const runtimeDependencies = {};
      export const loadServerRuntime = async () => ({ inspection: null });
    `,
    './settings.ts': `
      export const readSettings = async () => globalThis.__exitMain.stored;
      export const writeSettings = async () => {
        const f = globalThis.__exitMain;
        f.calls.push('save');
        if (f.options.blockSave) await f.save.promise;
      };
      export const updateSettings = async (file, live, patch) => {
        await writeSettings(file, { ...live, ...patch });
        Object.assign(live, patch);
      };
    `,
  };
  const extra = `
    export async function setupExitTest(f) {
      settings = f.stored;
      settingsFile = f.file;
      selectedOrigin = f.selectedOrigin;
      client = f.client;
      pipeOrigins.add(f.origin);

      if (f.options.startupOnly) {
        splashWindow = new BrowserWindow();

        return;
      }

      await createMainWindow(f.origin, f.stored);
    }
    export function setUpdateFixture(updates) {
      applicationUpdates = updates;
    }
    export { quit, createSurfaceWindow };
  `;
  const built = await build({
    stdin: {
      contents: 'const process = globalThis.__exitMain.process;\n'
        + await readFile(main, 'utf8') + extra,
      resolveDir: path.dirname(main.pathname),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    define: { __dirname: JSON.stringify(directory) },
    plugins: [{
      name: 'exit-test-ports',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          if (Object.hasOwn(stubs, args.path)) {
            return { path: args.path, namespace: 'exit-port' };
          }
        });
        builder.onLoad({ filter: /.*/, namespace: 'exit-port' }, (args) => ({
          contents: stubs[args.path],
          loader: 'js',
          resolveDir: path.dirname(main.pathname),
        }));
      },
    }],
    logLevel: 'silent',
  });
  const file = path.join(directory, 'main.mjs');

  await writeFile(file, built.outputFiles[0].text);

  const module = await import(pathToFileURL(file).href);

  await settle();
  await module.setupExitTest(f);
  t.after(async () => {
    server.resolve();
    save.resolve();
    cookies.resolve();
    pipeline.resolve();
    render.resolve({ ok: true });
    inspect.resolve(null);
    await module.quit.request({ reason: 'signal', exitCode: 0 });
    await settle();
    delete globalThis.__exitMain;
    await rm(directory, { recursive: true, force: true });
  });

  return {
    ...f,
    module,
    windows,
    window: windows[0],
    state,
    commands,
    signals,
    server,
    cookies,
    pipeline,
    render,
    inspect,
    settle,
  };
}
