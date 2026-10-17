process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile, singletonUrl } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { UNIT } from './helpers/studio3d-fixtures.js';

test('WC-02/03 словарь всех полей, advanced/errors и подтверждённая цена', async (t) => {
  await installUiBrowser(t);
  
  const { mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.cjs.js');
  const { nextTick } = await import(singletonUrl('vue'));
  const Form = await compileVue(webFile('src/views/studio3d/OperationForm.vue'));
  const Price = await compileVue(webFile('src/views/studio3d/PriceButton.vue'));
  const kinds = ['text', 'textarea', 'number', 'select', 'toggle', 'multiselect', 'view-prompts'];
  const fields = kinds.map((kind) => ({
    id: kind,
    kind,
    label: kind,
    options: [{
      value: 'walk',
      label: 'Шаг',
      group: 'Движения'
    }],
    advanced: false,
    visibleWhen: null
  }));
  
  fields.push({
    id: 'advanced',
    kind: 'text',
    label: 'Скрытый параметр',
    advanced: true
  });
  
  const wrapper = mount(Form, { props: {
    fields,
    modelValue: {},
    errors: []
  } });
  
  t.after(() => wrapper.unmount());
  
  for (const selector of ['.ui-input', '.ui-textarea', '.ui-number-field', '.ui-select', '.ui-switch',
    '.ui-choice-list']) {
      assert.equal(wrapper.find(selector).exists(), true, selector);
    }
  
  assert.equal(wrapper.text().includes('Движения'), true);
  assert.equal(wrapper.text().includes('Скрытый параметр'), false);
  await wrapper.setProps({ errors: [{ field: 'advanced', message: 'Ошибка скрытого поля' }] });
  assert.equal(wrapper.text().includes('Скрытый параметр'), true);
  assert.equal(wrapper.text().includes('Ошибка скрытого поля'), true);
  
  const quote = {
    total: 30,
    lines: [{ label: 'Модель', amount: 30 }],
    unit: UNIT,
    usd: 0.30,
    note: null
  };
  let attempts = 0;
  const button = mount(Price, { props: {
    quote,
    validation: {
      values: {},
      errors: [],
      warnings: []
    },
    balance: 25,
    verb: 'Создать',
    fingerprint: 'fixture-form',
    execute: async () => {
      attempts += 1;
      
      throw new TypeError('fixture offline');
    }
  } });
  
  t.after(() => button.unmount());
  assert.equal(button.text().includes('30 кредитов'), true);
  assert.equal(button.text().includes('Не хватает 5 кредитов'), true);
  assert.equal(button.get('[data-context="studio-price"]').attributes('disabled') !== undefined, true);
  await button.setProps({ balance: 100 });
  await button.get('[data-context="studio-price"]').trigger('click');
  await nextTick();
  await new Promise(setImmediate);
  
  const key = button.emitted('run')[0][0];
  
  await button.get('[data-context="studio-price"]').trigger('click');
  await new Promise(setImmediate);
  assert.equal(button.emitted('run')[1][0], key);
  assert.equal(attempts, 2);
  
  let release;
  
  await button.setProps({ execute: () => new Promise((resolve) => {
    release = resolve;
  }) });
  await button.get('[data-context="studio-price"]').trigger('click');
  await button.get('[data-context="studio-price"]').trigger('click');
  assert.equal(button.emitted('run').length, 3);
  release({ accepted: true });
  await new Promise(setImmediate);
  await button.setProps({ quote: {
    ...quote,
    total: 0,
    unit: null
  }, verb: 'Развернуть' });
  assert.equal(button.text().includes('Развернуть — бесплатно'), true);
});
