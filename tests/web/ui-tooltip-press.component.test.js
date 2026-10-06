process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { isKeyboardFocus, isTouchPointer } from '../../web/src/services/tooltipInput.ts';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { createUiBrowser } from './helpers/ui-components.js';

let browser;
let UiTooltip;
let UiButton;
let mount;
let h;
let nextTick;

before(async () => {
  browser = await createUiBrowser();
  ({ h, nextTick } = await import('../../web/node_modules/vue/index.mjs'));
  ({ mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'));
  UiTooltip = await compileVue(webFile('src/components/overlays/UiTooltip.vue'));
  UiButton = await compileVue(webFile('src/components/primitives/UiButton.vue'));
});

after(async () => {
  await browser.close();
});

function setup(t, props = {}) {
  const wrapper = mount(UiTooltip, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      text: 'Справка',
      showDelay: 20,
      hideDelay: 0,
      ...props,
    },
    slots: { trigger: () => h(UiButton, null, () => 'Шаг') },
  });

  t.after(() => wrapper.unmount());

  return wrapper;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 40));
  await nextTick();
}

function shown() {
  return Boolean(browser.document.querySelector('[role="tooltip"]'));
}

test('TIP-UIT-01: касание, focus-visible и неподдерживаемый селектор', () => {
  assert.equal(isTouchPointer(new browser.PointerEvent('pointerenter', { pointerType: 'touch' })), true);
  assert.equal(isTouchPointer(new browser.PointerEvent('pointerenter', { pointerType: 'mouse' })), false);
  assert.equal(isKeyboardFocus({ target: { matches: () => true } }), true);
  assert.equal(isKeyboardFocus({ target: { matches: () => false } }), false);
  assert.equal(isKeyboardFocus({ target: { matches: () => {
    throw new Error('Нет селектора');
  } } }), true);
});

test('TIP-UIT-02: disabled снимает описание и отменяет показ', async (t) => {
  const wrapper = setup(t, { disabled: true });

  assert.equal(wrapper.get('button').attributes('aria-describedby'), undefined);
  await wrapper.get('button').trigger('mouseenter');
  await settle();
  assert.equal(shown(), false);
  await wrapper.setProps({ disabled: false });
  await wrapper.get('button').trigger('mouseenter');
  await settle();
  assert.equal(shown(), true);
  await wrapper.setProps({ disabled: true });
  assert.equal(shown(), false);
});

test('TIP-UIT-06: mouseenter и focusin показывают и прячут справку', async (t) => {
  const wrapper = setup(t);

  await wrapper.get('button').trigger('mouseenter');
  await settle();
  assert.equal(shown(), true);
  await wrapper.get('button').trigger('mouseleave');
  await settle();
  assert.equal(shown(), false);
  await wrapper.get('button').trigger('focusin');
  await settle();
  assert.equal(shown(), true);
});
