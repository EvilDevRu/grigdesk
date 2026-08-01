import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';

// Всплывашка исполнителя в топбаре живёт кликом, а не ховером: на планшете ховера нет.
// Здесь проверяем сам механизм закрепления в HelpTip (проп toggle).
const HELP_TIP_PATH = fileURLToPath(
  new URL('../../web/src/shared/ui/HelpTip.vue', import.meta.url),
);
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;

async function compileHelpTip() {
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const source = await readFile(HELP_TIP_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: HELP_TIP_PATH });
  assert.deepEqual(errors, []);
  const code = compileScript(descriptor, { id: 'data-v-help-tip-toggle', inlineTemplate: true }).content
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`);
  return (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  )).default;
}

async function browserHarness(t) {
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
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div><button id="outside">мимо</button>';
  t.after(() => browser.close());
  return browser;
}

async function mountTip(t, browser, slots) {
  const [{ h }, { mount }, HelpTip] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileHelpTip(),
  ]);
  const wrapper = mount(HelpTip, {
    attachTo: browser.document.querySelector('#mount'),
    props: { toggle: true },
    slots: slots ?? { default: () => h('span', { class: 'prov' }, 'AI') },
  });
  t.after(() => wrapper.unmount());
  return { wrapper, h };
}

test('HelpTip с toggle: клик закрепляет подсказку, уход мыши её не гасит, повторный клик закрывает', async (t) => {
  const browser = await browserHarness(t);
  const { wrapper } = await mountTip(t, browser);

  await wrapper.find('.ht-tr').trigger('click');
  assert.equal(wrapper.find('.ht').classes().includes('on'), true);

  // Ховер ушёл — закреплённая всплывашка остаётся: на планшете «увести мышь» нечем,
  // но синтетический mouseleave прилетает при скролле, и он не должен её закрывать.
  await wrapper.find('.ht').trigger('mouseleave');
  assert.equal(wrapper.find('.ht').classes().includes('on'), true);

  await wrapper.find('.ht-tr').trigger('click');
  assert.equal(wrapper.find('.ht').classes().includes('on'), false);
});

test('HelpTip с toggle: клик мимо и Esc закрывают закреплённую подсказку', async (t) => {
  const browser = await browserHarness(t);
  const { wrapper } = await mountTip(t, browser);

  await wrapper.find('.ht-tr').trigger('click');
  browser.document.querySelector('#outside')
    .dispatchEvent(new browser.Event('pointerdown', { bubbles: true }));
  await wrapper.vm.$nextTick();
  assert.equal(wrapper.find('.ht').classes().includes('on'), false);

  await wrapper.find('.ht-tr').trigger('click');
  assert.equal(wrapper.find('.ht').classes().includes('on'), true);
  await wrapper.find('.ht').trigger('keydown', { key: 'Escape' });
  assert.equal(wrapper.find('.ht').classes().includes('on'), false);
});

test('HelpTip с toggle: кнопка внутри подсказки закрывает её (действие уводит со страницы)', async (t) => {
  const browser = await browserHarness(t);
  const [{ h }] = await Promise.all([import('../../web/node_modules/vue/index.mjs')]);
  const { wrapper } = await mountTip(t, browser, {
    default: () => h('span', { class: 'prov' }, 'AI'),
    tip: () => h('button', { class: 'go' }, 'Настройки исполнителей'),
  });

  await wrapper.find('.ht-tr').trigger('click');
  assert.equal(wrapper.find('.ht').classes().includes('on'), true);
  await wrapper.find('.ht-tip .go').trigger('click');
  assert.equal(wrapper.find('.ht').classes().includes('on'), false);
});
