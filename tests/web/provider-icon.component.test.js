// Иконки исполнителей (ProviderIcon.vue). Смысл проверки: у известного исполнителя
// должен рисоваться ЗНАК, а не кружок с буквой. Фоллбэк молчаливый — новый исполнитель
// без своей ветки выглядит «почти нормально» (буква в кружке), и пропажу знака замечают
// не сразу: Ollama так и жила с буквой «O», пока о ней не спросили отдельно.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';

const ICON_PATH = fileURLToPath(new URL('../../web/src/shared/ProviderIcon.vue', import.meta.url));
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;

// Знак = свой рисунок, а не буква. Названия нарочно не совпадают с первой буквой id,
// чтобы фоллбэк нельзя было спутать со знаком.
const MARKED = [
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'GPT' },
  { id: 'kimi', name: 'Kimi' },
  { id: 'ollama', name: 'Ollama' },
];

async function compileIcon() {
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const source = await readFile(ICON_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: ICON_PATH });
  assert.deepEqual(errors, []);
  const code = compileScript(descriptor, { id: 'data-v-icon-test', inlineTemplate: true }).content
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`);
  return (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
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
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
    Document: browser.Document,
    ShadowRoot: browser.ShadowRoot,
    Event: browser.Event,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';
  shared = browser;
  return browser;
}

async function mountIcon(t, provider, size = 16) {
  const browser = await browserHarness();
  const [{ mount }, ProviderIcon] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileIcon(),
  ]);
  const wrapper = mount(ProviderIcon, {
    attachTo: browser.document.querySelector('#mount'),
    props: { provider, size },
  });
  t.after(() => wrapper.unmount());
  return wrapper;
}

test('у каждого известного исполнителя свой знак, а не буква в кружке', async (t) => {
  for (const provider of MARKED) {
    const wrapper = await mountIcon(t, provider);
    const svg = wrapper.find('svg');
    assert.ok(svg.exists(), `${provider.id}: ожидался svg-знак`);
    assert.equal(wrapper.find('.fb').exists(), false, `${provider.id}: показан фоллбэк-кружок`);
    // Пустой svg тоже «существует» — знак обязан иметь геометрию.
    const shapes = svg.element.querySelectorAll('path, circle, ellipse, polygon');
    assert.ok(shapes.length > 0, `${provider.id}: знак без фигур`);
    assert.equal(svg.attributes('width'), '16');
    assert.equal(svg.attributes('height'), '16');
    assert.ok(svg.attributes('viewBox'), `${provider.id}: без viewBox знак не масштабируется`);
  }
});

test('незнакомому исполнителю остаётся кружок с первой буквой имени', async (t) => {
  const wrapper = await mountIcon(t, { id: 'brand-new', name: 'мистраль' }, 20);
  assert.equal(wrapper.find('svg').exists(), false);
  const fb = wrapper.find('.fb');
  assert.ok(fb.exists());
  assert.equal(fb.text(), 'М');
  assert.match(fb.attributes('style'), /width:\s*20px/);
});

test('знак Ollama обведён линией — на тёмной теме заливка выглядела бы кляксой', async (t) => {
  const wrapper = await mountIcon(t, { id: 'ollama', name: 'Ollama' });
  const svg = wrapper.find('svg');
  assert.equal(svg.attributes('stroke'), 'currentColor');
  assert.equal(svg.attributes('fill'), 'none');
  // Глаза — единственное, что залито: точками они читаются и на 15px.
  const dots = svg.element.querySelectorAll('circle[fill="currentColor"]');
  assert.equal(dots.length, 2);
});
