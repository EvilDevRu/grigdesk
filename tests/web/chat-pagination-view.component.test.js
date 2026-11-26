import assert from 'node:assert/strict';
import test from 'node:test';

import { api } from '../../web/src/shared/apiClient.ts';
import { sampleChat, jsonRequest } from '../server/helpers/chat-list.js';
import { serverWorld, windowApi } from './helpers/chat-lazy.js';
import { chatStoreFixture } from './helpers/chat-store.js';
import { drain } from './helpers/chat-load.js';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

test('PAGE-COLD-MOUNT: watcher/parent/повтор делят один page1, detail ждёт клик', {
  timeout: 45000,
}, async (t) => {
  await installUiBrowser(t);

  const [{ mount }, { ref, watch }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
  ]);
  const records = Array.from({ length: 95 }, (_, index) => sampleChat(`mount-${index}`, {
    updatedAt: 10000 - index,
    messages: Array.from({
      length: 101
    }, (_, position) => ({

      role: 'assistant',
      text: `mount ${index}/${position}`,
      pid: `mount-msg-${index}-${position}`,

    })),
  }));

  for (const scenario of [
    { wide: false, fail: false },
    { wide: true, fail: false },
    { wide: false, fail: true },
  ]) {
    await t.test(JSON.stringify(scenario), async (t) => {
  const world = await serverWorld(t, records);

  await jsonRequest(world.app, 'PUT', '/api/chat/store/meta', { activeId: records[0].id });
  t.mock.method(api, 'get', async () => ({ sessions: [] }));
  globalThis.__pagingDock = ref(scenario.wide);
  globalThis.__pagingProbeMounts = 0;
  globalThis.__pagingMountConnected = ref(true);
  globalThis.__pagingContextChatId = null;

  const pagingSseStub = `export const useSse = () => ({
    connected: globalThis.__pagingMountConnected,
  }); export const sseSubscribe = () => () => {};`;
  const component = await compileVue(webFile('src/views/ChatsView.vue'), {
    stubs: {
      './useSse.ts': pagingSseStub,
      './useSse': pagingSseStub,
      '../composables/useSse.ts': pagingSseStub,
      '../../composables/useSse.ts': pagingSseStub,
      '../stores/chat.ts': 'export const useChatStore = () => globalThis.__pagingMountChat;',
      '../../actions/projects/index.ts': `
        export const useProjectsStore = () => ({
          activeCatalog: { items: [], loaded: false, loading: false, error: '' },
          deletedIds: new Set(),
        });
        export const loadProjects = async () => {};
        export const watchProjects = () => {};
      `,
      '../../stores/auth.ts': 'export const useAuthStore = () => ({ clientScope: "fixture" });',
      '../../stores/shell.ts': 'export const useShellStore = () => ({ profile: { id: "fixture" } });',
      'vue-router': 'export const useRouter = () => ({ push: async () => {} });',
      '../../stores/chat.ts': 'export const useChatStore = () => globalThis.__pagingMountChat;',
      '../../stores/providers.ts': `export const useProvidersStore = () => ({
        load() {}, modelOf() { return { model: null, provider: null }; },
      });`,
      '../composables/useUiContextSource.ts': `export const useUiContextSource = () => ({
        focus({ details }) { globalThis.__pagingContextChatId = details.chatId; },
        update() {},
        blur() { globalThis.__pagingContextChatId = null; },
      });`,
      '../shared/tools/viewport.ts': `export const useDockViewport = () => ({
        dockCapable: globalThis.__pagingDock,
      });`,
      './chat/ChatSession.vue': `import { onMounted } from 'vue';
        export default { name: 'PagingMountProbe', props: ['sid'], setup() {
          onMounted(() => { globalThis.__pagingProbeMounts += 1; });
          return {};
        }, template: '<section :data-mount-probe="sid" />' };`,
    },
  });
  const network = windowApi(world.app);
  const get = network.api.get;
  const gate = Promise.withResolvers();

  t.after(() => gate.resolve());
  network.api.get = async (url) => {
    const data = await get(url);

    if (url.includes('page=1') && !url.includes('cursor=')) {
      await gate.promise;

      if (scenario.fail) {
        throw new TypeError('Синтетическая потеря первой страницы');
      }
    }

    return data;
  };

  const chat = await chatStoreFixture({}, { api: network.api, unloaded: true });

  globalThis.__pagingMountChat = chat;

  const wrapper = mount(component, { attachTo: document.body });

  t.after(() => {
    wrapper.unmount();
    chat.loaded = false;
    chat.$dispose();
    delete globalThis.__pagingMountChat;
    delete globalThis.__pagingDock;
    delete globalThis.__pagingProbeMounts;
    delete globalThis.__pagingMountConnected;
    delete globalThis.__pagingContextChatId;
  });

  const repeated = chat.ensure();

  await drain();
  assert.equal(network.calls.filter((call) => call.url.includes('page=1')).length, 1);
  assert.equal(globalThis.__pagingProbeMounts, 0);
  gate.resolve();
  await repeated;
  await drain();

  if (scenario.fail) {
    assert.equal(chat.loaded, false);
    assert.ok(wrapper.find('.load-state-error').exists());
    assert.equal(network.calls.filter((call) => call.url.includes('page=1')).length, 1);
    assert.equal(globalThis.__pagingProbeMounts, 0);

    return;
  }

  assert.equal(wrapper.findAll('.cl .row').length, 40);
  assert.equal(wrapper.find('[data-mount-probe]').exists(), false);
  assert.equal(network.calls.some((call) => call.url.includes('archived=1')), false);
  assert.equal(network.calls.some((call) => /store\/chat\//.test(call.url)), false);
  const firstChat = wrapper.get(`[data-chat-id="${records[0].id}"]`);

  assert.equal(chat.activeId, records[0].id);
  assert.equal(firstChat.classes('cur'), false);
  assert.equal(firstChat.get('.row-hit').attributes('aria-pressed'), 'false');
  assert.equal(globalThis.__pagingContextChatId, null);
  await firstChat.get('.row-hit').trigger('click');
  await chat.ensureChatMessages(records[0].id, { jumpToLatest: true });
  await drain();
  assert.equal(wrapper.get('[data-mount-probe]').attributes('data-mount-probe'), records[0].id);
  assert.equal(firstChat.classes('cur'), true);
  assert.equal(firstChat.get('.row-hit').attributes('aria-pressed'), 'true');
  assert.equal(globalThis.__pagingContextChatId, records[0].id);
  assert.equal(globalThis.__pagingProbeMounts, 1);
  assert.equal(chat.session(records[0].id).messages.length, 40);
  wrapper.findComponent({ name: 'PagingMountProbe' }).vm.$emit('back');
  await drain();
  assert.equal(firstChat.classes('cur'), scenario.wide);
  assert.equal(wrapper.find('[data-mount-probe]').exists(), scenario.wide);
  assert.equal(globalThis.__pagingContextChatId, scenario.wide ? records[0].id : null);

  const secondChat = wrapper.get(`[data-chat-id="${records[1].id}"]`);

  await secondChat.get('.row-hit').trigger('click');
  await chat.ensureChatMessages(records[1].id, { jumpToLatest: true });
  await drain();
  assert.equal(wrapper.get('[data-mount-probe]').attributes('data-mount-probe'), records[1].id);
  assert.equal(firstChat.get('.row-hit').attributes('aria-pressed'), 'false');
  assert.equal(secondChat.get('.row-hit').attributes('aria-pressed'), 'true');
  assert.equal(globalThis.__pagingContextChatId, records[1].id);
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const cursor = chat.pageFor('', false).nextCursor;
  const beforeArchive = network.calls.length;

  for (const record of records.slice(0, 40)) {
    chat.deleteChat(record.id);
    await chat._writeChat(record.id);
  }

  await drain();
  assert.equal(wrapper.findAll('.cl .row').length, 0);

  const rows = wrapper.get('.cl .rows');

  Object.defineProperty(rows.element, 'scrollHeight', { configurable: true, value: 0 });
  Object.defineProperty(rows.element, 'clientHeight', { configurable: true, value: 400 });
  rows.element.scrollTop = 0;
  assert.equal(wrapper.text().includes('Нет активных чатов'), false);

  const more = wrapper.findAll('button').find((button) => button.text() === 'Показать ещё');

  assert.ok(more);

  const finished = Promise.withResolvers();
  const stop = watch(() => chat.pageFor('', false).loading, (loading) => {
    if (!loading) {
      finished.resolve();
    }
  }, { flush: 'sync' });

  t.after(() => {
    stop();
    finished.resolve();
  });
  await more.trigger('click');
  await finished.promise;
  await drain();
  assert.equal(wrapper.findAll('.cl .row').length, 40);

  const continuations = network.calls.slice(beforeArchive).filter((call) => call.method === 'GET'
    && new URL(call.url, 'http://fixture').searchParams.get('cursor') === cursor);

  assert.equal(continuations.length, 1);
  assert.equal(network.calls.slice(beforeArchive).some((call) => call.method === 'GET'
    && /store\/chat\//.test(call.url)), false);
  assert.equal(chat.sessions.some((session) => !records.some((record) => record.id === session.id)), false);
  assert.equal(chat.archived.length, 40);

    });
  }
});
