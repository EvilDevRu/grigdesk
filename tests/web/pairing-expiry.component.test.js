import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

test('W12: отсчёт привязки использует относительный срок при чужих часах сервера', async (t) => {
  await installUiBrowser(t);

  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const { nextTick } = await import('../../web/node_modules/vue/index.mjs');

  globalThis.__pairExpiryApi = {
    post: async () => ({
    text: 'SYNTHETIC',
    svg: '<svg />',
    expiresAt: 1,
    expiresInMs: 600000
  })
  };

  const component = await compileVue(webFile('src/views/settings/PairDeviceDialog.vue'), {
    stubs: { '../../shared/apiClient.ts': 'export const api = globalThis.__pairExpiryApi;' },
  });
  const wrapper = mount(component, { props: { open: true }, attachTo: document.body });

  t.after(() => wrapper.unmount());

  const input = document.querySelector('input');

  input.value = 'Фикстура';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Получить код').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(document.querySelector('.ui-dialog').textContent, /Осталось 600 с/);
});
