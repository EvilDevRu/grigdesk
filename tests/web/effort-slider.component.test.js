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

  assert.equal(wrapper.findAll('.ui-discrete-slider__points > span').length, LEVELS.length);
  assert.equal(wrapper.get('input[type="range"]').attributes('aria-valuetext'), 'low');
  assert.equal(wrapper.get('input[type="range"]').attributes('aria-label'), 'Усилие рассуждения');
  await wrapper.get('input[type="range"]').setValue(2);
  assert.deepEqual(wrapper.emitted('update:modelValue'), [['high']]);

  await wrapper.setProps({ modelValue: 'high', levels: ['minimal', 'low', 'medium', 'high', 'max'] });
  assert.equal(wrapper.findAll('.ui-discrete-slider__points > span').length, 5);
  assert.equal(wrapper.get('input[type="range"]').attributes('max'), '4');
  assert.equal(wrapper.get('input[type="range"]').attributes('aria-valuetext'), 'high');
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

  assert.equal(wrapper.attributes('data-ui-tooltip'), hint);

  const plain = await mountSlider(t, { modelValue: 'high', levels: LEVELS });

  assert.match(plain.attributes('data-ui-tooltip'), /Усилие рассуждения: high/);
});

test('EFFORT-04: справка сравнивает доступные уровни, клавиатура получает смысл выбранного', async (t) => {
  const hints = {
    high: 'Глубокое рассуждение.',
    max: 'Максимальная глубина.',
    ultra: 'Максимальное рассуждение с делегированием.',
  };
  const wrapper = await mountSlider(t, {
    modelValue: 'max',
    levels: ['high', 'max', 'ultra'],
    hints,
  });

  assert.equal(wrapper.attributes('data-ui-tooltip'), [
    'Усилие рассуждения: max',
    'high — Глубокое рассуждение.',
    'max — Максимальная глубина.',
    'ultra — Максимальное рассуждение с делегированием.',
  ].join('\n'));
  assert.equal(wrapper.get('input').attributes('aria-valuetext'), 'max — Максимальная глубина.');

  await wrapper.setProps({
    modelValue: 'high',
    levels: ['off', 'high'],
    hints: { off: 'Рассуждение выключено.', high: 'Анализ сложных задач.' },
  });

  const tooltip = wrapper.attributes('data-ui-tooltip');

  assert.match(tooltip, /high — Анализ сложных задач/);
  assert.doesNotMatch(tooltip, /ultra|делегированием|max/);
  assert.equal(wrapper.get('input').attributes('aria-valuetext'), 'high — Анализ сложных задач.');
});

test('EFFORT-05: новая ступень остаётся выбираемой, умолчание не выдаётся за первую риску', async (t) => {
  const wrapper = await mountSlider(t, { modelValue: '', levels: ['low', 'future'] });

  assert.equal(wrapper.get('input').attributes('aria-valuetext'), 'Усилие по умолчанию исполнителя');
  assert.match(wrapper.attributes('data-ui-tooltip'), /future — Описание этого уровня пока недоступно/);

  await wrapper.get('input').setValue(1);

  assert.deepEqual(wrapper.emitted('update:modelValue'), [['future']]);
});
