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
  const browser = await installUiBrowser(t, 'http://grigdesk.test/');
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

/**
 * Общий числовой control монтируется отдельно: нейтральность усилия не меняет соседей.
 * Новые опции передаются только сценариям default, обычный слайдер их не получает.
 */
async function mountDiscrete(t, props) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/');
  const [{ mount }, Slider] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/composites/UiDiscreteSlider.vue')),
  ]);
  const wrapper = mount(Slider, {
    attachTo: browser.document.querySelector('#mount'),
    props,
  });

  t.after(() => wrapper.unmount());

  return wrapper;
}

test('SLIDER-B1: обычный числовой слайдер сохраняет выбранную ступень', async (t) => {
  const wrapper = await mountDiscrete(t, {
    modelValue: 2,
    min: 0,
    max: 4,
    ticks: true,
    labels: {
      0: 'Медленно',
      2: 'Обычно',
      4: 'Быстро',
    },
  });

  assert.equal(wrapper.get('.is-active').text(), 'Обычно');
  assert.equal(wrapper.get('input').element.value, '2');
  await wrapper.get('input').setValue(4);

  assert.deepEqual(wrapper.emitted('update:modelValue'), [[4]]);
});

for (const levels of [['off', 'high', 'max'], ['low', 'high'], ['high']]) {
  test(`EFFORT-06: default не выбирает ступень: ${levels.join('/')}`, async (t) => {
    const wrapper = await mountSlider(t, { modelValue: '', levels });

    assert.equal(wrapper.findAll('.is-active').length, 0, 'default не является первой риской');
    assert.equal(wrapper.findComponent({ name: 'UiDiscreteSlider' }).props('unselected'), true);
    assert.equal(wrapper.get('input').attributes('aria-valuetext'), 'Усилие по умолчанию исполнителя');
    assert.equal(wrapper.get('.val').text(), '—');

    await wrapper.setProps({ modelValue: levels[0] });

    assert.equal(wrapper.get('.is-active').text(), levels[0]);
    assert.equal(wrapper.findComponent({ name: 'UiDiscreteSlider' }).props('unselected'), false);
  });
}

for (const pointerType of ['mouse', 'touch']) {
  test(`EFFORT-07: первая ступень доступна из default, pointer=${pointerType}`, async (t) => {
    const wrapper = await mountSlider(t, { modelValue: '', levels: ['off', 'high', 'max'] });
    const range = wrapper.get('input');

    // Range уже физически стоит на min: браузер не обязан послать input при таком тапе.
    await range.trigger('pointerdown', { pointerType });
    await range.trigger('pointerup', { pointerType });

    assert.deepEqual(wrapper.emitted('update:modelValue'), [['off']], 'один тап — один выбор');
  });
}

test('EFFORT-07: Home выбирает первую ступень из default, End последнюю', async (t) => {
  const wrapper = await mountSlider(t, { modelValue: '', levels: ['low', 'high'] });
  const range = wrapper.get('input');

  await range.trigger('keydown', { key: 'Home' });
  await range.trigger('keyup', { key: 'Home' });

  assert.deepEqual(wrapper.emitted('update:modelValue'), [['low']]);
  await wrapper.setProps({ modelValue: 'low' });
  await range.trigger('keydown', { key: 'End' });
  // happy-dom не исполняет native default клавиши End; доставляем её input как браузер.
  await range.setValue(1);
  await range.trigger('keyup', { key: 'End' });

  assert.deepEqual(wrapper.emitted('update:modelValue'), [['low'], ['high']]);
});

for (const option of ['disabled', 'readonly']) {
  test(`EFFORT-07: нейтральный control с ${option} не эмитит выбор`, async (t) => {
    const wrapper = await mountDiscrete(t, {
      modelValue: 0,
      min: 0,
      max: 1,
      labels: { 0: 'low', 1: 'high' },
      unselected: true,
      [option]: true,
    });
    const range = wrapper.get('input');

    await range.trigger('pointerdown', { pointerType: 'touch' });
    await range.trigger('pointerup', { pointerType: 'touch' });
    await range.trigger('keydown', { key: 'Home' });
    await range.trigger('keyup', { key: 'Home' });
    await range.setValue(1);

    assert.equal(wrapper.emitted('update:modelValue'), undefined);
  });
}
