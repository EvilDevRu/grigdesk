// Карточка разрешения (ChatPermission.vue): «Доработать»/«Отклонить» открывает модалку
// с пояснением (promptDialog из shared/ui/confirm.js — настоящую, в happy-dom), текст
// уезжает третьим аргументом события answer. Esc/отмена модалки — отказа нет.
// «Утвердить» по-прежнему отвечает сразу, без модалки.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';

const PERMISSION_PATH = fileURLToPath(
  new URL('../../web/src/views/chat/ChatPermission.vue', import.meta.url),
);
const CONFIRM_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/src/shared/ui/confirm.js', import.meta.url),
)).href;
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;

async function compilePermission() {
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const source = await readFile(PERMISSION_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: PERMISSION_PATH });
  assert.deepEqual(errors, []);
  const code = compileScript(descriptor, { id: 'data-v-perm-test', inlineTemplate: true }).content
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`)
    // data:-URL не резолвит относительные пути; confirm.js без зависимостей — по file URL.
    .replace("from '../../shared/ui/confirm.js'", `from "${CONFIRM_URL}"`);
  return (await import(
    `data:text/javascript;base64,${Buffer.from(`${code}\n// perm ${Date.now()}`).toString('base64')}`
  )).default;
}

let shared = null;

async function browserHarness() {
  if (shared) {
    shared.document.body.innerHTML = '<div id="mount"></div>';
    return shared;
  }
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://cockpit.test/#/chats' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
    Document: browser.Document,
    ShadowRoot: browser.ShadowRoot,
    Event: browser.Event,
    KeyboardEvent: browser.KeyboardEvent,
    CustomEvent: browser.CustomEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';
  shared = browser;
  return browser;
}

const PLAN_REQ = {
  pid: 'p1', chatKey: 'c1',
  tool: 'ExitPlanMode',
  input: { plan: 'Шаг 1. Сделать' },
};

async function mountPermission(t, req = PLAN_REQ) {
  const browser = await browserHarness();
  const [{ mount, flushPromises }, ChatPermission] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compilePermission(),
  ]);
  const wrapper = mount(ChatPermission, {
    attachTo: browser.document.querySelector('#mount'),
    props: { req },
  });
  t.after(() => wrapper.unmount());
  await flushPromises();
  return { browser, wrapper, flushPromises };
}

test('«Доработать» открывает модалку, пояснение уезжает третьим аргументом answer', async (t) => {
  const { browser, wrapper, flushPromises } = await mountPermission(t);
  await wrapper.find('.p-no').trigger('click');
  await flushPromises();
  const ta = browser.document.querySelector('.cfm-overlay .cfm-ta');
  assert.ok(ta, 'модалка с полем пояснения открылась');
  ta.value = 'убери лишний шаг';
  browser.document.querySelector('.cfm-overlay .cfm-ok').click();
  await flushPromises();
  assert.deepEqual(wrapper.emitted('answer'), [[false, false, 'убери лишний шаг']]);
  assert.equal(browser.document.querySelector('.cfm-overlay'), null, 'модалка закрылась');
});

test('Esc в модалке — отказа нет, карточка остаётся висеть', async (t) => {
  const { browser, wrapper, flushPromises } = await mountPermission(t);
  await wrapper.find('.p-no').trigger('click');
  await flushPromises();
  assert.ok(browser.document.querySelector('.cfm-overlay'));
  browser.document.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape' }));
  await flushPromises();
  assert.equal(wrapper.emitted('answer'), undefined);
  assert.equal(browser.document.querySelector('.cfm-overlay'), null, 'модалка закрылась');
});

test('«Утвердить» отвечает сразу, без модалки', async (t) => {
  const { browser, wrapper } = await mountPermission(t);
  await wrapper.find('.p-ok').trigger('click');
  assert.deepEqual(wrapper.emitted('answer'), [[true, false]]);
  assert.equal(browser.document.querySelector('.cfm-overlay'), null);
});
