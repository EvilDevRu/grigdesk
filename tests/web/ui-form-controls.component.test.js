import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

test('UiInput сохраняет modifiers и composition semantics', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, UiInput] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/primitives/UiInput.vue')),
  ]);
  const values = [];
  const wrapper = mount(UiInput, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      modelValue: '',
      modelModifiers: { trim: true },
      'onUpdate:modelValue': (value) => values.push(value),
    },
  });
  const input = wrapper.element;
  input.dispatchEvent(new browser.CompositionEvent('compositionstart', { bubbles: true }));
  input.value = ' текст ';
  input.dispatchEvent(new browser.InputEvent('input', { bubbles: true }));
  assert.deepEqual(values, []);
  input.dispatchEvent(new browser.CompositionEvent('compositionend', { bubbles: true }));
  assert.deepEqual(values, ['текст']);

  await wrapper.setProps({ modelModifiers: { number: true } });
  input.value = '12.5';
  input.dispatchEvent(new browser.InputEvent('input', { bubbles: true }));
  assert.equal(values.at(-1), 12.5);
  wrapper.unmount();
});

test('UiField связывает label, hint/error и invalid с control', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, Harness] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('../tests/web/fixtures/ui/components/FieldHarness.vue')),
  ]);
  const wrapper = mount(Harness, { attachTo: browser.document.querySelector('#mount') });
  const input = wrapper.get('input');
  const id = input.attributes('id');
  assert.ok(id);
  assert.equal(wrapper.get('label').attributes('for'), id);
  assert.equal(input.attributes('required'), '');
  assert.equal(input.attributes('aria-describedby'), `${id}-hint`);
  await wrapper.setProps({ error: 'Ошибка' });
  assert.equal(input.attributes('aria-invalid'), 'true');
  assert.equal(input.attributes('aria-describedby'), `${id}-error`);
  wrapper.unmount();
});

test('UiNumberInput не превращает пустое значение в ноль', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, UiNumberInput] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/primitives/UiNumberInput.vue')),
  ]);
  const values = [];
  const wrapper = mount(UiNumberInput, {
    attachTo: browser.document.querySelector('#mount'),
    props: { modelValue: 4, 'onUpdate:modelValue': (value) => values.push(value) },
  });
  wrapper.element.value = '';
  wrapper.element.dispatchEvent(new browser.InputEvent('input', { bubbles: true }));
  assert.equal(values.at(-1), '');
  wrapper.unmount();
});
