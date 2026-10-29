import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

let mount;
let nextTick;
let reactive;
let defineStore;
let createPinia;
let View;
let Preview;
let serial = 0;

before(async () => {
    await installUiBrowser({ after });
    ({ mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'));
    ({ nextTick, reactive } = await import('../../web/node_modules/vue/index.mjs'));
    ({ defineStore, createPinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs'));
    Preview = await compileVue(webFile('src/views/chat/ChatLoadingPreview.vue'));
    View = await compileVue(webFile('src/views/ChatsView.vue'), {
        stubs: {
            '../stores/chat.ts': 'export const useChatStore = () => globalThis.__loadingChat;',
            '../../stores/chat.ts': 'export const useChatStore = () => globalThis.__loadingChat;',
            '../../stores/providers.ts': `export const useProvidersStore = () => ({
        load() {}, modelOf() { return { model: null, provider: null }; },
      });`,
            '../../shared/apiClient.ts': `export const api = { get: async (url) => {
        if (url !== '/api/chat/sessions') throw new Error('Неожиданный API: ' + url);
        return { sessions: [] };
      } };`,
            '../../composables/useSse.ts': `import { ref } from 'vue';
        export const useSse = () => ({ connected: ref(true) });
        export const sseSubscribe = () => () => {};`,
            './useSse.ts': `import { ref } from 'vue';
        export const useSse = () => ({ connected: ref(true) });
        export const sseSubscribe = () => () => {};`,
            './useSse': `import { ref } from 'vue';
        export const useSse = () => ({ connected: ref(true) });
        export const sseSubscribe = () => () => {};`,
            '../composables/useUiContextSource.ts': `export const useUiContextSource = () => ({
        focus() {}, update() {}, blur() {},
      });`,
            '../shared/tools/viewport.ts': `import { ref } from 'vue';
        export const useDockViewport = () => ({
        dockCapable: ref(true),
      });`,
            './chat/ChatSession.vue': `import { onMounted } from 'vue';
        export default { props: ['sid'], setup() {
          onMounted(() => { globalThis.__loadingSessionMounts += 1; });
          return () => null;
        } };`,
        },
    });
});
/**
 * Настоящие ChatsView и ChatList читают один Pinia-порт с подтверждением загрузки.
 * Двойник сессии считает только её mount: геометрия настоящего ввода проверяется браузером.
 */
function fixture(t, initial = {}) {
    const pinia = createPinia();
    const state = reactive({
        ensures: 0,
        retries: 0,
    });
    const useStore = defineStore(`loading-chat-${serial += 1}`, {
        state: () => ({
            loaded: false,
            loading: true,
            loadError: null,
            loadErrorMessage: null,
            activeId: 'saved',
            revealRequest: '',
            archived: [],
            ...initial,
        }),
        actions: {
            ensure() {
                state.ensures += 1;
            },
            retryLoad() {
                state.retries += 1;
                this.loading = true;
            },
            list: () => [],
            registerSurface: () => ({ update() {
                }, dispose() {
                } }),
            consumeReveal() {
            },
            markRead() {
            },
            newSession() {
            },
            selectChat() {
            },
            renameChat() {
            },
            deleteChat() {
            },
            restoreArchived() {
            },
        },
    });
    const chat = useStore(pinia);

    globalThis.__loadingChat = chat;
    globalThis.__loadingSessionMounts = 0;

    const wrapper = mount(View, { global: { plugins: [pinia] } });

    t.after(() => wrapper.unmount());

    return {
        wrapper,
        chat,
        state
    };
}

after(() => {
    delete globalThis.__loadingChat;
    delete globalThis.__loadingSessionMounts;
});
test('LOAD-CHAT: обе части используют общие кирпичики, справа нет иллюстрации', (t) => {
    const { wrapper } = fixture(t);

    assert.ok(
        wrapper.get('.cl').findAll('[data-ui-skeleton]').length > 0,
        'строки списка собраны из UiSkeleton'
    );
    assert.ok(
        wrapper.get('.chat-loading-preview').findAll('[data-ui-skeleton]').length > 0,
        'шапка, сообщения и ввод переписки собраны из UiSkeleton'
    );
    assert.equal(wrapper.find('.preview-art').exists(), false, 'облачка удалены');
});
test('LOAD-CHAT-error: ошибка и retry подавляют декорацию в обеих частях', async (t) => {
    const { wrapper, chat, state } = fixture(t, {
        loading: false,
        loadError: 'network',
        loadErrorMessage: 'Нет связи с сервером',
    });
    const retry = wrapper.findAll('button').find((button) => button.text() === 'Повторить');

    assert.ok(retry, 'прежний повтор доступен');
    assert.match(wrapper.text(), /Нет связи с сервером/);
    assert.equal(wrapper.find('[data-ui-skeleton]').exists(), false);
    assert.equal(wrapper.find('.preview-art').exists(), false, 'при ошибке справа нет декорации');
    await retry.trigger('click');
    await nextTick();
    assert.equal(state.retries, 1);
    assert.equal(chat.loading, true);
    assert.equal(retry.attributes('disabled'), '');
    assert.match(wrapper.text(), /Нет связи с сервером/);
    assert.equal(wrapper.find('[data-ui-skeleton]').exists(), false);
    chat.loadError = null;
    chat.loadErrorMessage = null;
    chat.loaded = true;
    chat.loading = false;
    await nextTick();
    assert.equal(wrapper.find('.chat-loading-preview').exists(), false);
    assert.equal(globalThis.__loadingSessionMounts, 1);
});
test('LOAD-CHAT-ready: сохранённый id не монтирует сессию до подтверждённого списка', async (t) => {
    const { wrapper, chat, state } = fixture(t);

    assert.equal(globalThis.__loadingSessionMounts, 0);
    assert.equal(state.ensures, 1);
    chat.loaded = true;
    chat.loading = false;
    await nextTick();
    assert.equal(globalThis.__loadingSessionMounts, 1);
    assert.equal(wrapper.find('.chat-loading-preview').exists(), false);
    assert.equal(state.ensures, 1, 'изменение представления не вызывает новый ensure');
});
test('LOAD-CHAT: самостоятельный preview соблюдает failed и объявляет один статус', async (t) => {
    const wrapper = mount(Preview);

    t.after(() => wrapper.unmount());
    assert.equal(wrapper.findAll('[role="status"]').length, 1);
    assert.ok(wrapper.findAll('[data-ui-skeleton]').length > 0);
    await wrapper.setProps({ failed: true });
    assert.equal(wrapper.find('[data-ui-skeleton]').exists(), false);
});

test('LOAD-CHAT-layout: чтение сохранённой высоты вынесено в лёгкий helper', async () => {
    assert.ok(existsSync(webFile('src/views/chat/chatLayout.ts')), 'chatLayout.ts вынесен');
});
