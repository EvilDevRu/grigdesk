import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
const browser = new Window({ url: 'http://density.test/' });

for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement',
  'SVGElement', 'Event', 'CustomEvent']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: browser[name] });
}

const { mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
const ToolDock = await compileVue(webFile('src/shared/layout/ToolDock.vue'));

test('DU-L01 ресайз дока использует фактический край поверхности', async (t) => {
  const wrapper = mount(ToolDock, {
    attachTo: document.body,
    props: {
      mode: 'dock',
      label: 'Фикстура',
      width: 400,
      minWidth: 100,
      maxWidth: 800
    },
  });

  t.after(() => wrapper.unmount());
  wrapper.element.getBoundingClientRect = () => ({ right: 960 });
  wrapper.get('.dock-resizer').element.dispatchEvent(new browser.PointerEvent('pointerdown', {
    clientX: 500,
    button: 0,
    pointerId: 1,
    bubbles: true,
  }));
  assert.equal(wrapper.emitted('resize')?.length, 1);
  assert.equal(wrapper.emitted('resize')[0][0], 460);
  wrapper.get('.dock-resizer').element.dispatchEvent(new browser.PointerEvent('pointerup', {
    clientX: 450,
    pointerId: 1,
    bubbles: true,
  }));
  assert.equal(wrapper.emitted('resize-end')[0][0], 510);
});
