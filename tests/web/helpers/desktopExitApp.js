import { protocolHead } from './chat-protocol.js';
import { after } from 'node:test';

import { appWindowStubs } from './app-window-stubs.js';
import { compileModule, webFile } from './compile-vue.js';
import { createUiBrowser } from './ui-components.js';

let browser;

after(() => browser?.close());

/**
 * Настоящий App, будущий exit host, Dialog и API-клиент входят в один граф.
 * Отсутствующий renderer bridge не подменяется: команды исходно не меняют DOM и дают поведенческий RED.
 */
export async function desktopExitApp(t, options = {}) {
  browser ||= await createUiBrowser('http://127.0.0.1:19999/');
  browser.document.body.innerHTML = '<div id="mount"></div>';
  browser.localStorage.clear();
  delete browser.grigdeskDesktopExit;

  Object.defineProperty(browser.navigator, 'userAgent', {
    configurable: true,
    value: options.userAgent ?? 'Synthetic GrigDeskSettings/1 GrigDeskWindow/main',
  });

  const [{ reactive, nextTick }, piniaApi, utils] = await Promise.all([
    import('../../../web/node_modules/vue/index.mjs'),
    import('../../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
  ]);
  const control = {
    calls: [],
    handlers: {},
    active: options.active ?? {
      active: [{ chatKey: 'one', runId: 'run-one' }],
      queued: [],
    },
    tasks: options.tasks ?? { tasks: [{
      task: '7',
      title: 'Задача <raw>',
      daemonAlive: true,
    }] },
    titles: options.titles ?? { one: 'Чат <raw>' },
  };
  const auth = reactive({
    ready: true,
    authenticated: true,
    load: async () => {},
    watchUnauthorized() {},
    stopRecovery() {},
  });
  const other = {
    external: [],
    load: async () => {},
    startPolling() {},
    stopPolling() {},
    start() {},
    stop() {},
    clear() {},
    stopPoll() {},
    setPassive() {},
    clearSource() {},
  };

  other.$onAction = () => () => {};
  other.own = { ...other };

  globalThis.__desktopExitApp = { auth, other };

  const previousFetch = globalThis.fetch;

  /**
   * Транспорт отдаёт API DTO с теми же полями, что настоящие /active, /tasks и chat store.
   * Незаданный URL — ошибка фикстуры, а ручные handlers могут задержать или отклонить Stop.
   */
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    const call = {
      path,
      method: init.method ?? 'GET',
      ...init,
    };

    control.calls.push(call);

    if (control.handlers[path]) {
      return control.handlers[path](call);
    }

    let payload;

    if (path === '/api/chat/active') {
      payload = control.active;
    } else if (path === '/api/tasks') {
      payload = control.tasks;
    } else if (path.startsWith('/api/chat/store/head/')) {
      const id = decodeURIComponent(path.slice('/api/chat/store/head/'.length));

      payload = { head: protocolHead({
        id,
        title: control.titles[id] ?? '',
        messages: [],
      }) };
    } else if (/^\/api\/tasks\/\d+\/stop$/.test(path)) {
      payload = { ok: true, outcome: 'stopped' };
    } else {
      throw new Error(`Неизвестный API exit-фикстуры: ${call.method} ${path}`);
    }

    return new Response(JSON.stringify(payload));
  };

  const stubs = {
    ...appWindowStubs,
    './stores/auth.ts': 'export const useAuthStore = () => globalThis.__desktopExitApp.auth;',
    './views/settings/SettingsModal.vue': 'export default { render: () => null };',
    './features/speech/provider.ts': 'export const SpeechProvider = { template: `<div><slot /></div>` };',
    './shared/layout/AppShell.vue': 'export default { template: `<div><slot /></div>` };',
    './views/ConnectionsView.vue': 'export default { template: `<div data-machines />` };',
    './shared/layout/LockOverlay.vue': 'export default { render: () => null };',
    '../router.ts': 'export const router = { push: async () => {} };',
  };

  delete stubs['./shared/layout/DesktopExitHost.vue'];

  for (const [name, exported] of [
    ['board', 'useBoardStore'], ['system', 'useSystemStore'], ['taskFavorites', 'useTaskFavoritesStore'],
    ['taskShelf', 'useTaskShelfStore'],
    ['taskSeen', 'useTaskSeenStore'],
    ['videoSession', 'useVideoSessionStore'],
  ]) {
    stubs[`./stores/${name}.ts`] = `export const ${exported} = () => globalThis.__desktopExitApp.other;`;
  }

  for (const name of ['TaskModal', 'DiffModal', 'DocumentModal', 'MediaViewer']) {
    stubs[`./views/${name}.vue`] = 'export default { render: () => null };';
  }

  const module = await compileModule(webFile('../tests/web/helpers/desktopExitApp.ts'), { stubs });

  module.decodeChatEnvelope(structuredClone(control.active));

  const pinia = piniaApi.createPinia();

  piniaApi.setActivePinia(pinia);

  const shell = module.useShellStore(pinia);
  const settings = module.useSettingsStore(pinia);
  const chat = module.useChatStore(pinia);
  const snapshot = {
    rev: 1,
    profile: {
      id: 'local',
      kind: 'local',
      address: 'http://127.0.0.1:19998',
      name: 'Этот компьютер',
    },
    profiles: [],
    status: 'online',
    detail: null,
    capabilities: [],
    localAvailable: true,
    desktopExit: { skipConfirmation: false },
  };

  shell.apply(options.shellSnapshot === undefined ? snapshot : options.shellSnapshot);
  shell.initialized = true;
  shell.start = async () => {};
  module.setUiLocale(options.locale ?? 'ru');

  const wrapper = utils.mount(module.App, {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [pinia], stubs: { RouterView: { template: '<div />' }, transition: false } },
  });

  t.after(async () => {
    wrapper.unmount();
    shell.stop();
    settings.dispose();
    await utils.flushPromises();
    globalThis.fetch = previousFetch;
    delete globalThis.__desktopExitApp;
    delete browser.grigdeskDesktopExit;
  });
  await utils.flushPromises();

  return {
    browser,
    control,
    auth,
    shell,
    settings,
    chat,
    wrapper,
    module,
    ...utils,
    nextTick,
    snapshot,
    /**
     * Wire-вызов соответствует фиксированной renderer-команде принятого плана.
     * Optional вызов нужен только исходному App без bridge; DOM/ответ остаётся исходным.
     */
    async command(type, extra = {}) {
      const response = await browser.grigdeskDesktopExit?.({
        type,
        requestId: 'exit-request',
        expiresAt: Date.now() + 20000,
        ...extra,
      });

      await utils.flushPromises();

      return response;
    },
    dialogs: () => [...browser.document.querySelectorAll('[role="dialog"]')],
    stops: () => control.calls.filter((call) => /\/tasks\/[^/]+\/stop$/.test(call.path)),
  };
}
