// Общая обвязка для офлайн-тестов раздела «Телеграм» (`views/TelegramView.vue`).
//
// Компонент компилируется в память и грузится как `data:`-модуль, а такой модуль
// НЕ УМЕЕТ резолвить относительные импорты: любой `import ... from '../…'` внутри
// вью падает `ERR_UNSUPPORTED_RESOLVE_REQUEST` и роняет все тесты файла разом.
// Поэтому каждый импорт заменяется заглушкой прямо в исходнике — и делать это
// нужно в ОДНОМ месте: пока замены жили копиями в трёх тестах, добавленный во вью
// импорт ломал три файла сразу, и чинить приходилось каждый.
//
// Второй известный подвох — кэш модулей: Node ключует `data:`-URL целиком, а две
// компиляции одного SFC дают побайтово равный текст (scopeId в вывод не попадает).
// Без хвоста-nonce второй mount получил бы модуль первого вместе с его сторами.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VIEW_PATH = fileURLToPath(new URL('../../../web/src/views/TelegramView.vue', import.meta.url));
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;
const HAPPY_DOM = '../../../web/node_modules/happy-dom/lib/index.js';
const TEST_UTILS = '../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs';
const COMPILER_SFC = '../../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js';

let compileNonce = 0;

/** Ошибка в форме api-client: текст сервера в `message`, тело — в `data`. */
export function apiError(status, data) {
  const err = new Error(data.message || data.error || `HTTP ${status}`);
  err.status = status;
  err.data = data;
  return err;
}

/** Компиляция вью с заглушками вместо импортов. */
export async function compileTelegramView(prefix = 'telegram') {
  const { parse, compileScript } = await import(COMPILER_SFC);
  const source = await readFile(VIEW_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: VIEW_PATH });
  assert.deepEqual(errors, []);
  const code = compileScript(descriptor, {
    id: `data-v-${prefix}-${compileNonce}`,
    inlineTemplate: true,
  }).content
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`)
    .replace("import { api } from '../shared/api-client.js';", 'const api = globalThis.__tgApi;')
    .replace(
      "import { confirmDialog } from '../shared/ui/confirm.js';",
      'const confirmDialog = (...args) => globalThis.__tgConfirm(...args);',
    )
    .replace(
      "import { usePluginsStore } from '../stores/plugins.js';",
      'const usePluginsStore = globalThis.__tgPluginsStore;',
    );
  const nonce = compileNonce++;
  return (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${nonce}`
  )).default;
}

/** Браузерное окружение happy-dom с классами DOM в глобалях (Vue снимает разметку после теста). */
export async function installBrowser(t) {
  const { Window } = await import(HAPPY_DOM);
  const browser = new Window({ url: 'http://cockpit.test/#/telegram' });
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
