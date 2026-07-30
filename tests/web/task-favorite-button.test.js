import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';

const COMPONENT_PATH = fileURLToPath(
  new URL('../../web/src/views/board/TaskFavoriteButton.vue', import.meta.url),
);
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;

let component;
async function loadComponent() {
  if (component) return component;
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const source = await readFile(COMPONENT_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: COMPONENT_PATH });
  assert.deepEqual(errors, []);
  let code = compileScript(descriptor, {
    id: 'data-v-task-favorite-button-test',
    inlineTemplate: true,
  }).content;
  code = code
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`);
  component = (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  )).default;
  return component;
}

async function browserFixture(t) {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://cockpit.test/#/board' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
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
  browser.document.body.innerHTML = '<div id="mount"></div>';
  t.after(() => browser.close());
  return browser;
}

test('UI-01/02: кнопка отражает состояние, подписана и эмитит toggle', async (t) => {
  const browser = await browserFixture(t);
  const [{ mount }, TaskFavoriteButton] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    loadComponent(),
  ]);
  const wrapper = mount(TaskFavoriteButton, {
    attachTo: browser.document.querySelector('#mount'),
    props: { active: false, taskTitle: 'Исправить форму' },
  });
  t.after(() => wrapper.unmount());

  const button = wrapper.get('button');
  assert.equal(button.attributes('aria-pressed'), 'false');
  assert.equal(button.attributes('aria-label'), 'Добавить задачу «Исправить форму» в избранное');
  assert.equal(button.get('svg').attributes('fill'), 'none');

  await button.trigger('click');
  assert.equal(wrapper.emitted('toggle').length, 1);

  await wrapper.setProps({ active: true });
  assert.equal(button.attributes('aria-pressed'), 'true');
  assert.equal(button.attributes('aria-label'), 'Убрать задачу «Исправить форму» из избранного');
  assert.equal(button.get('svg').attributes('fill'), 'currentColor');
  assert.equal(button.classes().includes('active'), false);
  assert.equal(button.classes().includes('is-favorite'), true);
});

test('UI-03: pending блокирует кнопку и сообщает занятость', async (t) => {
  const browser = await browserFixture(t);
  const [{ mount }, TaskFavoriteButton] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    loadComponent(),
  ]);
  const wrapper = mount(TaskFavoriteButton, {
    attachTo: browser.document.querySelector('#mount'),
    props: { active: true, pending: true, taskTitle: 'Задача 42' },
  });
  t.after(() => wrapper.unmount());

  const button = wrapper.get('button');
  assert.equal(button.attributes('disabled'), '');
  assert.equal(button.attributes('aria-busy'), 'true');
  assert.equal(button.get('svg').attributes('width'), '18');
  assert.equal(button.get('svg').attributes('height'), '18');
  assert.ok(button.get('path').attributes('d'), 'звезда остаётся в DOM во время сохранения');
  await button.trigger('click');
  assert.equal(wrapper.emitted('toggle'), undefined);
});

test('UI-04: ожидание ответа не прячет звезду пульсацией', async () => {
  const source = await readFile(COMPONENT_PATH, 'utf8');
  assert.doesNotMatch(source, /fav-pulse|opacity:\s*\.35/);
});

test('UI-05: компонент не использует синюю обводку фокуса', async () => {
  const source = await readFile(COMPONENT_PATH, 'utf8');
  assert.doesNotMatch(source, /box-shadow:[^;]*var\(--accent\)/);
});
