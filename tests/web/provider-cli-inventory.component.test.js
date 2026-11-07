import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

test('опись показывает выбранную копию и конфликт с новым терминалом', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, Component] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/features/providers/ProviderCliInventory.vue')),
  ]);
  const copies = [
    {
      installationId: 'a',
      path: '/first/bin/agent',
      source: 'npm',
      state: 'ready',
      version: '1.0.0',
    },
    {
      installationId: 'b',
      path: '/second/bin/agent',
      source: 'unknown',
      state: 'broken',
      version: null,
    },
  ];
  const wrapper = mount(Component, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      inventory: {
        installations: copies,
        selectedId: 'a',
        terminalId: 'b',
        conflict: true,
      },
    },
  });

  t.after(() => wrapper.unmount());
  assert.match(wrapper.text(), /Разные копии/);
  assert.match(wrapper.text(), /\/first\/bin\/agent/);
  assert.match(wrapper.text(), /\/second\/bin\/agent/);
  assert.match(wrapper.text(), /Используется в GrigDesk/);
  assert.match(wrapper.text(), /В новом терминале/);
  assert.match(wrapper.text(), /1\.0\.0/);
  assert.match(wrapper.text(), /Неизвестный способ/);

  await wrapper.setProps({
    inventory: {
      installations: copies,
      selectedId: 'b',
      terminalId: 'a',
      conflict: true,
    },
  });
  assert.match(wrapper.text(), /Выбранный в GrigDesk путь недоступен/u);
  assert.doesNotMatch(wrapper.text(), /Используется в GrigDesk/u);
});
