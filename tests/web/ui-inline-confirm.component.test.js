import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

test('UiInlineConfirm открывается через defineModel и сохраняет confirm contract', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, UiInlineConfirm] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/composites/UiInlineConfirm.vue')),
  ]);
  let wrapper;
  const modelUpdates = [];
  let confirmations = 0;

  wrapper = mount(UiInlineConfirm, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      question: 'Применить лимит?',
      confirmText: 'Применить',
      modelValue: false,
      'onUpdate:modelValue': (value) => {
        modelUpdates.push(value);

        return wrapper.setProps({ modelValue: value });
      },
      onConfirm: () => {
        confirmations += 1;
      },
    },
    slots: {
      default: 'Изменить',
    },
  });

  t.after(() => wrapper.unmount());

  await wrapper.get('button').trigger('click');

  assert.deepEqual(modelUpdates, [true]);
  assert.match(wrapper.text(), /Применить лимит/);

  const confirm = wrapper.findAll('button').find((entry) => (
    entry.text() === 'Применить'
  ));

  await confirm.trigger('click');

  assert.equal(confirmations, 1);
});
