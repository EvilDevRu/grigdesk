import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

test('UiFloatingDialog связывает имя, action close и возврат фокуса', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ h, nextTick }, { mount, flushPromises }, UiFloatingDialog] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/overlays/UiFloatingDialog.vue')),
  ]);
  const closes = [];
  const updates = [];
  let closeDialog;
  let wrapper;

  wrapper = mount(UiFloatingDialog, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      open: false,
      title: 'Настройки помощника',
      focusPolicy: 'none',
      'onUpdate:open': (value) => {
        updates.push(value);

        return wrapper.setProps({ open: value });
      },
      onClose: (reason) => {
        closes.push(reason);
      },
    },
    slots: {
      trigger: ({ open }) => h(
        'button',
        {
          type: 'button',
          class: 'floating-trigger',
        },
        open ? 'Скрыть помощника' : 'Открыть помощника',
      ),
      default: ({ close }) => {
        closeDialog = close;

        return h(
          'button',
          {
            type: 'button',
            class: 'floating-action',
            onClick: () => close('action'),
          },
          'Готово',
        );
      },
    },
    global: {
      stubs: {
        transition: true,
      },
    },
  });

  t.after(() => wrapper.unmount());

  const trigger = wrapper.get('.floating-trigger');
  trigger.element.focus();
  await trigger.trigger('click');
  await nextTick();
  await flushPromises();

  const surface = browser.document.querySelector('.ui-floating-dialog');
  const titleId = surface?.getAttribute('aria-labelledby');

  assert.ok(surface);
  assert.equal(surface.getAttribute('role'), 'dialog');
  assert.ok(titleId);
  assert.equal(browser.document.getElementById(titleId)?.textContent, 'Настройки помощника');
  assert.equal(trigger.attributes('aria-expanded'), 'true');

  assert.equal(typeof closeDialog, 'function');
  closeDialog('action');
  await nextTick();
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await nextTick();

  assert.equal(Boolean(browser.document.querySelector('.ui-floating-dialog')), false);
  assert.deepEqual(updates, [true, false]);
  assert.deepEqual(closes, ['action']);
  assert.equal(browser.document.activeElement === trigger.element, true);
});
