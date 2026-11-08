import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { after } from 'node:test';

import { compileModule, webFile } from './compile-vue.js';
import { createUiBrowser } from './ui-components.js';
import data from '../fixtures/settings-modal/data.json' with { type: 'json' };
import native from '../../fixtures/executor-settings/synthetic-catalog.json' with { type: 'json' };

// Компилятор сопоставляет заглушки с точным спецификатором импорта.
// Каждый путь к общему SSE получает один сетевой порт без настоящего EventSource.
const sseStub = `
  export const sseSubscribe = () => () => {};
  export const useSse = () => {};
  export const setSseEnabled = () => {};
  export const setSseLogSink = () => {};
  export const resetSseForTests = () => {};
  export const reconnectSse = () => {};
  export const sseRecovering = { value: false };
  export const sseRetryAt = { value: 0 };
`;
const sseStubs = Object.fromEntries([
  './composables/useSse.ts',
  '../composables/useSse.ts',
  '../../composables/useSse.ts',
  '../../../composables/useSse.ts',
  '../../composables/useSse',
].map((specifier) => [specifier, sseStub]));

let sharedWindow;

after(() => sharedWindow?.close());

/**
 * Смешанный файл browser/component-тестов готовит DOM до загрузки Vite и Vue.
 * Все монтирования используют это же окно: runtime-dom запоминает document при импорте.
 */
export async function prepareI18nWindow() {
  sharedWindow ||= await createUiBrowser();

  return sharedWindow;
}

/**
 * Адаптер, service, hosts и страницы входят в один bundle, сохраняя singleton локали.
 * Сетевой порт и router заменены; переводчик и UI остаются настоящими.
 */
export async function i18nComponent(t, options = {}) {
  const win = await prepareI18nWindow();

  win.document.body.innerHTML = '<div id="mount"></div>';
  win.localStorage.clear();

  const exists = await access(webFile('src/shared/uiLocale.ts')).then(() => true, () => false);

  assert.equal(exists, true, 'К2: адаптер языка интерфейса отсутствует');
  win.document.documentElement.lang = 'ru';
  Object.defineProperty(win.navigator, 'language', { value: 'ru-RU', configurable: true });
  options.prepareWindow?.(win);

  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, init = {}) => {
    const pathname = String(url);
    const route = new URL(pathname, 'https://grigdesk.test').pathname;

    calls.push({ pathname, ...init });

    if (options.fetch) {
      return options.fetch(url, init);
    }

    const responses = {
      '/api/settings/prefs': data.prefs,
      '/api/settings/speech': data.speech,
      '/api/providers': data.providers,
      '/api/plugins': data.plugins,
      '/api/plugin-catalog': {
        state: 'unconfigured',
        applicationVersion: '1.0.0',
        fetchedAt: null,
        catalog: null,
      },
      '/api/system/launcher': data.launcher,
      '/api/system/server': data.server,
      '/api/system/version': data.release,
      '/api/mobile/status': data.mobile,
      '/api/chat/sessions': data.sessions,
      '/api/chat/active': { active: [] },
      '/api/devices': { listener: { state: 'online', addresses: [] }, devices: [] },
      '/api/system/web-rebuild': { rebuild: null },
      '/api/plugin-installs/jobs/current': { job: null, recoveryError: null },
      '/api/settings/factory-debug': {
        configured: 'errors',
        effective: 'errors',
        source: 'global',
        expiresAt: 0,
      },
      ...options.responses,
    };

    if (/\/api\/providers\/[^/]+\/settings\/catalog$/.test(route)) {
      return new Response(JSON.stringify(native));
    }

    return new Response(JSON.stringify(responses[route] || {}), { status: 200 });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const [module, piniaApi, vue, utils] = await Promise.all([
    compileModule(webFile('../tests/web/helpers/i18nApp.ts'), {
      stubs: {
        '../router.ts': 'export const router = { push: async () => {} };',
        ...sseStubs,
      },
    }),
    import('../../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../../web/node_modules/vue/index.mjs'),
    import('../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
  ]);
  const pinia = piniaApi.createPinia();

  piniaApi.setActivePinia(pinia);

  const settings = module.useSettingsStore(pinia);
  const plugins = module.usePluginsStore(pinia);

  plugins.list = structuredClone(data.plugins.plugins);
  plugins.loaded = true;

  const bootstrap = typeof options.bootstrap === 'function'
    ? options.bootstrap(module, pinia) : options.bootstrap;
  const cleanup = await module.localeAdapter.bootstrapUiLocale({ window: win, ...bootstrap });

  t.after(() => {
    settings.dispose();
    cleanup?.();
  });

  return {
    win,
    module,
    settings,
    calls,
    pinia,
    ...vue,
    ...utils,
  };
}
