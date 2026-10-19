import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, webFile } from './helpers/compile-vue.js';

test('bootstrap запускает возможности устройства без регистрации SW и установки PWA', async (t) => {
  const calls = [];
  const descriptors = new Map();

  for (const [key, value] of Object.entries({
    __desktopBootstrap: calls,
    window: { sessionStorage: null },
    document: {},
    navigator: {},
  })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }

  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  await compileModule(webFile('src/main.js'), {
    stubs: {
      vue: `export const createApp = () => ({ use() { return this; }, mount() {} });`,
      pinia: `export const createPinia = () => ({});`,
      'virtual:pwa-register': `export const registerSW = () => {
        globalThis.__desktopBootstrap.push('sw');
      };`,
      './router.js': `export const router = { onError: () => () => {} };`,
      './App.vue': 'export default {};',
      './styles/index.css': '',
      './plugins/index.ts': '',
      './stores/device.js': `export const useDeviceStore = () => ({
        initInstall: () => globalThis.__desktopBootstrap.push('install'),
        initWakeLock: () => globalThis.__desktopBootstrap.push('wake'),
        initNotifications: () => globalThis.__desktopBootstrap.push('notify'),
      });`,
      './stores/shell.ts': 'export const useShellStore = () => ({ showConnections: false });',
      './stores/auth.js': 'export const useAuthStore = () => ({});',
      './shared/apiClient.ts': `export const api = { url: (path) => path };
        export const isReportedApiError = () => false;
        export const setApiLogSink = () => {};`,
      './composables/useSse.ts': 'export const setSseLogSink = () => {};',
      './shared/webLogRuntime.ts': `export const createWebLogRuntime = () => ({
        attachAuthStore() {},
      });`,
      './ui.ts': `export const showToast = () => {}; export const getUiLayerDiagnostics = () => ({});
        export const setUiDownloadAdapter = () => globalThis.__desktopBootstrap.push('download');
        export const subscribeUiLayerDiagnostics = () => {};`,
      './stores/settings.ts': 'export const useSettingsStore = () => ({});',
      './shared/sectionLoadFailure.ts': 'export const showSectionLoadFailure = () => {};',
      './shared/settingsNavigation.ts': `export const installSettingsRouteGuard = () => () => {};
        export const installSettingsOpenListener = () => () => {};`,
      './shared/saveFile.ts': `export const canSaveInShell = () => false;
        export const saveLinkedFile = async () => {};`,
      './shared/backAction.ts': `export const installBackAction = () => {
        globalThis.__desktopBootstrap.push('back');
        return () => {};
      };`,
      './shared/appViewport.ts': `export const installAppViewport = () => {
        globalThis.__desktopBootstrap.push('viewport');
        return () => {};
      };`,

    },
  });

  assert.deepEqual(calls, ['download', 'back', 'viewport', 'wake', 'notify']);
});
