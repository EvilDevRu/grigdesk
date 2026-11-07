import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from '../../../desktop/node_modules/esbuild/lib/main.js';
import { Window } from '../../../web/node_modules/happy-dom/lib/index.js';
import { normalizeSettings } from '../../../desktop/src/settings.ts';

/**
 * Загружается исходный main с добавленными только тестовыми экспортами private lifecycle.
 * Electron и внешняя подготовка заменены портами; showSplash и boot исполняются настоящие.
 */
export async function localeMain(t, { preference, systemLanguage = 'en-US' } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'i18n-main-'));
  const events = [];
  const abort = new AbortController();
  const load = Promise.withResolvers();
  const doc = new Window();
  const html = await readFile(new URL('../../../desktop/assets/splash/index.html', import.meta.url), 'utf8');
  let frames = 0;

  doc.document.write(html);
  doc.requestAnimationFrame = (callback) => {
    frames += 1;
    setImmediate(() => callback(frames));

    return frames;
  };

  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.executeJavaScript = async (script) => {
        events.push('execute');
        await doc.eval(script);
        events.push('execute-resolved');
      };
      globalThis.__localeMain.window = this;
    }

    removeMenu() {}
    isDestroyed() { 
      return false; 
    }
    isVisible() { 
      return this.visible || false; 
    }

    loadFile() {
      events.push('loadFile');

      return load.promise;
    }

    show() {
      events.push('show');
      this.visible = true;
      this.emit('show');
    }
  }

  const app = new EventEmitter();

  Object.assign(app, {
    setName() {},
    setPath() {},
    enableSandbox() {},
    getPath: () => directory,
    getPreferredSystemLanguages: () => [systemLanguage],
    getLocale: () => 'ru-RU',
    whenReady: async () => {},
    isReady: () => true,
    requestSingleInstanceLock: () => false,
    quit() {},
    exit() {},
    isPackaged: false,
  });

  const fixture = {
    app,
    events,
    abort,
    BrowserWindow,
    settings: normalizeSettings({ version: 2, uiLanguage: preference }),
    session: {
      fromPartition: () => ({
        setPermissionRequestHandler() {},
        setPermissionCheckHandler() {},
      }),
    },
  };

  // Нормализацию языка проверяет D03 отдельно; здесь main получает сохранённый выбор.
  if (preference !== undefined) {
    fixture.settings.uiLanguage = preference;
  }

  globalThis.__localeMain = fixture;

  const main = new URL('../../../desktop/src/main.ts', import.meta.url);
  const startup = new URL('../../../desktop/src/startupController.ts', import.meta.url).pathname;
  const stubs = {
    electron: `
      const f = globalThis.__localeMain;
      export const app = f.app;
      export const BrowserWindow = f.BrowserWindow;
      export class WebContentsView {}
      export const ipcMain = {
        handle() {}, on() {}, removeHandler() {}, removeListener() {},
      };
      export const session = f.session;
      export const screen = { getPrimaryDisplay: () => ({ workArea: {
        x: 0, y: 0, width: 1920, height: 1080,
      } }) };
      export const dialog = { showErrorBox() {}, showMessageBox: async () => ({ response: 0 }) };
      export const Menu = {};
      export const safeStorage = {};
      export const clipboard = {};
      export const shell = {};
    `,
    './settings.ts': `
      export async function readSettings() {
        globalThis.__localeMain.events.push('readSettings');
        return globalThis.__localeMain.settings;
      }
      export const writeSettings = async () => {};
      export const updateSettings = async (file, live, patch) => {
        await writeSettings(file, { ...live, ...patch });
        Object.assign(live, patch);
      };
    `,
    './runtimeConfig.ts': `
      export const runtimeDependencies = {};
      export async function loadServerRuntime() { throw new Error('fixture-stop-after-splash'); }
    `,
    './serverSupervisor.ts': 'export const createServerSupervisor = () => ({ stop: async () => {} });',
    './quitController.ts': `
      export const createQuitController = () => ({ stopping: false, request: async () => {} });
    `,
    './startupController.ts': `
      export { createFrameTracker, FRAME_LIMIT_MS, STARTUP_DEADLINE_MS, STARTUP_HOLD_LIMIT_MS }
        from ${JSON.stringify(startup)};
      export function createStartupController(adapters) {
        return {
          async start() {
            try {
              await adapters.showSplash(globalThis.__localeMain.abort.signal);
              await adapters.prepare(globalThis.__localeMain.abort.signal);
            } catch (error) {
              if (error.message !== 'fixture-stop-after-splash'
                  && !globalThis.__localeMain.abort.signal.aborted) throw error;
            }
          },
          cancel() {},
        };
      }
    `,
  };
  const result = await build({
    stdin: {
      contents: (await readFile(main, 'utf8')) + '\nexport { boot };\n',
      resolveDir: path.dirname(main.pathname),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    define: { __dirname: JSON.stringify(directory) },
    plugins: [{
      name: 'locale-main-ports',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          if (Object.hasOwn(stubs, args.path)) {
            return { path: args.path, namespace: 'locale-port' };
          }
        });
        builder.onLoad({ filter: /.*/, namespace: 'locale-port' }, (args) => ({
          contents: stubs[args.path],
          loader: 'js',
          resolveDir: path.dirname(main.pathname),
        }));
      },
    }],
    logLevel: 'silent',
  });
  const file = path.join(directory, 'main.mjs');

  await writeFile(file, result.outputFiles[0].text);

  const module = await import(pathToFileURL(file).href);
  const booting = module.boot();

  t.after(async () => {
    abort.abort();
    load.resolve();
    await booting;
    doc.close();
    delete globalThis.__localeMain;
    await rm(directory, { recursive: true, force: true });
  });

  for (let attempt = 0; attempt < 20 && !fixture.window; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  return { 
    events, 
    doc, 
    load, 
    booting, 
    fixture, 
    frames: () => frames 
  };
}
