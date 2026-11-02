import assert from 'node:assert/strict';
import test from 'node:test';

import { appWindowStubs } from './helpers/app-window-stubs.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { compileModule, webFile } from './helpers/compile-vue.js';

test('IN01/02/04/06/10/11: App сохраняет основной документ и принимает ранний запрос', async (t) => {
  await installUiBrowser(t);
  Object.defineProperty(globalThis, 'history', { value: window.history, configurable: true });

  const [piniaModule, testUtils, routerModule, vue, module] =
    await Promise.all([
      import('../../web/node_modules/pinia/dist/pinia.mjs'),
      import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
      import('../../web/node_modules/vue-router/dist/vue-router.mjs'),
      import('../../web/node_modules/vue/index.mjs'),
      compileModule(webFile('../tests/web/helpers/settings-app.ts'), { stubs: {
        ...appWindowStubs,
        '../router.ts': 'export const router = { push: async () => {} };',
        '../../router.ts': 'export const router = { push: async () => {} };',
        './shared/asyncView.ts': `
          import { asyncView as realAsyncView } from './src/shared/asyncView.ts';
          export const asyncView = (loader, ...options) => realAsyncView(async () => {
            if (globalThis.__modalChunkFail) {
              globalThis.__modalChunkAttempts += 1;
              throw new Error('Старый чанк удалён');
            }
            return loader();
          }, ...options);
        `,
        './stores/shell.ts': `export const useShellStore = () => ({
          initialized: true, present: false, status: 'none', start: async () => {}, stop() {},
        });`,
        './composables/useSse.ts': appWindowStubs['./composables/useSse.ts'],
        './views/ConnectionsView.vue': 'export default { render: () => null };',
        './shared/layout/LockOverlay.vue': 'export default { render: () => null };',
        './shared/desktopSettings.ts': 'export const currentDesktopMode = () => "page";',
        './stores/auth.ts': 'export const useAuthStore = () => globalThis.__modalAppAuth;',
        './features/speech/provider.ts': `
          import { h, onMounted, onUnmounted } from 'vue';
          export const SpeechProvider = {
            setup(_props, { slots }) {
              onMounted(() => globalThis.__modalAppCounts.speechMounts++);
              onUnmounted(() => globalThis.__modalAppCounts.speechUnmounts++);
              return () => h('section', slots.default?.());
            }
          };
        `,
        './shared/layout/AppShell.vue': `
          import { h, onMounted, onUnmounted } from 'vue';
          const Tools = {
            setup() {
              onMounted(() => globalThis.__modalAppCounts.toolsMounts++);
              onUnmounted(() => globalThis.__modalAppCounts.toolsUnmounts++);
              return () => h('div', { 'data-tools': true });
            }
          };
          export default {
            setup(_props, { slots }) {
              onMounted(() => globalThis.__modalAppCounts.shellMounts++);
              onUnmounted(() => globalThis.__modalAppCounts.shellUnmounts++);
              return () => h('main', [slots.default?.(), h(Tools)]);
            }
          };
        `,
        './views/settings/SettingsModal.vue': `
          export const __esModule = true;
          export default { template: '<div data-modal-settings />' };
        `,
        './views/NoAccessView.vue': 'export default { template: `<div data-noaccess />` };',
        './views/TaskModal.vue': 'export default { render: () => null };',
        './views/DiffModal.vue': 'export default { render: () => null };',
        './views/DocumentModal.vue': 'export default { render: () => null };',
        './views/MediaViewer.vue': 'export default { render: () => null };',
        './stores/board.ts': `export const useBoardStore = () => ({
          startPolling() {}, stopPolling() {}, clearSource() {},
        });`,
        './stores/system.ts': `
          export const useSystemStore = () => ({ startPolling() {}, stopPolling() {} });
        `,
        './stores/taskFavorites.ts': 'export const useTaskFavoritesStore = () => ({ clear() {} });',
        './stores/taskShelf.ts': `
          export const useTaskShelfStore = () => ({ start() {}, stop() {}, clear() {} });
        `,
        './stores/taskSeen.ts': 'export const useTaskSeenStore = () => ({ load() {}, clear() {} });',
        './stores/videoSession.ts': 'export const useVideoSessionStore = () => ({ stopPoll() {} });',
      } }),
    ]);
  const { createPinia } = piniaModule;
  const { mount, flushPromises } = testUtils;
  const { createRouter, createMemoryHistory } = routerModule;
  const { reactive } = vue;
  const pinia = createPinia();
  const settings = module.useSettingsStore(pinia);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: ['chats', 'board', 'settings'].map((name) => ({
      path: '/' + name,
      name,
      component: { template: '<div data-route-view>Основная страница</div>' },
    })),
  });

  globalThis.__modalAppAuth = reactive({
    ready: false,
    authenticated: false,
    watchUnauthorized() {},
    async load() {},
  });
  globalThis.__modalAppCounts = {
    shellMounts: 0,
    shellUnmounts: 0,
    toolsMounts: 0,
    toolsUnmounts: 0,
    speechMounts: 0,
    speechUnmounts: 0,
  };

  const removeGuard = module.installSettingsRouteGuard(router, settings);
  const removeListener = module.installSettingsOpenListener(window,
    (request) => settings.requestOpen(request));

  const notices = [];
  const unsubscribeToasts = module.subscribeToasts((items) => {
    notices.push(...items);
  });

  t.after(() => {
    unsubscribeToasts();
    module.dismissAllToasts();
    delete globalThis.__modalChunkFail;
    delete globalThis.__modalChunkAttempts;
  });

  await router.push('/settings?page=speech.video');
  await router.isReady();

  const app = mount(module.App, { global: { plugins: [pinia, router] } });

  t.after(() => {
    removeGuard();
    removeListener();
    app.unmount();
    settings.dispose();
    delete globalThis.__modalAppAuth;
    delete globalThis.__modalAppCounts;
  });
  await flushPromises();

  assert.equal(router.currentRoute.value.path, '/board');
  assert.equal(settings.isOpen, false);
  globalThis.__modalChunkFail = true;
  globalThis.__modalChunkAttempts = 0;
  globalThis.__modalAppAuth.ready = true;
  globalThis.__modalAppAuth.authenticated = true;
  await flushPromises();
  await flushPromises();

  assert.equal(settings.isOpen, false, 'W4: отказ чанка освобождает открытие');
  assert.equal(notices.some((item) => item.id === 'section-load-failed'), true);
  assert.equal(globalThis.__modalChunkAttempts, 1);
  settings.requestOpen({ pageId: 'speech.video' });
  await flushPromises();
  await flushPromises();
  assert.equal(settings.isOpen, false);
  assert.equal(globalThis.__modalChunkAttempts, 2, 'Повторное открытие пробует загрузить заново');
  globalThis.__modalChunkFail = false;
  settings.requestOpen({ pageId: 'speech.video' });
  await flushPromises();
  await flushPromises();

  assert.equal(settings.isOpen, true);
  assert.equal(settings.pageId, 'speech.dictation');
  assert.equal(app.find('[data-modal-settings]').exists(), true);

  settings.cancel();
  await flushPromises();
  await router.push('/chats');
  await flushPromises();

  const counts = { ...globalThis.__modalAppCounts };
  const routeNode = app.find('[data-route-view]').element;

  await router.push('/settings');
  await flushPromises();
  await flushPromises();

  assert.equal(router.currentRoute.value.path, '/chats');
  assert.deepEqual(globalThis.__modalAppCounts, counts);
  assert.equal(app.find('[data-route-view]').element === routeNode, true);
  settings.query = 'текущий поиск';
  window.dispatchEvent(new CustomEvent('grigdesk:open-settings', { detail: { pageId: 'malicious' } }));
  await flushPromises();
  assert.equal(settings.query, 'текущий поиск');
  globalThis.__modalAppAuth.authenticated = false;
  await flushPromises();
  assert.equal(settings.isOpen, false);
  assert.equal(settings.pendingOpen, null);
});
