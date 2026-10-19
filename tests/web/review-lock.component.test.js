import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

test('W2: блокировка выше документа и удерживает Escape, нижний портал inert', async (t) => {
  await installUiBrowser(t);

  const { h, nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const fixture = await compileVue(new URL('./fixtures/locked-document.vue', import.meta.url).pathname, {
    stubs: { '../../stores/shell.ts': 'export const useShellStore = () => ({ unlock: async () => {} });' },
  });

  globalThis.__reviewClosed = 0;

  const wrapper = mount(fixture, { attachTo: document.body });

  t.after(() => wrapper.unmount());
  await nextTick();
  await nextTick();

  const overlays = [...document.querySelectorAll('.ui-dialog-overlay')];
  const documentOverlay = overlays.find((item) => item.textContent.includes('Документ'));
  const lockOverlay = overlays.find((item) => item.textContent.includes('Приложение заблокировано'));

  assert.ok(Number(lockOverlay.style.getPropertyValue('--ui-layer-z'))
    > Number(documentOverlay.style.getPropertyValue('--ui-layer-z')));
  assert.equal(documentOverlay.inert, true);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await nextTick();
  assert.equal(globalThis.__reviewClosed, 0);
});
