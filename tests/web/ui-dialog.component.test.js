import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

test('UiDialog централизует workspace layer, edge-to-edge body и Escape', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ h, nextTick }, { mount, flushPromises }, UiDialog] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/components/overlays/UiDialog.vue')),
  ]);
  const updates = [];
  const closes = [];
  let wrapper;

  wrapper = mount(UiDialog, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      open: true,
      layer: 'diff-workspace',
      size: 'workspace',
      label: 'Диф задачи',
      bodyInset: false,
      'onUpdate:open': (value) => {
        updates.push(value);

        return wrapper.setProps({ open: value });
      },
      onClose: (reason) => {
        closes.push(reason);
      },
    },
    slots: {
      default: () => h('button', { type: 'button' }, 'Действие'),
    },
  });

  t.after(() => wrapper.unmount());
  await nextTick();
  await flushPromises();

  const overlay = browser.document.querySelector('.ui-dialog-overlay');
  const surface = browser.document.querySelector('.ui-dialog');

  assert.ok(overlay);
  assert.ok(surface);
  assert.equal(overlay.dataset.uiLayer, 'diff-workspace');
  assert.equal(surface.dataset.bodyInset, 'false');
  assert.equal(surface.getAttribute('aria-label'), 'Диф задачи');
  assert.equal(browser.document.body.classList.contains('ui-modal-scroll-lock'), true);

  const escape = new browser.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });

  browser.document.body.dispatchEvent(escape);
  await nextTick();
  await flushPromises();

  assert.equal(escape.defaultPrevented, true);
  assert.deepEqual(updates, [false]);
  assert.deepEqual(closes, ['escape']);
  assert.equal(browser.document.body.classList.contains('ui-modal-scroll-lock'), false);

  await new Promise((resolve) => setTimeout(resolve, 50));
  await nextTick();

  assert.equal(Boolean(browser.document.querySelector('.ui-dialog-overlay')), false);
});
