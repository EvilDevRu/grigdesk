import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from '../../../web/node_modules/esbuild/lib/main.js';
import {
  compileScript, parse, registerTS,
} from '../../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.cjs.js';
import { compileModule, singletonUrl, webFile } from './compile-vue.js';
import { installUiBrowser } from './ui-components.js';
import { studioPluginFixture, studioUntil } from '../../server/helpers/studio3dPluginFixture.js';

const artifactRoot = '/home/evildev/.grigdesk/artifacts/studio3d-extraction';
const developmentDir = process.env.STUDIO3D_DEVELOPMENT_DIR;
const nodeRequire = createRequire(webFile('package.json'));

registerTS(() => nodeRequire('typescript'));

/**
 * Source fixture собирает независимые entry с одним shared chunk, как будущий payload.
 * Inspector не импортирует panel: чтение настоящего IDB adapter не загружает интерфейс.
 */
async function productGraph(t, host, { panel = true } = {}) {
  const directory = await mkdtemp(path.join(artifactRoot, 'browser-graph-'));
  const key = `studioUi${process.pid}${Date.now()}${Math.random()}`;
  const inspector = path.join(directory, 'inspector.ts');
  const sessionProbe = path.join(directory, 'sessionProbe.ts');
  const source = path.join(developmentDir, 'src/web');

  globalThis[key] = host.ui;
  t.after(async () => {
    delete globalThis[key];
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(inspector, [
    `export * as storage from ${JSON.stringify(path.join(source, 'features/studio3d/pendingIntents.ts'))};`,
    `export * as service from ${JSON.stringify(path.join(source, 'pendingService.ts'))};`,
  ].join('\n'));

  if (panel) {
    await writeFile(sessionProbe,
      `export {getStudioSession} from ${JSON.stringify(path.join(source, 'session.ts'))};\n`);
  }

  const uiExports = Object.keys(host.ui).filter((name) => /^[A-Za-z_$][\w$]*$/u.test(name)
    && name !== 'default').map((name) => `export const ${name} = ui.${name};`).join('\n');
  const entryPoints = {
    background: path.join(source, 'background.ts'),
    inspector,
    ...(panel ? { panel: path.join(source, 'panel.ts'), sessionProbe } : {}),
  };

  await build({
    entryPoints,
    outdir: directory,
    entryNames: '[name]',
    chunkNames: 'chunks/[name]-[hash]',
    outExtension: { '.js': '.mjs' },
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
    plugins: [{
      name: 'studio-public-host-and-sfc',
      /**
       * Vue/UI берутся у настоящего host, остальные зависимости принадлежат плагину.
       * SFC компилируются без CSS и без загрузки panel chunk фоновым entry.
       */
      setup(builder) {
        builder.onResolve({ filter: /^vue$/ }, () => ({ path: singletonUrl('vue'), external: true }));
        builder.onResolve({ filter: /^@grigdesk\/ui$/ }, () => ({ path: 'ui', namespace: 'host' }));
        builder.onLoad({ filter: /^ui$/, namespace: 'host' }, () => ({
          contents: `const ui = globalThis[${JSON.stringify(key)}];\n${uiExports}`,
          loader: 'js',
        }));
        builder.onResolve({ filter: /\.vue$/ }, (args) => ({
          path: path.resolve(args.resolveDir, args.path),
          namespace: 'sfc',
        }));
        builder.onLoad({ filter: /\.vue$/, namespace: 'sfc' }, async (args) => {
          const { readFile } = await import('node:fs/promises');
          const parsed = parse(await readFile(args.path, 'utf8'), { filename: args.path });

          assert.deepEqual(parsed.errors, []);

          const compiled = compileScript(parsed.descriptor, {
            id: path.basename(args.path),
            inlineTemplate: true,
          });

          return {
            contents: compiled.content,
            loader: 'ts',
            resolveDir: path.dirname(args.path),
          };
        });
      },
    }],
  });

  return {
    inspector: await import(pathToFileURL(path.join(directory, 'inspector.mjs')).href),
    background: () => import(pathToFileURL(path.join(directory, 'background.mjs')).href),
    panel: () => import(pathToFileURL(path.join(directory, 'panel.mjs')).href),
    session: async (context) => {
      const module = await import(pathToFileURL(path.join(directory, 'sessionProbe.mjs')).href);

      return module.getStudioSession(context);
    },
  };
}

/**
 * Bootstrap, context API и auth/state настоящие, сеть идёт в отдельный HTTP сервер.
 * SSE доставляется управляемой общей шиной; provider и профиль целиком принадлежат fixture.
 */
export async function studioBrowserFixture(t, options = {}) {
  const nativeFetch = globalThis.fetch;
  const server = await studioPluginFixture(t, { ...options, web: true });
  const address = await server.server.listen({ port: 0, host: '127.0.0.1' });
  const browser = await installUiBrowser(t);

  if (options.fullHost) {
    browser.happyDOM.setWindowSize({ width: options.width ?? 1280, height: 900 });
  }

  const directory = await mkdtemp(path.join(artifactRoot, 'browser-host-'));
  const entry = path.join(directory, 'entry.ts');
  const exports = {
    auths: 'stores/auth.ts',
    shells: 'stores/shell.ts',
    plugins: 'stores/plugins.ts',
    transport: 'shared/apiClient.ts',
    sse: 'composables/useSse.ts',
    docks: 'stores/dock.ts',
    modulePanel: 'views/ext/PluginModulePanel.vue',
    alerts: 'shared/alerts.ts',
    ...(options.fullHost ? {
      toolHost: 'shared/layout/ToolHost.vue',
      pluginView: 'views/PluginView.vue',
      toolCatalog: 'shared/tools/catalog.ts',
      toolRegistry: 'shared/tools/registry.ts',
      hotkeys: 'stores/hotkeys.ts',
      settings: 'stores/settings.ts',
    } : {}),
  };
  const entryLines = [
    `export * from ${JSON.stringify(webFile('src/pluginRuntime/bootstrap.ts'))};`,
    `export * as vue from 'vue';`,
    `export * as pinia from 'pinia';`,
    `export * as ui from ${JSON.stringify(webFile('src/ui.ts'))};`,
    ...Object.entries(exports).map(([name, file]) =>
      `export * as ${name} from ${JSON.stringify(webFile(`src/${file}`))};`),
  ];

  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(entry, entryLines.join('\n'));

  const builtinStubs = options.fullHost ? Object.fromEntries([
    'code/CodePanel', 'shelf/TaskShelfPanel', 'terminal/TerminalPanel',
    'ssh/SshPanel', 'db/DbPanel', 'docker/DockerPanel',
  ].map((name) => [`../../views/${name}.vue`,
    'export const __esModule = true; export default { render: () => null };'])) : {};
  const host = await compileModule(entry, {
    stubs: {
      '../shared/desktopSettings.ts': 'export const currentDesktopMode = () => "page";',
      ...builtinStubs,
    },
  });
  const product = await productGraph(t, host, options);
  const require = createRequire(path.join(developmentDir, 'package.json'));
  const { IDBFactory } = await import(pathToFileURL(require.resolve('fake-indexeddb')).href);
  const factory = options.factory ?? new IDBFactory();
  const previousIndexed = globalThis.indexedDB;

  globalThis.indexedDB = factory;
  t.after(() => globalThis.indexedDB = previousIndexed);

  const storage = product.inspector.storage.createStudioPending(factory);
  const requests = [];
  const imports = [];
  const sources = [];
  const panelContexts = [];
  const previousEventSource = globalThis.EventSource;
  let panelImports = 0;
  let backgroundImports = 0;
  let requestHook = null;

  globalThis.EventSource = class {
    listeners = new Map();
    closed = false;

    constructor() {
      sources.push(this);
    }

    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    }

    close() {
      this.closed = true;
    }
  };
  t.after(() => {
    host.sse.resetSseForTests();
    globalThis.EventSource = previousEventSource;
  });

  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(String(input), 'https://grigdesk.test');
    const record = {
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      init,
    };

    requests.push(record);

    const intercepted = await requestHook?.(record);

    if (intercepted) {
      return intercepted;
    }

    const response = await nativeFetch(`${address}${url.pathname}${url.search}`, {
      ...init,
      headers: { ...init?.headers, cookie: 'grigdesk_sid=fixture-session' },
    });


    return response;
  });

  const pinia = host.pinia.createPinia();
  const auth = host.auths.useAuthStore(pinia);
  const shell = host.shells.useShellStore(pinia);
  const plugins = host.plugins.usePluginsStore(pinia);

  /**
   * Транспорт доставляет JSON через настоящий общий SSE decoder и подписчиков.
   * Закрытая connection не повторяет событие после следующей auth эпохи.
   */
  const emit = (name, data) => {
    for (const source of sources) {
      if (!source.closed) {
        source.listeners.get(name)?.({ data: JSON.stringify(data) });
      }
    }
  };
  const previousBroadcast = server.server.sse.broadcast;

  server.server.sse.broadcast = (name, data) => {
    previousBroadcast(name, data);
    emit(name, data);
  };
  shell.initialized = true;
  shell.present = true;
  shell.snapshot = { status: 'online', profile: { id: 'fixture-profile' } };

  let router;
  let routerView;

  if (options.fullHost) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'history');

    Object.defineProperty(globalThis, 'history', { value: browser.history, configurable: true });
    t.after(() => {
      if (previous) {
        Object.defineProperty(globalThis, 'history', previous);
      } else {
        delete globalThis.history;
      }
    });

    const routerModule = await import(singletonUrl('vue-router'));

    routerView = routerModule.RouterView;
    router = routerModule.createRouter({
      history: routerModule.createMemoryHistory(),
      routes: [
        {
          path: '/chats',
          name: 'chats',
          component: { render: () => null },
        },
        {
          path: '/ext/:id',
          name: 'plugin',
          component: host.pluginView.default,
          meta: { tool: 'ext' },
        },
      ],
    });
    await router.push(options.route ?? '/chats');
    await router.isReady();
  } else {
    router = {
      currentRoute: host.vue.ref({
        path: '/chats',
        meta: {},
        params: {},
      }),
      push: async () => {},
    };
  }

  const dispose = host.installPluginRuntime(pinia, router, {
    subscribe: host.sse.sseSubscribe,
    backgroundImport: async (url) => {
      imports.push(url);

      if (url === 'vue') {
        return host.vue;
      }

      if (url === '@grigdesk/ui') {
        return host.ui;
      }

      assert.ok(url.endsWith('/background.js'));
      backgroundImports += 1;

      return product.background();
    },
    loadPluginModule: async () => {
      panelImports += 1;

      const module = await product.panel();

      return {
        component: module.default,
        start: async (context) => {
          panelContexts.push(context);

          return module.start(context);
        },
        releaseStyles() {},
      };
    },
  });

  t.after(() => {
    dispose();
    host.ui.dismissAllToasts();
  });

  const dock = options.fullHost ? host.docks.useDockStore(pinia) : null;
  const settings = options.fullHost ? host.settings.useSettingsStore(pinia) : null;
  const hotkeys = options.fullHost ? host.hotkeys.useHotkeysStore(pinia) : null;
  let fullHostElement = null;

  /**
   * Реальный PluginModulePanel загружает CSS по настоящему URL через общий styles runtime.
   * Fixture только подтверждает DOM load после успешного HTTP; размеры/WebGL этим не принимаются.
   */
  const settle = async () => {
    for (let turn = 0; turn < 8; turn += 1) {
      if (options.fullHost) {
        for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
          if (!link.dataset.fixtureLoaded) {
            link.dataset.fixtureLoaded = 'true';

            const response = await fetch(link.href);

            assert.equal(response.status, 200);
            await response.text();
            link.dispatchEvent(new browser.Event('load'));
          }
        }
      }

      await host.vue.nextTick();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  /**
   * ToolHost и PluginView берутся из того же настоящего core graph, что runtime/stores/UI.
   * Подменены только другие тяжёлые builtin панели; Studio3D импортируется исключительно из P.
   */
  const mountHost = async () => {
    assert.equal(options.fullHost, true);
    assert.equal(fullHostElement, null, 'Одна оболочка на fixture');

    fullHostElement = document.createElement('div');

    const component = {
      setup: () => () => host.vue.h('div', { class: 'shell' }, [
        host.vue.h('main', { class: 'content' }, [host.vue.h(routerView)]),
        host.vue.h(host.toolHost.default),
      ]),
    };
    const app = host.vue.createApp(component);

    document.body.append(fullHostElement);
    app.use(pinia).use(router).mount(fullHostElement);
    t.after(() => {
      app.unmount();
      fullHostElement.remove();
    });
    await settle();

    return fullHostElement;
  };

  return {
    ...server,
    host,
    product,
    browser,
    factory,
    storage,
    requests,
    imports,
    sources,
    panelContexts,
    auth,
    shell,
    plugins,
    pinia,
    router,
    dock,
    settings,
    hotkeys,
    mountHost,
    get element() { return fullHostElement; },
    emit,
    dispose,
    runtime: host.pluginRuntimeFor(pinia),
    service: () => product.inspector.service.getPendingService(server.authStore.clientScope),
    counts: () => ({ panel: panelImports, background: backgroundImports }),
    hook: (value) => requestHook = value,
    login: async (owner = server.authStore.clientScope) => {
      server.authStore.clientScope = owner;
      auth.$patch({
        ready: true,
        authenticated: true,
        clientScope: owner,
      });
      settings?.setAuthenticated(true);
      await studioUntil(() => Promise.resolve(plugins.loaded), Boolean);
    },
    settle,
    ready: async () => studioUntil(async () => {
      const service = product.inspector.service.peekPendingService(server.authStore.clientScope);

      return service?.librarySnapshot();
    }, (value) => value?.admitted === true),
    acquire: () => {
      const descriptor = plugins.byId('studio3d')?.entrypoints?.web;

      assert.ok(descriptor);

      return host.pluginRuntimeFor(pinia).acquirePanel('studio3d', descriptor);
    },
  };
}
