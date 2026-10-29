// Офлайн-harness для небольших Inbox/GitHub SFC. Общий SSE
// подменяем списком callbacks, чтобы не открывать EventSource в Node.
import { compileVue, webFile } from './compile-vue.js';

const VIEWS = {
  inbox: webFile('src/views/InboxView.vue'),
  github: webFile('src/views/GitHubView.vue'),
};
const HAPPY_DOM = '../../../web/node_modules/happy-dom/lib/index.js';
const TEST_UTILS = '../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs';

const API_STUB = `
  export const api = {
    get: (...args) => globalThis.__channelApi.get(...args),
    post: (...args) => globalThis.__channelApi.post(...args),
    put: (...args) => globalThis.__channelApi.put(...args),
  };
`;
const DIALOGS_STUB = `
  export const confirmDialog = (...args) => globalThis.__channelConfirm(...args);
  export const promptDialog = (...args) => globalThis.__channelPrompt(...args);
  export const alertDialog = () => Promise.resolve();
`;
const SSE_STUB = `
  export const useSse = (listener) => {
    globalThis.__channelSse.push(listener);
    return { connected: { value: true } };
  };
`;
const componentPromises = new Map();

export function apiError(status, data) {
  const error = new Error(data.message || data.error || `HTTP ${status}`);
  error.status = status;
  error.data = data;
  return error;
}

async function compileView(view, expose = []) {
  const key = `${view}:${expose.join(',')}`;

  if (!componentPromises.has(key)) {
    componentPromises.set(key, compileVue(VIEWS[view], {
      expose,
      stubs: {
        '../shared/apiClient.ts': API_STUB,
        '../shared/settingsNavigation.ts': `
          export const openSettings = (request) => globalThis.__channelSettingsRequests.push(request);
        `,
        '../stores/plugins.ts': `
          export const usePluginsStore = () => ({
            loaded: true,
            list: [{ id: 'synthetic-inbox', nav: { path: '/inbox' } }],
          });
        `,
        // Транспорт раздела импортирует клиента соседним путём: заглушка
        // сопоставляется по точной строке, и обе формы нужны одновременно.
        './apiClient.ts': API_STUB,
        '../composables/useSse.ts': SSE_STUB,
        './services/dialogs': DIALOGS_STUB,
      },
    }));
  }

  return componentPromises.get(key);
}

async function installBrowser(t, view) {
  const { Window } = await import(HAPPY_DOM);
  const browser = new Window({ url: `http://grigdesk.test/#/${view}` });
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

export async function settle(flushPromises, cycles = 8) {
  for (let i = 0; i < cycles; i += 1) await flushPromises();
}

/**
 * Монтирует настоящий экран с синтетическими API и контролируемыми диалогами.
 * Дополнительный expose открывает тесту действие, не меняя его реализацию и шаблон.
 */
export async function mountChannelView(t, view, {
  api,
  expose = [],
  confirm = async () => true,
  // По умолчанию — отмена: тест, который не ждал модалку с полем, не должен
  // случайно «ответить» за человека и создать задачу.
  prompt = async () => null,
} = {}) {
  const browser = await installBrowser(t, view);
  globalThis.__channelApi = api;
  globalThis.__channelConfirm = confirm;
  globalThis.__channelPrompt = prompt;
  globalThis.__channelSse = [];
  globalThis.__channelSettingsRequests = [];

  const [{ mount, flushPromises }, component] = await Promise.all([
    import(TEST_UTILS),
    compileView(view, expose),
  ]);
  const wrapper = mount(component, { attachTo: browser.document.querySelector('#mount') });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__channelApi;
    delete globalThis.__channelConfirm;
    delete globalThis.__channelPrompt;
    delete globalThis.__channelSse;
    delete globalThis.__channelSettingsRequests;
  });
  await settle(flushPromises);

  return {
    browser,
    settingsRequests: globalThis.__channelSettingsRequests,
    wrapper,
    flushPromises,
    settle: (cycles) => settle(flushPromises, cycles),
    emitSse: (name, data) => {
      for (const listener of globalThis.__channelSse) listener(name, data);
    },
  };
}
