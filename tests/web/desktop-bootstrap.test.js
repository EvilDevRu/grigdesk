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
      './stores/auth.js': 'export const useAuthStore = () => ({});',
      './shared/apiClient.ts': `export const api = { url: (path) => path };
        export const isReportedApiError = () => false;
        export const setApiLogSink = () => {};`,
      './composables/useSse.ts': 'export const setSseLogSink = () => {};',
      './shared/webLogRuntime.ts': `export const createWebLogRuntime = () => ({
        attachAuthStore() {},
      });`,
      './ui.ts': `export const showToast = () => {}; export const getUiLayerDiagnostics = () => ({});
        export const subscribeUiLayerDiagnostics = () => {};`,
      './shared/desktopSettings.ts': `export const currentDesktopMode = () => 'main';
        export const installSettingsRouteGuard = () => () => {};
        export const openSettingsWindow = () => {};`,
    },
  });

  assert.deepEqual(calls, ['wake', 'notify']);
});
