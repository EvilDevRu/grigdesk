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
