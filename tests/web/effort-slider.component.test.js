// Слайдер усилия: режим «только показываю». Он появился ради компаньона, у которого
// уровнем владеет настройка, а не разговор, — но значение обязано остаться видимым:
// человек вправе знать, чем уйдёт ход, даже когда меняет его в другом месте.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';

const VIEW_PATH = fileURLToPath(new URL('../../web/src/views/chat/EffortSlider.vue', import.meta.url));
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;
let compileNonce = 0;

async function compileSlider() {
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const source = await readFile(VIEW_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: VIEW_PATH });
  assert.deepEqual(errors, []);
  const code = compileScript(descriptor, {
    id: `data-v-effort-slider-${compileNonce}`,
    inlineTemplate: true,
  }).content
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`);
  const nonce = compileNonce++;
  return (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${nonce}`
  )).default;
}

async function mountSlider(t, props) {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://cockpit.test/' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';
  const [{ mount }, EffortSlider] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileSlider(),
  ]);
  const wrapper = mount(EffortSlider, {
    attachTo: browser.document.querySelector('#mount'),
    props,
  });
  t.after(() => { wrapper.unmount(); browser.close(); });
  return wrapper;
}

const LEVELS = ['low', 'medium', 'high'];

test('EFFORT-01: обычный слайдер меняет уровень кликом по точке и по треку', async (t) => {
  const wrapper = await mountSlider(t, { modelValue: 'low', levels: LEVELS });
  await wrapper.findAll('.node')[2].trigger('click');
  assert.deepEqual(wrapper.emitted('update:modelValue'), [['high']]);
});

test('EFFORT-02: неактивный слайдер молчит, но значение остаётся читаемым', async (t) => {
  const wrapper = await mountSlider(t, { modelValue: 'high', levels: LEVELS, disabled: true });
  await wrapper.findAll('.node')[0].trigger('click');
  await wrapper.find('.track').trigger('click');
  assert.equal(wrapper.emitted('update:modelValue'), undefined, 'выбор ушёл бы в чужого владельца');
  // Не прячем и не гасим до нечитаемости: это индикатор, а не выключенная форма.
  assert.equal(wrapper.find('.val').text(), 'high');
  assert.ok(wrapper.classes().includes('off'));
  wrapper.findAll('.node').forEach((node) => {
    assert.ok(node.attributes('disabled') !== undefined, 'точки должны быть выключены и для клавиатуры');
  });
});

test('EFFORT-03: подсказка объясняет, где менять уровень, вместо обычного title', async (t) => {
  const hint = 'Модель и усилие компаньона задаются в «Настройки → Приложение».';
  const wrapper = await mountSlider(t, { modelValue: 'high', levels: LEVELS, disabled: true, hint });
  assert.equal(wrapper.attributes('title'), hint);

  const plain = await mountSlider(t, { modelValue: 'high', levels: LEVELS });
  assert.match(plain.attributes('title'), /Усилие рассуждения: high/);
});
