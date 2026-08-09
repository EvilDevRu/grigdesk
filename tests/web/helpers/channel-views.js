// Офлайн-harness для небольших Inbox/GitHub SFC. Общий SSE
// подменяем списком callbacks, чтобы не открывать EventSource в Node.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VIEWS = {
  inbox: fileURLToPath(new URL('../../../web/src/views/InboxView.vue', import.meta.url)),
  github: fileURLToPath(new URL('../../../web/src/views/GitHubView.vue', import.meta.url)),
};
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;
const HAPPY_DOM = '../../../web/node_modules/happy-dom/lib/index.js';
const TEST_UTILS = '../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs';
const COMPILER_SFC = '../../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js';
let nonce = 0;

export function apiError(status, data) {
  const error = new Error(data.message || data.error || `HTTP ${status}`);
  error.status = status;
  error.data = data;
  return error;
}

async function compileView(view) {
  const path = VIEWS[view];
  const { parse, compileScript } = await import(COMPILER_SFC);
  const source = await readFile(path, 'utf8');
  const { descriptor, errors } = parse(source, { filename: path });
  assert.deepEqual(errors, []);
  const code = compileScript(descriptor, {
    id: `data-v-channel-${view}-${nonce}`,
    inlineTemplate: true,
  }).content
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`)
    .replace("import { api } from '../shared/api-client.js';", 'const api = globalThis.__channelApi;')
    .replace(
      "import { confirmDialog } from '../shared/ui/confirm.js';",
      'const confirmDialog = (...args) => globalThis.__channelConfirm(...args);',
    )
    .replace(
      "import { useSse } from '../composables/useSse.js';",
      'const useSse = (fn) => { globalThis.__channelSse.push(fn); return { connected: { value: true } }; };',
    );
  const own = nonce++;
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${own}`)).default;
}

async function installBrowser(t, view) {
  const { Window } = await import(HAPPY_DOM);
  const browser = new Window({ url: `http://cockpit.test/#/${view}` });
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

export async function mountChannelView(t, view, {
  api,
  confirm = async () => true,
} = {}) {
  const browser = await installBrowser(t, view);
  globalThis.__channelApi = api;
  globalThis.__channelConfirm = confirm;
  globalThis.__channelSse = [];
  const [{ mount, flushPromises }, component] = await Promise.all([
    import(TEST_UTILS),
    compileView(view),
  ]);
  const wrapper = mount(component, { attachTo: browser.document.querySelector('#mount') });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__channelApi;
    delete globalThis.__channelConfirm;
    delete globalThis.__channelSse;
  });
  await settle(flushPromises);
  return {
    browser,
    wrapper,
    flushPromises,
    settle: (cycles) => settle(flushPromises, cycles),
    emitSse: (name, data) => {
      for (const listener of globalThis.__channelSse) listener(name, data);
    },
  };
}
