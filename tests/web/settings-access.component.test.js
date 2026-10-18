// Вкладка «Доступ» объясняет вход по локальному ключу и не предлагает пароль или выход.
// Подменяются сеть и stores, а карточки и мобильный раздел остаются настоящими.
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileSettingsView } from './helpers/settings-view.js';

process.env.NODE_ENV = 'test';

/**
 * Компонент получает отдельное браузерное окно с тестовыми константами сборки.
 * Сеть и настройки машины остаются за подменяемыми границами.
 */
async function installBrowser(t) {
  // Vite объявляет эти константы через define; node-компиляции нужен тот же контракт.
  globalThis.__GRIGDESK_VERSION__ = '0.0.0-test';
  globalThis.__GRIGDESK_SHA__ = 'testsha';
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://localhost:28140/' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
    Node: browser.Node,
    Document: browser.Document,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    ShadowRoot: browser.ShadowRoot,
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

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Настройки монтируются с управляемыми запросами и ответами подтверждения.
 * Журнал запросов доказывает загрузку вкладки без обращения к живому API.
 */
async function mountSettingsAccess(t, { confirmAnswers = [] } = {}) {
  const browser = await installBrowser(t);

  browser.localStorage.setItem('grigdesk-settings-tab', 'access');

  const gets = [];
  const posts = [];
  const confirmations = [];
  const providersStore = {
    providers: [],
    usage: {},
    mcp: {},
    loaded: true,
    showAllModels: false,
    visibleModels: () => [],
    async load() {},
    async loadUsage() {},
    async saveSetting() {},
    async loadMcp() {},
    async runUsageAction() {},
  };

  globalThis.__accessSettingsApi = {
    async get(path) {
      gets.push(path);

      return path === '/api/settings/prefs' ? { runSilenceWindow: 600 } : {};
    },
    async post(path, body) {
      posts.push({ path, body: copy(body) });

      return {};
    },
    async del() {
      return {};
    },
  };
  globalThis.__accessSettingsConfirm = async (message, options) => {
    confirmations.push({ message, options: copy(options) });

    return confirmAnswers.length ? confirmAnswers.shift() : true;
  };
  globalThis.__accessSettingsStores = {
    useProvidersStore: () => providersStore,
    useUiContextStore: () => ({ set() {}, clear() {} }),
    useAuthStore: () => ({
      clientScope: 'me',
      authenticated: true,
      async load() {},
    }),
    usePluginsStore: () => ({
      loaded: true,
      list: [],
      enabled: () => true,
      async load() {},
      async setEnabled() {},
    }),
    useChatStore: () => ({ compactWindow: 0 }),
    useDeviceStore: () => ({
      canInstall: false,
      wakeLock: false,
      async install() {},
      async checkForUpdate() {},
    }),
    useGrigDeskUpdateStore: () => ({ state: null, status: null, async load() {} }),
  };

  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const SettingsView = await compileSettingsView({
    prefix: '__accessSettings',
    confirm: true,
    mobileAccess: true,
  });
  const wrapper = mount(SettingsView, {
    attachTo: browser.document.querySelector('#mount'),
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__accessSettingsApi;
    delete globalThis.__accessSettingsConfirm;
    delete globalThis.__accessSettingsStores;
  });

  for (let i = 0; i < 5; i += 1) {
    await flushPromises();
  }

  return {
    wrapper,
    gets,
    posts,
    confirmations,
    flushPromises,
  };
}

test('LO-10: доступ объясняет вход по ключу и сохраняет мобильный раздел', async (t) => {
  const { wrapper, gets, posts, flushPromises } = await mountSettingsAccess(t);
  /**
   * Проверяет вкладку после открытия и повторного перехода из приложения.
   * Мобильный раздел настоящий, парольных полей и действий выхода нет.
   */
  const checkAccess = () => {
    assert.equal(wrapper.find('.access-account').exists(), true);
    assert.match(wrapper.text(), /вход по локальному ключу/u);
    assert.equal(wrapper.find('#mobile-access-title').exists(), true);

    // Формы пароля, смены пароля и кнопок выхода в новом интерфейсе нет.
    assert.equal(wrapper.findAll('.access-account input[type="password"]').length, 0);
    assert.equal(wrapper.findAll('.access-account input').length, 0);

    for (const removed of ['Сменить пароль', 'Выйти со всех устройств', 'Текущий пароль']) {
      assert.equal(wrapper.text().includes(removed), false, removed);
    }

    for (const removed of ['Пути подключения', 'Локальный HTTPS', 'VPS-шлюз', 'Сертификат и устройства']) {
      assert.equal(wrapper.text().includes(removed), false);
    }
  };

  assert.ok(gets.includes('/api/settings/prefs'), 'компонент действительно загрузил настройки');
  checkAccess();

  const appTab = wrapper.findAll('.settings-nav button')
    .find((button) => button.text().includes('Приложение'));

  assert.ok(Boolean(appTab));
  await appTab.trigger('click');
  await flushPromises();
  assert.equal(wrapper.find('.access-account').exists(), false);

  const accessTab = wrapper.findAll('.settings-nav button')
    .find((button) => button.text().includes('Доступ'));

  assert.ok(Boolean(accessTab));
  await accessTab.trigger('click');
  await flushPromises();
  checkAccess();

  const requests = [...gets, ...posts.map((call) => call.path)];

  assert.equal(requests.some((path) => /^\/api\/(?:settings\/tls|gateway)\b/u.test(path)), false);
  assert.equal(requests.some((path) => path.startsWith('/api/auth/')), false);
});

test('ACCESS-WEB-18: во вкладке «Доступ» нет выхода и смены пароля', async (t) => {
  const { wrapper, posts, confirmations, flushPromises } = await mountSettingsAccess(t);

  await flushPromises();
  assert.deepEqual(confirmations, []);
  assert.equal(posts.some((call) => call.path.startsWith('/api/auth/')), false);
  assert.equal(wrapper.findAll('button')
    .some((button) => ['Выйти', 'Выйти со всех устройств', 'Сменить пароль']
      .includes(button.text())), false);
});
