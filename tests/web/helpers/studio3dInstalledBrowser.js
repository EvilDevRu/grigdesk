// Fixture16: настоящий core host и installed HTTP bundle, без Psource/service inspector.
// Happy-dom проверяет protocol/DOM действия; пиксели, Node/Electron и live WebGL остаются отдельной приёмкой.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createPluginEnvironment } from '../../../server/src/lib/pluginEnvironment.ts';
import {
  installedStudioFixture, installStudio, installedUntil,
} from '../../server/helpers/studio3dInstalledFixture.js';
import { studioPackageRepo } from '../../server/helpers/studio3dPackageRepo.js';
import { compileModule, webFile } from './compile-vue.js';
import { installUiBrowser } from './ui-components.js';
import { createPackagedWebGraph } from './packagedWebGraph.js';
import { createStudioBrowserStorage } from './studio3dBrowserStorage.js';

const artifacts = '/home/evildev/.grigdesk/artifacts/studio3d-extraction';

/**
 * Реальный installer получает точный export1.0.0; product JS читается только по его public HTTP URL.
 * Собирается лишь core host fixture; при отсутствии package input исходникового fallback нет.
 */
export async function installedStudioBrowserFixture(t, { input, factory: suppliedFactory } = {}) {
  assert.ok(input, 'Нужен проверенный STUDIO3D_PACKAGE_DIR');

  const nativeFetch = globalThis.fetch;
  const fixture = await installedStudioFixture(t, {
    createEnvironment: createPluginEnvironment,
    enabled: true,
  });
  const repo = await studioPackageRepo(t, input);
  const boot = await fixture.boot();

  await installStudio(boot, repo, '1.0.0');

  const address = await boot.listen();
  const browser = await installUiBrowser(t);
  const storage = await createStudioBrowserStorage(t, suppliedFactory);
  const factory = storage.factory;
  const previousIdb = globalThis.indexedDB;
  const previousEventSource = globalThis.EventSource;
  const directory = await mkdtemp(path.join(artifacts, 'installed-host-'));
  const entry = path.join(directory, 'host.ts');
  const entryLines = [
    `export * from ${JSON.stringify(webFile('src/pluginRuntime/bootstrap.ts'))};`,
    'export * as vue from "vue";',
    'export * as pinia from "pinia";',
    `export * as ui from ${JSON.stringify(webFile('src/ui.ts'))};`,
    ...Object.entries({
      auths: 'stores/auth.ts',
      shells: 'stores/shell.ts',
      plugins: 'stores/plugins.ts',
      sse: 'composables/useSse.ts',
      modulePanel: 'views/ext/PluginModulePanel.vue',
      moduleLoader: 'pluginRuntime/loader.ts',
    }).map(([name, file]) => `export * as ${name} from ${JSON.stringify(webFile(`src/${file}`))};`),
  ];

  await writeFile(entry, entryLines.join('\n'));

  const host = await compileModule(entry, {
    stubs: { '../shared/desktopSettings.ts': 'export const currentDesktopMode = () => "page";' },
  });
  const requests = [];
  const sources = [];
  const graphs = [];
  const graphReads = new Map();
  const panels = new Set();
  const styles = [];
  const assetErrors = [];
  const moduleErrors = [];
  let intercepted = null;
  let backgroundImports = 0;
  let panelImports = 0;
  let sequence = 0;
  let stopped = false;

  globalThis.indexedDB = factory;
  browser.happyDOM.settings.disableCSSFileLoading = true;
  browser.happyDOM.settings.disableJavaScriptFileLoading = true;
  globalThis.EventSource = class {
    listeners = new Map();
    closed = false;

    constructor() {
      sources.push(this);
    }

    addEventListener(name, callback) {
      this.listeners.set(name, callback);
    }

    close() {
      this.closed = true;
    }
  };

  /**
   * Public HTTP ответ целиком отделяется от AbortSignal после получения bytes.
   * Только затем barrier теста удерживает late A, проверяя guard вместо нативного abort поведения fetch.
   */
  async function http(method, url, payload, init = {}) {
    const headers = new Headers(init.headers);

    for (const [key, value] of Object.entries(boot.session)) {
      headers.set(key, value);
    }

    const response = await nativeFetch(new URL(url, address), {
      ...init,
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
    });
    const rawPayload = Buffer.from(await response.arrayBuffer());

    return {
      statusCode: response.status,
      headers: Object.fromEntries(response.headers),
      rawPayload,
      body: rawPayload.toString('utf8'),
    };
  }

  t.mock.method(globalThis, 'fetch', async (inputUrl, init = {}) => {
    const url = new URL(typeof inputUrl === 'string' ? inputUrl : inputUrl.url, globalThis.location.href);

    if (url.protocol === 'blob:' || url.protocol === 'data:') {
      return nativeFetch(inputUrl, init);
    }

    assert.equal(url.origin, globalThis.location.origin);

    const record = {
      method: init.method ?? 'GET',
      path: url.pathname + url.search,
      body: init.body,
    };

    requests.push(record);

    const actual = await http(record.method, record.path, init.body, init);
    const response = new Response([204, 205, 304].includes(actual.statusCode) ? null : actual.rawPayload,
      { status: actual.statusCode, headers: actual.headers });

    record.status = actual.statusCode;
    record.responseText = actual.body;

    return await intercepted?.(record, response) ?? response;
  });

  const pinia = host.pinia.createPinia();
  const auth = host.auths.useAuthStore(pinia);
  const shell = host.shells.useShellStore(pinia);
  const plugins = host.plugins.usePluginsStore(pinia);
  const router = {
    currentRoute: host.vue.ref({
      path: '/chats',
      meta: {},
      params: {},
      query: {},
    }),
    push: async () => {},
  };
  const previousBroadcast = boot.app.sse.broadcast;

  /**
   * Управляемый транспорт доставляет JSON в настоящий useSse decoder и единственную шину вкладки.
   * Закрытый EventSource не получает новых сообщений после owner/epoch revoke.
   */
  const emit = (name, data) => {
    for (const source of sources) {
      if (!source.closed) {
        source.listeners.get(name)?.({ data: JSON.stringify(data) });
      }
    }
  };

  boot.app.sse.broadcast = (name, data) => {
    previousBroadcast(name, data);
    emit(name, data);
  };
  shell.initialized = true;
  shell.present = true;
  shell.snapshot = { status: 'online', profile: { id: 'fixture-installed-profile' } };

  /**
   * Descriptor key разделяет поколения; один key даёт общий HTTP module cache для panel/background.
   * Ни сортировки SYSTEM, ни удаления builtin карточки в final fixture нет.
   */
  const graphFor = descriptor => {
    const key = JSON.stringify(descriptor);

    if (!graphReads.has(key)) {
      graphReads.set(key, createPackagedWebGraph(t, {
        host,
        descriptor,
        request: http,
      }).then(graph => {
        graphs.push(graph);

        return graph;
      }));
    }

    return graphReads.get(key);
  };

  const disposeRuntime = host.installPluginRuntime(pinia, router, {
    subscribe: host.sse.sseSubscribe,
    backgroundImport: async url => {
      if (url === 'vue') {
        return host.vue;
      }
      if (url === '@grigdesk/ui') {
        return host.ui;
      }

      const descriptor = plugins.byId('studio3d')?.entrypoints?.web;

      assert.ok(descriptor);
      assert.equal(url, descriptor.background);
      backgroundImports += 1;

      return (await graphFor(descriptor)).load(url);
    },
    loadPluginModule: async (id, descriptor, options) => {
      panelImports += 1;

      const graph = await graphFor(descriptor);

      try {
        return await host.moduleLoader.loadPluginModule(id, descriptor, {
          ...options, importModule: graph.load,
        });
      } catch (error) {
        moduleErrors.push({ message: error.message, stack: error.stack });

        throw error;
      }
    },
  });
  const appendChild = document.head.appendChild.bind(document.head);
  const append = document.head.append.bind(document.head);
  const handledStyles = new WeakSet();

  /**
   * Host добавляет CSS через append; обе native формы получают один HTTP receipt.
   * Событие load разрешает реальный style registry только после проверки публичных bytes/MIME.
   */
  function receiveStyle(element) {
    if (element?.tagName !== 'LINK' || element.rel !== 'stylesheet' || handledStyles.has(element)) {
      return;
    }

    handledStyles.add(element);
    void (async () => {
      const graph = graphs.find(graph => {
        try {
          graph.publicUrl(element.href);

          return true;
        } catch {
          return false;
        }
      });

      assert.ok(graph, 'CSS должен принадлежать текущему installed module generation');

      const response = await http('GET', graph.publicUrl(element.href));

      assert.equal(response.statusCode, 200, response.body);
      assert.match(response.headers['content-type'], /css/u);
      styles.push({
        url: graph.publicUrl(element.href),
        sha256: createHash('sha256').update(response.rawPayload).digest('hex'),
      });
      element.dispatchEvent(new browser.Event('load'));
    })().catch(cause => {
      assetErrors.push(cause);
      element.dispatchEvent(new browser.Event('error'));
    });
  }

  /**
   * Happy-dom синхронно выдаёт error для отключённого CSS network во время append.
   * Только это native окно подавляется; после append реальный HTTP receipt решает load/error.
   */
  function appendWithStylePort(elements, effect) {
    const links = elements.filter(element => element?.tagName === 'LINK'
      && element.rel === 'stylesheet');
    const disabledNativeError = event => event.stopImmediatePropagation();

    links.forEach(element => element.addEventListener('error', disabledNativeError, { capture: true }));

    try {
      const result = effect();

      links.forEach(receiveStyle);

      return result;
    } finally {
      links.forEach(element => element.removeEventListener('error', disabledNativeError, { capture: true }));
    }
  }

  t.mock.method(document.head, 'appendChild', element => appendWithStylePort([element],
    () => appendChild(element)));
  t.mock.method(document.head, 'append', (...elements) => appendWithStylePort(elements,
    () => append(...elements)));

  /**
   * Cleanup прекращает новый background до возврата прежней глобальной IDB/transport среды.
   * Прямой release private product service не вызывается: он принадлежит actual host coordinator.
   */
  const dispose = () => {
    if (stopped) {
      return;
    }

    stopped = true;

    for (const panel of panels) {
      panel.unmount();
    }

    panels.clear();
    disposeRuntime();
    host.sse.resetSseForTests();
    host.ui.dismissAllToasts();
    globalThis.EventSource = previousEventSource;
    globalThis.indexedDB = previousIdb;
    boot.app.sse.broadcast = previousBroadcast;
  };

  t.after(() => {
    dispose();
    host.pinia.disposePinia(pinia);
  });
  t.after(() => rm(directory, { recursive: true, force: true }));

  const settle = async () => {
    for (let turn = 0; turn < 8; turn += 1) {
      await host.vue.nextTick();
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  return {
    fixture,
    boot,
    host,
    browser,
    storage,
    factory,
    graphs,
    styles,
    assetErrors,
    requests,
    sources,
    plugins,
    auth,
    pinia,
    router,
    dispose,
    settle,
    http,
    emit,
    counts: () => ({ panel: panelImports, background: backgroundImports }),
    hook: callback => {
      intercepted = callback;
    },
    login: async (owner = boot.authStore.clientScope) => {
      boot.authStore.clientScope = owner;
      auth.$patch({
        ready: true,
        authenticated: true,
        clientScope: owner,
      });
      await installedUntil(async () => plugins.loaded && host.pluginRuntimeAccessFor(pinia)?.value.status,
        value => value === 'ready');

      const studioCards = plugins.list.filter(plugin => plugin.id === 'studio3d');

      assert.equal(studioCards.length, 1);
      assert.equal(studioCards[0].system, false);
    },
    ready: async () => installedUntil(async () => requests.some(record => record.method === 'GET'
      && record.path === '/api/ext/studio3d/state' && record.status === 200), Boolean),
    /**
     * Actual generic wrapper монтирует default установленного panel и отправляет обычные intents.
     * Никаких product modules/session/store exports или test-specific hooks здесь нет.
     */
    async mountPanel(params = { tab: 'create' }) {
      const intents = host.vue.shallowRef([{
        id: ++sequence,
        type: 'open',
        params,
      }]);
      const element = document.createElement('div');
      const app = host.vue.createApp({ setup: () => () => host.vue.h(host.modulePanel.default, {
        pluginId: 'studio3d',
        descriptor: plugins.byId('studio3d').entrypoints.web,
        label: '3D',
        active: true,
        presentation: 'page',
        intents: intents.value,
        onConsumeIntent: id => {
          intents.value = intents.value.filter(item => item.id !== id);
        },
      }) });

      document.body.appendChild(element);
      app.use(pinia);
      app.mount(element);

      const panel = {
        element,
        unmount() {
          app.unmount();
          element.remove();
          panels.delete(panel);
        },
        open: params => {
          intents.value = [{
            id: ++sequence,
            type: 'open',
            params,
          }];
        },
      };

      panels.add(panel);
      await installedUntil(async () => ({
        ready: Boolean(element.querySelector('.studio-panel')),
        html: element.innerHTML,
        assetErrors: assetErrors.map(error => error.message),
        moduleErrors,
        importErrors: graphs.flatMap(graph => graph.importErrors),
      }), value => value.ready);
      assert.deepEqual(assetErrors, []);

      return panel;
    },
  };
}
