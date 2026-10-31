import { migrationUrl } from './helpers/compile-vue.js';
// Интерфейс без входа: локальный экран «Нет входа», одна перезагрузка по 401 и владелец 3D.
// Настоящие App и стор авторизации работают с подменённой сетью и подменённым reload.
process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { appWindowStubs } from './helpers/app-window-stubs.js';

import { compileVue, webFile } from './helpers/compile-vue.js';

const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');

/**
 * Компонент получает отдельное браузерное окно с настоящим sessionStorage.
 * Адрес и reload подменяются: ни один тест не уходит с тестовой страницы.
 */
async function installBrowser(t) {
  const browser = new Window({
    url: 'http://127.0.0.1:28140/',
  });

  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }

  browser.document.body.innerHTML = '<div id="mount"></div>';
  t.after(() => browser.close());

  return browser;
}

/**
 * Настоящий стор авторизации получает сеть через подмену apiClient.
 * Подменяются только запросы и признак перезагрузки: логика входа остаётся продуктовой.
 */
async function mountApp(t, options = {}) {
  const browser = await installBrowser(t);
  const h = {
    calls: [],
    polling: [],
    reloads: 0,
    unauthorized: null,
    shell: {
      initialized: true,
      present: false,
      status: 'none',
      start: async () => {},
      stop: () => {},
    },
    state: options.state ?? {
      method: 'window-key',
      configured: true,
      authenticated: false,
      secure: false,
    },
  };

  h.network = {
    get: async (path) => {
      h.calls.push({
        method: 'GET',
        path,
      });

      if (path === '/api/auth/state') {
        return typeof h.state === 'function' ? h.state() : h.state;
      }

      throw new Error('Приватный запрос без входа: ' + path);
    },
    post: async (path) => {
      h.calls.push({
        method: 'POST',
        path,
      });

      throw new Error('POST без входа не ожидается: ' + path);
    },
  };
  h.register = (handler) => {
    h.unauthorized = handler;

    return () => {
      h.unauthorized = null;
    };
  };
  globalThis.__noAccess = h;

  Object.defineProperty(browser.location, 'reload', {
    configurable: true,
    value: () => {
      h.reloads += 1;
    },
  });

  const marker = (name) => `import { h } from 'vue';
    export const __esModule = true;
    export default { setup(_props, { slots }) {
      return () => h('div', { 'data-app': '${name}' }, slots.default?.());
    }};`;
  const store = (name, extra = '') => `export const ${name} = () => ({
    startPolling: () => globalThis.__noAccess.polling.push('start'),
    stopPolling: () => globalThis.__noAccess.polling.push('stop'),
    load: () => {}, start: () => {}, stop: () => {}, clear: () => {}, stopPoll: () => {},
    clearSource: () => {},
    ${extra} });`;
  const stubs = {
    ...appWindowStubs,
    './stores/settings.ts': `export const useSettingsStore = () => ({
      isOpen: false, setAuthenticated() {}, dispose() {},
    });`,
    './views/settings/SettingsModal.vue': 'export default { render: () => null };',
    './shared/desktopSettings.ts': 'export const currentDesktopMode = () => "page";',
    './shared/layout/AppShell.vue': marker('main'),
    './views/LoginView.vue': marker('login'),
    './views/ConnectionsView.vue': marker('machines'),
    './shared/layout/LockOverlay.vue': marker('lock'),
    './features/speech/provider.ts': `import { h } from 'vue';
      export const SpeechProvider = {
        setup(_props, { slots }) { return () => h('div', slots.default?.()); }
      };`,
    './views/TaskModal.vue': marker('task'),
    './views/DiffModal.vue': marker('diff'),
    './views/DocumentModal.vue': marker('document'),
    './views/MediaViewer.vue': marker('media'),
    './ui': `import { h } from 'vue';
      export { t, uiLocale } from ${JSON.stringify(webFile('src/services/locale.ts'))};
      const Host = { render: () => h('div') };
      export const UiDialogHost = Host;
      export const UiTooltipHost = Host;
      export const UiToastHost = Host;
      export const UiInlineMessage = Host;
      export const UiSpinner = Host;`,
    './shared/alerts.ts': `
      export const clearAlertHistory = () => {};
      export const dismissAllAlerts = () => {};`,
    './shared/apiClient.ts': `export const api = {
      get: (path) => globalThis.__noAccess.network.get(path),
      post: (path, body) => globalThis.__noAccess.network.post(path, body),
      onUnauthorized: (handler) => globalThis.__noAccess.register(handler),
    };`,
    '../shared/apiClient.ts': `export const api = {
      get: (path) => globalThis.__noAccess.network.get(path),
      post: (path, body) => globalThis.__noAccess.network.post(path, body),
      onUnauthorized: (handler) => globalThis.__noAccess.register(handler),
    };`,
    './stores/auth.ts': `export { useAuthStore } from ${JSON.stringify(webFile('src/stores/auth.ts'))};`,
    './stores/shell.ts': 'export const useShellStore = () => globalThis.__noAccess.shell;',
    './shell.ts': 'export const useShellStore = () => globalThis.__noAccess.shell;',
    './stores/board.ts': store('useBoardStore'),
    './stores/system.ts': store('useSystemStore'),
    './stores/taskFavorites.ts': store('useTaskFavoritesStore'),
    './stores/taskShelf.ts': store('useTaskShelfStore'),
    './stores/taskSeen.ts': store('useTaskSeenStore'),
    './stores/videoSession.ts': store('useVideoSessionStore'),
  };
  const { createPinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );

  setActivePinia(createPinia());

  const component = await compileVue(webFile('src/App.vue'), { stubs });
  const wrapper = mount(component, {
    attachTo: browser.document.querySelector('#mount'),
    global: { stubs: { RouterView: true } },
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__noAccess;
    browser.sessionStorage.clear();
  });

  for (let index = 0; index < 4; index += 1) {
    await flushPromises();
  }

  return {
    h,
    browser,
    wrapper,
    flushPromises,
  };
}

test('DW-NA1: старт без сессии показывает «Нет входа» без приватных запросов', async (t) => {
  const { h, wrapper } = await mountApp(t);

  assert.match(wrapper.text(), /Нет входа/u);
  assert.match(wrapper.text(), /GrigDesk открывается в приложении/u);
  // Внутри приложения экран бывает тупиком: подсказка называет действие, которое
  // повторно запустит приложение и даст окну восстановить вход по ключу.
  assert.match(wrapper.text(), /снова запустите приложение/u);
  assert.doesNotMatch(wrapper.text(), /Ctrl\+R/u);
  assert.deepEqual(h.calls, [{
    method: 'GET',
    path: '/api/auth/state',
  }]);
  assert.equal(h.reloads, 0);
  assert.deepEqual(h.polling, []);
  assert.equal(wrapper.find('[data-app=main]').exists(), false);
  assert.equal(wrapper.find('[data-app=login]').exists(), false);
  assert.equal(wrapper.find('[data-app=version]').exists(), false);
});

test('DW-NA2: первый 401 перезагружает документ один раз и гасит поллинги', async (t) => {
  const { h, wrapper } = await mountApp(t, {
    state: {
      method: 'window-key',
      configured: true,
      authenticated: true,
      secure: false,
      clientScope: 'legacy-login',
    },
  });

  assert.equal(wrapper.find('[data-app=main]').exists(), true);
  assert.deepEqual(h.polling, ['start', 'start']);

  h.unauthorized({});
  await Promise.resolve();

  assert.equal(h.reloads, 1);
  assert.equal(h.polling.filter((call) => call === 'stop').length, 2);
  assert.match(wrapper.text(), /Нет входа/u);
});

test('DW-NA3: повторный 401 не перезагружает документ второй раз', async (t) => {
  const { h } = await mountApp(t);

  h.unauthorized({});
  h.unauthorized({});
  await Promise.resolve();

  assert.equal(h.reloads, 1);
});

test('DW-NA4: недоступный sessionStorage считается уже перезагруженным', async (t) => {
  const { h } = await mountApp(t);

  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get() {
      throw new Error('storage недоступен');
    },
  });

  h.unauthorized({});
  await Promise.resolve();

  assert.equal(h.reloads, 0);
});

test('DW-NA5: ответ 401 не повторяется и обмен ключа окна не вызывается', async (t) => {
  let answers = 0;
  const { h, wrapper } = await mountApp(t);

  h.state = () => {
    answers += 1;

    throw Object.assign(new Error('unauthorized'), {
      status: 401,
    });
  };

  // Повторный load доказывает единственность запроса на один вызов.
  const { useAuthStore } = await import(migrationUrl('src/stores/auth.ts').href);
  const store = useAuthStore();

  await store.load();
  await store.load();

  assert.equal(answers, 2);
  assert.equal(typeof h.unauthorized, 'function');
  assert.equal(h.calls.every((call) => call.method === 'GET'), true);
  assert.equal(h.calls.some((call) => call.path.includes('window-session')), false);
  assert.match(wrapper.text(), /Нет входа/u);
});

test('DW-NA6: прежний вход становится clientScope владельца 3D', async (t) => {
  const { h } = await mountApp(t);
  const { useAuthStore } = await import(migrationUrl('src/stores/auth.ts').href);

  h.state = {
    method: 'window-key',
    configured: true,
    authenticated: true,
    secure: false,
    clientScope: 'legacy-login',
  };

  const store = useAuthStore();

  await store.load();

  assert.equal(store.authenticated, true);
  assert.equal(store.clientScope, 'legacy-login');
  assert.equal(store.logConfirmation > 0, true);

  const shell = await readFile(webFile('src/shared/layout/AppShell.vue'), 'utf8');

  assert.match(shell, /studioAuth\.clientScope/u);
  assert.doesNotMatch(shell, /studioAuth\.login/u);
});
