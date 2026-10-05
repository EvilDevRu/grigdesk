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

test('TIP-UIT-03: мышь показывает с задержкой, касание игнорируется', async (t) => {
  const wrapper = setup(t, { pressDismiss: true });

  await wrapper.get('button').trigger('pointerenter', { pointerType: 'touch' });
  await settle();
  assert.equal(shown(), false);
  await wrapper.get('button').trigger('pointerenter', { pointerType: 'mouse' });
  assert.equal(shown(), false);
  await settle();
  assert.equal(shown(), true);
});

test('TIP-UIT-04: нажатие подавляет показ до ухода курсора', async (t) => {
  const wrapper = setup(t, { pressDismiss: true });
  const button = wrapper.get('button');

  await button.trigger('pointerenter', { pointerType: 'mouse' });
  await settle();
  assert.equal(shown(), true);
  await button.trigger('pointerdown', { pointerType: 'mouse' });
  assert.equal(shown(), false);
  button.element.focus();
  await settle();
  assert.equal(shown(), false);
  await button.trigger('pointerleave');
  await button.trigger('pointerenter', { pointerType: 'pen' });
  await settle();
  assert.equal(shown(), true);
});

test('TIP-UIT-05: клавиатурный фокус открывает, уход закрывает', async (t) => {
  const wrapper = setup(t, { pressDismiss: true });

  wrapper.get('button').element.focus();
  await settle();
  assert.equal(shown(), true);
  wrapper.get('button').element.blur();
  await settle();
  assert.equal(shown(), false);
});

test('TIP-UIT-06: прежние mouseenter и focusin остаются рабочими', async (t) => {
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
