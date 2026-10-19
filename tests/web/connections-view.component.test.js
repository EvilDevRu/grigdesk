import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

test('машины: список и несовместимые версии доступны без сервера', async (t) => {
  await installUiBrowser(t);

  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const { nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const actions = [];
  const confirmations = [false, true];

  globalThis.__confirmMachine = async () => confirmations.shift();

  globalThis.__testShell = reactive({
    present: true,
    status: 'incompatible',
    profiles: [{
      id: 'machine',
      name: 'Домашний ПК',
      address: 'machine:443',
      kind: 'remote',
      status: 'incompatible',
    }],
    profile: null,
    localAvailable: true,
    appApi: { major: 0, minor: 1 },
    serverApi: { major: 1, minor: 0 },
    detail: 'Обновите приложение',
    capabilities: [],
    addMachine: async (pairing) => actions.push(['add', pairing]),
    removeProfile: async (id) => actions.push(['remove', id]),
  });

  const component = await compileVue(webFile('src/views/ConnectionsView.vue'), {
    stubs: {
      '../stores/shell.ts': 'export const useShellStore = () => globalThis.__testShell;',
      '../../stores/shell.ts': 'export const useShellStore = () => globalThis.__testShell;',
      '../ui.ts': `
        export { UiButton, UiInlineMessage, UiActionLink, promptDialog } from './src/ui.ts';
        export const confirmDialog = () => globalThis.__confirmMachine();
      `,
    },
  });
  const wrapper = mount(component, { attachTo: document.body });

  t.after(() => wrapper.unmount());
  assert.match(wrapper.text(), /Домашний ПК/);
  assert.match(wrapper.text(), /0\.1/);
  assert.match(wrapper.text(), /1\.0/);
  assert.match(wrapper.text(), /Этот компьютер/);

  const remove = wrapper.findAll('button').find((button) => button.text() === 'Удалить');

  await remove.trigger('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(actions, []);
  await remove.trigger('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(actions, [['remove', 'machine']]);
  await wrapper.findAll('button').find((button) => button.text() === 'Добавить машину').trigger('click');
  await nextTick();

  const textarea = document.querySelector('textarea');

  assert.ok(textarea);
  textarea.value = 'GRIGDESK:PAIR:1:TEST';
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  document.querySelectorAll('button').forEach((button) => {
    if (button.textContent.trim() === 'Добавить') {
      button.click();
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(actions.at(-1), ['add', 'GRIGDESK:PAIR:1:TEST']);
});
