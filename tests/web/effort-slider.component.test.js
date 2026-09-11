// Слайдер усилия: режим «только показываю» для поверхностей, где уровнем владеет не сам
// разговор, — значение обязано остаться видимым: человек вправе знать, чем уйдёт ход,
// даже когда меняет его в другом месте.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

const VIEW_PATH = webFile('src/views/chat/EffortSlider.vue');
let componentPromise;

async function compileSlider() {
  componentPromise ||= compileVue(VIEW_PATH);

  return componentPromise;
}

async function mountSlider(t, props) {
  const browser = await installUiBrowser(t, 'http://cockpit.test/');
  const [{ mount }, EffortSlider] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileSlider(),
  ]);
  const wrapper = mount(EffortSlider, {
    attachTo: browser.document.querySelector('#mount'),
    props,
  });
  t.after(() => wrapper.unmount());
  return wrapper;
}

const LEVELS = ['low', 'medium', 'high'];

test('EFFORT-01: обычный слайдер меняет уровень кликом по точке и по треку', async (t) => {
  const wrapper = await mountSlider(t, { modelValue: 'low', levels: LEVELS });
  await wrapper.get('input[type="range"]').setValue(2);
  assert.deepEqual(wrapper.emitted('update:modelValue'), [['high']]);
});

test('EFFORT-02: неактивный слайдер молчит, но значение остаётся читаемым', async (t) => {
  const wrapper = await mountSlider(t, { modelValue: 'high', levels: LEVELS, disabled: true });
  const range = wrapper.get('input[type="range"]');

  await range.setValue(0);
  assert.equal(wrapper.emitted('update:modelValue'), undefined, 'выбор ушёл бы в чужого владельца');
  // Не прячем и не гасим до нечитаемости: это индикатор, а не выключенная форма.
  assert.equal(wrapper.find('.val').text(), 'high');
  assert.ok(wrapper.classes().includes('off'));
  assert.ok(range.attributes('disabled') !== undefined, 'range должен быть выключен и для клавиатуры');
});

test('EFFORT-03: подсказка объясняет, где менять уровень, вместо обычного title', async (t) => {
  const hint = 'Модель и усилие задаются в «Настройки → Приложение».';
  const wrapper = await mountSlider(t, { modelValue: 'high', levels: LEVELS, disabled: true, hint });
  assert.equal(wrapper.attributes('title'), hint);

  const plain = await mountSlider(t, { modelValue: 'high', levels: LEVELS });
  assert.match(plain.attributes('title'), /Усилие рассуждения: high/);
});
