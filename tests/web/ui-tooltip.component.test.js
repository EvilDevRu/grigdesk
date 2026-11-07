import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

test('UiTooltip показывает text, а не копию именованного trigger-а', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ h, nextTick }, { mount }, UiTooltip] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/overlays/UiTooltip.vue')),
  ]);
  const wrapper = mount(UiTooltip, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      text: 'Полное описание действия',
    },
    slots: {
      trigger: () => h('button', { type: 'button' }, 'Короткий trigger'),
    },
  });

  t.after(() => wrapper.unmount());

  const trigger = wrapper.get('button');
  await trigger.trigger('mouseenter');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await nextTick();

  const tooltip = browser.document.getElementById(trigger.attributes('aria-describedby'));
  assert.ok(tooltip);
  assert.equal(tooltip.textContent, 'Полное описание действия');
  assert.doesNotMatch(tooltip.textContent, /Короткий trigger/);
});
