// Иконки исполнителей (ProviderIcon.vue). Смысл проверки: у известного исполнителя
// должен рисоваться ЗНАК, а не кружок с буквой. Фоллбэк молчаливый — новый исполнитель
// без своей ветки выглядит «почти нормально» (буква в кружке), и пропажу знака замечают
// не сразу: такая проверка сохраняет знак при добавлении и переносе адаптеров.
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
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'glm', name: 'GLM (Z.ai)' },
  { id: 'tripo', name: 'Tripo' },
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
  const browser = new Window({ url: 'http://grigdesk.test/#/chats' });
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

test('знак glm есть в MARKED и рисуется в 12, 15, 19 и 20 px', async (t) => {
  assert.ok(MARKED.some((provider) => provider.id === 'glm'));

  for (const size of [12, 15, 19, 20]) {
    const wrapper = await mountIcon(t, { id: 'glm', name: 'GLM (Z.ai)' }, size);
    const svg = wrapper.find('svg');

    assert.ok(svg.exists(), `${size}: ожидался svg-знак`);
    assert.equal(wrapper.find('.fb').exists(), false, `${size}: показан фоллбэк-кружок`);
    assert.equal(svg.attributes('width'), String(size));
    assert.equal(svg.attributes('height'), String(size));
    assert.ok(svg.element.querySelectorAll('path, circle, polygon').length > 0);
  }
});

// Официальный знак Z.ai (набор LobeHub, MIT) — заливка, а не нарисованная штрихом буква.
const ZAI_MARK = 'M12.105 2L9.927 4.953H.653L2.83 2h9.276zM23.254 19.048L21.078 22h-9.242l2.174-2.952h9.244z'
  + 'M24 2L9.264 22H0L14.736 2H24z';

test('знак glm — официальный знак Z.ai с заливкой цветом текста', async (t) => {
  const wrapper = await mountIcon(t, { id: 'glm', name: 'GLM (Z.ai)' });
  const svg = wrapper.find('svg');

  assert.equal(svg.attributes('fill'), 'currentColor');
  assert.equal(svg.attributes('stroke'), undefined);
  assert.equal(svg.find('path').attributes('d'), ZAI_MARK);
});

test('Tripo рисует оба контура оригинала, цвет текста и скрыт от accessibility tree', async (t) => {
  const wrapper = await mountIcon(t, { id: 'tripo', name: 'Tripo' }, 15);
  const svg = wrapper.get('svg');

  assert.equal(svg.attributes('fill'), 'currentColor');
  assert.equal(svg.attributes('aria-hidden'), 'true');
  assert.equal(svg.findAll('path').length, 2);

  const notice = await readFile(new URL('../../web/public/third-party-notices.txt', import.meta.url), 'utf8');

  assert.match(notice, /packages\/static-svg\/icons\/tripo.svg/);
  assert.match(notice, /c385b2b8d1f9e19aa86e628d4e23c91ee1111a47/);
  assert.match(notice, /Copyright \(c\) 2023 LobeHub/);
  assert.match(notice, /THE SOFTWARE IS PROVIDED "AS IS"/);
});
