import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

test('связь: видимость, подпись, выбор машины и Escape', async (t) => {
  await installUiBrowser(t);

  const { reactive, nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const selected = [];

  globalThis.__connectionShell = reactive({
    present: false,
    status: 'online',
    profile: { id: 'one', name: 'Домашний ПК' },
    profiles: [
      { id: 'one', name: 'Домашний ПК' },
      { id: 'two', name: 'Другая машина' },
    ],
    detail: null,
    capabilities: [],
    selectProfile: async (id) => selected.push(id),
  });

  const component = await compileVue(webFile('src/shared/layout/ConnectionButton.vue'), {
    stubs: {
      '../../stores/shell.ts': 'export const useShellStore = () => globalThis.__connectionShell;',
    },
  });
  const wrapper = mount(component, { attachTo: document.body });

  t.after(() => wrapper.unmount());
  assert.equal(wrapper.find('button').exists(), false);
  globalThis.__connectionShell.present = true;
  await nextTick();
  assert.match(wrapper.text(), /Домашний ПК · в сети/);
  globalThis.__connectionShell.status = 'offline';
  await nextTick();
  assert.match(wrapper.text(), /нет связи/);
  globalThis.__connectionShell.status = 'incompatible';
  await nextTick();
  assert.match(wrapper.text(), /нужно обновить приложение/);
  globalThis.__connectionShell.status = 'online';
  await nextTick();
  await wrapper.find('button').trigger('click');
  await nextTick();

  assert.equal(document.querySelectorAll('[role=separator]').length, 1);

  const target = [...document.querySelectorAll('button')]
    .find((button) => button.textContent.trim() === 'Другая машина');

  assert.ok(target);
  target.click();
  await nextTick();
  assert.deepEqual(selected, ['two']);
  await wrapper.find('button').trigger('click');
  await nextTick();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await nextTick();
  assert.equal(document.querySelector('[data-connection-menu]') === null, true);

  let connects = 0;

  globalThis.__connectionShell.connect = async () => connects += 1;
  globalThis.__connectionShell.status = 'offline';
  globalThis.__connectionShell.detail = { code: 'disconnected' };
  await nextTick();
  assert.match(wrapper.text(), /отключено/);
  await wrapper.find('button').trigger('click');
  await nextTick();

  const connect = [...document.querySelectorAll('button')]
    .find((button) => button.textContent.trim() === 'Подключиться');

  assert.ok(connect !== undefined);
  connect.click();
  await nextTick();
  assert.equal(connects, 1);
  globalThis.__connectionShell.detail = { retryAt: Date.now() + 4000 };
  await nextTick();
  assert.match(wrapper.text(), /повтор через [45] с/);
});

test('W1: цвета состояний и разделители используют объявленные токены', async () => {
  const { readFile } = await import('node:fs/promises');
  const tokens = await readFile(webFile('src/styles/tokens.css'), 'utf8');
  const declared = new Set([...tokens.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));

  for (const file of ['src/shared/layout/ConnectionButton.vue', 'src/views/ConnectionsView.vue']) {
    const source = await readFile(webFile(file), 'utf8');

    for (const [, token] of source.matchAll(/var\((--[\w-]+)/g)) {
      assert.equal(declared.has(token), true, `${file}: ${token}`);
    }
  }
});
