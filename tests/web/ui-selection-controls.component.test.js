import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

test('UiCheckbox поддерживает boolean и value-in-array', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, UiCheckbox] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/primitives/UiCheckbox.vue')),
  ]);
  const values = [];
  const wrapper = mount(UiCheckbox, {
    attachTo: browser.document.querySelector('#mount'),
    props: { modelValue: false, 'onUpdate:modelValue': (value) => values.push(value) },
  });
  await wrapper.get('input').setValue(true);
  assert.equal(values.at(-1), true);
  await wrapper.setProps({ modelValue: true });
  await wrapper.setProps({ modelValue: ['one'], value: 'two' });
  await wrapper.get('input').setValue(true);
  assert.deepEqual(values.at(-1), ['one', 'two']);
  wrapper.unmount();
});

test('UiTabs даёт ARIA и roving keyboard без выбора disabled tab', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, Harness] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('../tests/web/fixtures/ui/components/TabsHarness.vue')),
  ]);
  const wrapper = mount(Harness, { attachTo: browser.document.querySelector('#mount') });
  const tabs = wrapper.findAll('[role="tab"]');
  assert.equal(tabs.length, 3);
  assert.equal(tabs[0].attributes('aria-selected'), 'true');
  tabs[0].element.focus();
  await wrapper.get('[role="tablist"]').trigger('keydown', { key: 'ArrowRight' });
  assert.equal(browser.document.activeElement === tabs[1].element, true);
  assert.equal(tabs[1].attributes('aria-selected'), 'true');
  await wrapper.get('[role="tablist"]').trigger('keydown', { key: 'ArrowRight' });
  assert.equal(browser.document.activeElement === tabs[0].element, true);
  wrapper.unmount();
});
