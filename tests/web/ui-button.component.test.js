import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

test('UiButton безопасно задаёт type и блокирует loading/ariaDisabled', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, UiButton] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/primitives/UiButton.vue')),
  ]);
  let clicks = 0;
  const wrapper = mount(UiButton, {
    attachTo: browser.document.querySelector('#mount'),
    props: { onClick: () => { clicks += 1; } },
    slots: { default: 'Запустить' },
  });
  assert.equal(wrapper.element.tagName, 'BUTTON');
  assert.equal(wrapper.attributes('type'), 'button');
  await wrapper.trigger('click');
  assert.equal(clicks, 1);

  await wrapper.setProps({ loading: true });
  assert.equal(wrapper.attributes('aria-busy'), 'true');
  assert.equal(wrapper.attributes('aria-disabled'), 'true');
  assert.match(wrapper.text(), /Запустить/);
  await wrapper.trigger('click');
  assert.equal(clicks, 1);

  await wrapper.setProps({ loading: false, ariaDisabled: true });
  assert.equal(wrapper.attributes('disabled'), undefined);
  await wrapper.trigger('click');
  assert.equal(clicks, 1);
  wrapper.unmount();
});

test('UiActionLink остаётся ссылкой и guard снимает переход', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, UiActionLink] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/primitives/UiActionLink.vue')),
  ]);
  const wrapper = mount(UiActionLink, {
    attachTo: browser.document.querySelector('#mount'),
    props: { href: '/settings', target: '_blank' },
    slots: { default: 'Настройки' },
  });
  assert.equal(wrapper.element.tagName, 'A');
  assert.equal(wrapper.attributes('href'), '/settings');
  assert.equal(wrapper.attributes('rel'), 'noopener noreferrer');
  await wrapper.setProps({ disabled: true });
  assert.equal(wrapper.attributes('href'), undefined);
  assert.equal(wrapper.attributes('aria-disabled'), 'true');
  assert.equal(wrapper.attributes('tabindex'), '-1');
  wrapper.unmount();
});
