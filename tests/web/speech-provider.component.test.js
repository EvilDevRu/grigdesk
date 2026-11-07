// Проверяет жизненный цикл Vue-провайдера единственного контроллера диктовки.
import assert from 'node:assert/strict';
import test from 'node:test';

import { loadProductModule } from './helpers/compile-vue.js';

test('COMP-STT-13: authenticated provider создаёт один controller, inject и dispose при logout', async (t) => {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'https://grigdesk.test/' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
  })) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  browser.document.body.innerHTML = '<div id="mount"></div>';
  t.after(() => browser.close());

  const [
    { defineComponent, h, inject, ref, nextTick },
    { mount },
    { DICTATION_CONTROLLER_KEY, createSpeechProvider },
  ] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    loadProductModule('src/features/speech/provider.ts', {
      '../../stores/chat.ts': 'export const useChatStore = () => null;',
    }),
  ]);
  const created = [];
  const injected = [];
  const chat = { speech: { revision: 'speech:provider-r1' }, setSpeechSnapshot() {} };
  const Provider = createSpeechProvider({
    useChatStore: () => chat,
    controllerFactory() {
      const controller = {
        syncSettingsCalls: [],
        disposed: 0,
        syncSettings(value) { this.syncSettingsCalls.push(value); },
        dispose() { this.disposed += 1; },
      };
      created.push(controller);
      return controller;
    },
  });
  const Consumer = defineComponent({
    setup() {
      injected.push(inject(DICTATION_CONTROLLER_KEY));
      return () => h('span', 'consumer');
    },
  });
  const on = ref(false);
  const Root = defineComponent({
    setup: () => () => (on.value ? h(Provider, null, { default: () => h(Consumer) }) : h('span', 'login')),
  });
  const wrapper = mount(Root, { attachTo: browser.document.querySelector('#mount') });
  t.after(() => wrapper.unmount());

  assert.equal(created.length, 0, 'login branch не создаёт controller');
  on.value = true;
  await nextTick();
  assert.equal(created.length, 1);
  assert.equal(injected[0], created[0]);

  on.value = false;
  await nextTick();
  assert.equal(created[0].disposed, 1);
  on.value = true;
  await nextTick();
  assert.equal(created.length, 2, 'повторный login получает новый controller');
  assert.equal(injected[1], created[1]);
});
