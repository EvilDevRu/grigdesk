import { compileModule, webFile } from './compile-vue.js';

/**
 * Вход приложения выполняется с настоящим handler назначения main и закрытыми подменами UI.
 * Каждая проверка восстанавливает все глобалы и управляет завершением router.push.
 */
export async function mountDesktopEntry(t, options = {}) {
  const calls = [];
  const descriptors = new Map();
  const state = {
    mode: options.mode || 'page',
    router: options.router || { onError: () => () => {}, currentRoute: { value: { path: '/board' } } },
    ui: { opened: [], openTaskInline(id) {
      this.opened.push(id);
    } },
  };

  for (const [key, value] of Object.entries({
    __desktopBootstrap: calls,
    __surfaceNavigation: state,
    window: {
      sessionStorage: null,
      location: {
        origin: 'http://127.0.0.1:47101',
        href: 'http://127.0.0.1:47101/#/board',
        pathname: '/',
      },
    },
    location: {
      origin: 'http://127.0.0.1:47101',
      href: 'http://127.0.0.1:47101/#/board',
      pathname: '/',
    },
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

  await compileModule(webFile('src/main.ts'), {
    stubs: {
      vue: `export const createApp = () => ({ use() { return this; }, mount() {} });
        export const nextTick = async () => {};`,
      pinia: `export const createPinia = () => ({});`,
      'virtual:pwa-register': `export const registerSW = () => {
        globalThis.__desktopBootstrap.push('sw');
      };`,
      './router.ts': 'export const router = globalThis.__surfaceNavigation.router;',
      './App.vue': 'export default {};',
      './styles/index.css': '',
      './plugins/index.ts': '',
      './stores/device.ts': `export const useDeviceStore = () => ({
        initInstall: () => globalThis.__desktopBootstrap.push('install'),
        initWakeLock: () => globalThis.__desktopBootstrap.push('wake'),
        initNotifications: () => globalThis.__desktopBootstrap.push('notify'),
      });`,
      './stores/shell.ts': `export const useShellStore = () => ({
        initialized: true, present: true, status: 'online', showConnections: false,
        profile: { id: 'fixture' }, capabilities: ['windows'],
        snapshot: { rev: 1, status: 'online', profile: { id: 'fixture' } },
      });`,
      './stores/auth.ts': 'export const useAuthStore = () => ({ ready: true, authenticated: true });',
      './shared/apiClient.ts': `export const api = { url: (path) => path };
        export const isReportedApiError = () => false;
        export const setApiLogSink = () => {};`,
      './composables/useSse.ts': `export const setSseLogSink = () => {};
        export const configureSseRelay = () => {};`,
      './shared/desktopSettings.ts':
        'export const currentDesktopMode = () => globalThis.__surfaceNavigation.mode;',
      './shared/uiLocale.ts': 'export const bootstrapUiLocale = () => () => {};',
      './stores/ui.ts': 'export const useUiStore = () => globalThis.__surfaceNavigation.ui;',
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

  return {
    calls,
    router: state.router,
    ui: state.ui,
    win: window,
  };

}
