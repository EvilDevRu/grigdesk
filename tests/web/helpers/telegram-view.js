// Общая обвязка для офлайн-тестов раздела «Телеграм» (`views/TelegramView.vue`).
//
// Общий compiler бандлит настоящий UI facade, а здесь подменяются только сеть,
// plugin store и dialog service. Так тесты проходят тот же DOM-контракт, что экран.
import { compileVue, webFile } from './compile-vue.js';

const VIEW_PATH = webFile('src/views/TelegramView.vue');
const HAPPY_DOM = '../../../web/node_modules/happy-dom/lib/index.js';
const TEST_UTILS = '../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs';

/** Ошибка в форме api-client: текст сервера в `message`, тело — в `data`. */
export function apiError(status, data) {
  const err = new Error(data.message || data.error || `HTTP ${status}`);
  err.status = status;
  err.data = data;
  return err;
}

/** Компиляция вью с заглушками вместо импортов. */
export async function compileTelegramView(_prefix = 'telegram') {
  return compileVue(VIEW_PATH, {
    stubs: {
      '../shared/apiClient.ts': 'export const api = globalThis.__tgApi;',
      // Транспорт раздела импортирует клиента соседним путём: заглушка
      // сопоставляется по точной строке, и обе формы нужны одновременно.
      './apiClient.ts': 'export const api = globalThis.__tgApi;',
      '../stores/plugins.js': `
        export const usePluginsStore = (...args) => globalThis.__tgPluginsStore(...args);
      `,
      './services/dialogs': `
        export const confirmDialog = (...args) => globalThis.__tgConfirm(...args);
        export const alertDialog = async () => undefined;
        export const promptDialog = async () => null;
      `,
    },
  });
}

/** Браузерное окружение happy-dom с классами DOM в глобалях (Vue снимает разметку после теста). */
export async function installBrowser(t) {
  const { Window } = await import(HAPPY_DOM);
  const browser = new Window({ url: 'http://grigdesk.test/#/telegram' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
    Node: browser.Node,
    Document: browser.Document,
    DocumentFragment: browser.DocumentFragment,
    ShadowRoot: browser.ShadowRoot,
    Text: browser.Text,
    Comment: browser.Comment,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    HTMLOptionElement: browser.HTMLOptionElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';
  t.after(() => browser.close());
  return browser;
}

// Загрузка раздела — пять запросов ПОДРЯД (статус → чаты → правила →
// ростер → проекты портала), и каждый ждёт предыдущего. Циклов берём с запасом: недокрученный
// хвост доезжает уже после теста, в закрытое окно, и падает мимо всех проверок.
export async function settle(flushPromises, cycles = 10) {
  for (let i = 0; i < cycles; i += 1) await flushPromises();
}

/**
 * Смонтированный раздел.
 *
 * @returns {{browser, wrapper, flushPromises, settle: Function}}
 */
export async function mountTelegramView(t, {
  api,
  pluginEnabled = true,
  confirm = async () => true,
  prefix = 'telegram',
} = {}) {
  const browser = await installBrowser(t);
  globalThis.__tgApi = api;
  globalThis.__tgConfirm = confirm;
  globalThis.__tgPluginsStore = () => ({
    loaded: true,
    enabled: (id) => (id === 'telegram' ? pluginEnabled : true),
    async load() {},
  });
  const [{ mount, flushPromises }, TelegramView] = await Promise.all([
    import(TEST_UTILS),
    compileTelegramView(prefix),
  ]);
  const wrapper = mount(TelegramView, { attachTo: browser.document.querySelector('#mount') });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__tgApi;
    delete globalThis.__tgConfirm;
    delete globalThis.__tgPluginsStore;
  });
  await settle(flushPromises);
  return {
    browser,
    wrapper,
    flushPromises,
    settle: (cycles) => settle(flushPromises, cycles),
  };
}
