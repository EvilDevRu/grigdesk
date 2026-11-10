import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

test('CHATS-RETURN-01', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, { createPinia, defineStore }, { nextTick, ref }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
  ]);
  let ensures = 0;
  let disposed = 0;

  globalThis.__returnDock = ref(true);
  globalThis.__returnStore = defineStore('chat-return', {
    state: () => ({
      loaded: false,
      activeId: 'saved-chat',
      openedChatIds: ['saved-chat'],
      revealRequest: '',
    }),
    actions: {
      ensure() {
        ensures += 1;
      },
      consumeReveal() {
        this.revealRequest = '';
      },
      registerSurface() {
        return { update() {}, dispose() {
          disposed += 1;
        } };
      },
      markRead() {},
    },
  });

  const component = await compileVue(webFile('src/views/ChatsView.vue'), {
    stubs: {
      '../ui': 'export const vTooltip = {};',
      '../stores/chat.ts': 'export const useChatStore = globalThis.__returnStore;',
      '../composables/useUiContextSource.ts': `export const useUiContextSource = () => ({
        focus() {}, update() {}, blur() {},
      });`,
      '../shared/tools/viewport.ts': `export const useDockViewport = () => ({
        dockCapable: globalThis.__returnDock,
      });`,
      './chat/ChatList.vue': 'export default { template: "<aside />" };',
      './chat/ChatSession.vue': 'export default { props: ["sid"], template: "<section />" };',
    },
  });
  const pinia = createPinia();
  const wrappers = [];

  t.after(() => {
    for (const wrapper of wrappers) {
      if (wrapper.exists()) {
        wrapper.unmount();
      }
    }

    delete globalThis.__returnStore;
    delete globalThis.__returnDock;
  });

  for (const count of [1, 2]) {
    const chat = globalThis.__returnStore(pinia);

    chat.loaded = false;

    const wrapper = mount(component, {
      attachTo: browser.document.querySelector('#mount'),
      global: { plugins: [pinia] },
    });

    wrappers.push(wrapper);
    assert.equal(ensures, count, 'каждое возвращение на экран зовёт ensure');
    assert.equal(wrapper.find('.chat-loading-preview').exists(), true);
    assert.equal(wrapper.find('section').exists(), false, 'сохранённый activeId ждёт подтверждения списка');
    chat.loaded = true;
    await nextTick();
    assert.equal(wrapper.find('.chat-loading-preview').exists(), false);
    assert.equal(wrapper.find('section').exists(), true, 'после загрузки открывается сохранённый чат');
    wrapper.unmount();
    assert.equal(disposed, count);
  }
});
