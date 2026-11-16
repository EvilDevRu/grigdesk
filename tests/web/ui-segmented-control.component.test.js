import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

test('UiSegmentedControl меняет размер без потери выбора и блокировки вариантов', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, Component] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/composites/UiSegmentedControl.vue')),
  ]);
  const selected = [];
  const wrapper = mount(Component, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      modelValue: 'catalog',
      options: [
        { value: 'catalog', label: 'Каталог' },
        { value: 'path', label: 'Путь' },
        {
          value: 'unavailable',
          label: 'Недоступно',
          disabled: true,
        },
      ],
      'onUpdate:modelValue': (value) => selected.push(value),
    },
  });

  t.after(() => wrapper.unmount());

  assert.equal(wrapper.attributes('data-size'), 'default');
  await wrapper.setProps({ size: 'compact' });
  assert.equal(wrapper.attributes('data-size'), 'compact');
  assert.equal(wrapper.get('[data-option-value="path"]').attributes('data-size'), 'compact');
  assert.equal(wrapper.get('[data-option-value="catalog"]').attributes('aria-pressed'), 'true');

  await wrapper.get('[data-option-value="path"]').trigger('click');
  assert.deepEqual(selected, ['path']);
  await wrapper.setProps({ modelValue: 'path', disabled: true });
  await wrapper.get('[data-option-value="catalog"]').trigger('click');
  assert.deepEqual(selected, ['path']);

  await wrapper.setProps({ disabled: false, size: 'huge' });
  assert.equal(wrapper.attributes('data-size'), 'default');
  assert.equal(wrapper.get('[data-option-value="path"]').attributes('data-size'), 'default');
  assert.equal(wrapper.get('[data-option-value="path"]').attributes('aria-pressed'), 'true');
  await wrapper.get('[data-option-value="unavailable"]').trigger('click');
  assert.deepEqual(selected, ['path']);
});

test('UiSegmentedControl рисует необязательный бейдж опции и не ломает выбор', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, Component] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/composites/UiSegmentedControl.vue')),
  ]);
  const selected = [];
  const wrapper = mount(Component, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      modelValue: 'active',
      size: 'compact',
      options: [
        { value: 'active', label: 'Активные' },
        {
          value: 'archived',
          label: 'Архив',
          badge: 1779,
        },
        {
          value: 'empty',
          label: 'Пусто',
          badge: '',
        },
        {
          value: 'zero',
          label: 'Ноль',
          badge: 0,
        },
      ],
      'onUpdate:modelValue': (value) => selected.push(value),
    },
  });

  t.after(() => wrapper.unmount());

  // Бейдж живёт только у опции с непустым значением; подпись не содержит число.
  const archived = wrapper.get('[data-option-value="archived"]');

  assert.equal(archived.get('.ui-segmented-badge').text(), '1779');
  assert.ok(archived.text().includes('Архив'));
  assert.equal(wrapper.find('[data-option-value="active"] .ui-segmented-badge').exists(), false);
  assert.equal(wrapper.find('[data-option-value="empty"] .ui-segmented-badge').exists(), false);

  // Ноль — значимый счётчик и остаётся видимым, в отличие от пустой строки.
  assert.equal(wrapper.get('[data-option-value="zero"] .ui-segmented-badge').text(), '0');

  // Выбор сегмента с бейджем работает как у обычного, aria-pressed следует за моделью.
  await archived.trigger('click');
  assert.deepEqual(selected, ['archived']);
  await wrapper.setProps({ modelValue: 'archived' });
  assert.equal(archived.attributes('aria-pressed'), 'true');
  assert.equal(archived.get('.ui-segmented-badge').text(), '1779');

  // Снятие бейджа убирает плашку, не пересоздавая выбор.
  await wrapper.setProps({
    options: [
      { value: 'active', label: 'Активные' },
      { value: 'archived', label: 'Архив' },
    ],
  });
  assert.equal(wrapper.find('[data-option-value="archived"] .ui-segmented-badge').exists(), false);
  assert.equal(wrapper.get('[data-option-value="archived"]').attributes('aria-pressed'), 'true');
});
