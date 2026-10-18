// Тумблер «Продолжать ход сам после обрыва связи» в карточке «Настройки → Запуски».
//
// Смысл проверки: автопродолжение тратит запросы к модели без спроса, поэтому человек
// обязан видеть его состояние и уметь выключить — и выключение не должно выдаваться
// за сохранённое, если сервер запись отверг.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileSettingsView } from './helpers/settings-view.js';

process.env.NODE_ENV = 'test';

// Поднимает happy-dom и раздаёт его узлы в globalThis: компонент настроек
// рассчитывает на браузерные глобали (см. соседний тест живых сессий).
async function installBrowser(t, storage = {}) {
  globalThis.__GRIGDESK_VERSION__ = '0.0.0-test';
  globalThis.__GRIGDESK_SHA__ = 'testsha';

  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://grigdesk.test/#/settings' });

  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }

  for (const [key, value] of Object.entries(storage)) {
    browser.localStorage.setItem(key, value);
  }

  browser.document.body.innerHTML = '<div id="mount"></div>';
  t.after(() => browser.close());

  return browser;
}

/**
 * Монтирует раздел «Запуски» с управляемым транспортом настроек: тест видит только
 * заданный снимок prefs и записывает каждый POST, а работающий сервер не читается.
 */
async function mountRuns(t, { prefs, postError = null } = {}) {
  const browser = await installBrowser(t, { 'grigdesk-settings-tab': 'runs' });
  const writes = [];
  const snapshot = prefs || {
    chatLiveSessions: true,
    providerSettings: {},
  };

  globalThis.__settingsApi = {
    /**
     * Снимок настроек и процессов приходит из управляемого транспорта: тест видит
     * ровно заданное состояние и не читает работающий сервер.
     */
    async get(path) {
      if (path === '/api/chat/sessions') {
        return {
          enabled: true,
          maxSessions: 4,
          idleMs: 1,
          sessions: [],
        };
      }

      if (path === '/api/settings/prefs') {
        return snapshot;
      }

      return {};
    },
    async post(path, body) {
      if (postError) {
        throw new Error(postError);
      }

      writes.push([path, body]);

      return {
        chatLiveSessions: true,
        providerSettings: {},
        ...body,
      };
    },
    async del() {
      return {
        ok: true,
        closed: 0,
        skipped: 0,
        forced: false,
      };
    },
  };
  globalThis.__settingsConfirm = async () => true;
  globalThis.__settingsStores = {
    useProvidersStore: () => ({
      providers: [],
      usage: {},
      mcp: {},
      loaded: true,
      showAllModels: false,
      visibleModels: () => [],
      modelOf: () => ({
        id: '',
        model: null,
        provider: null,
      }),
      async load() {},
      async loadUsage() {},
      async saveSetting() {
        return { ok: true };
      },
      async loadMcp() {
        return { state: 'ok', servers: [] };
      },
      async runUsageAction() {
        return { ok: true };
      },
    }),
    useAuthStore: () => ({ login: 'me', async logoutAll() {} }),
    usePluginsStore: () => ({
      loaded: true,
      list: [],
      enabled: () => true,
      byId: () => null,
      async load() {},
      async toggle() {},
      async saveSettings() {},
    }),
    useChatStore: () => ({ compactWindow: 0, setActive() {} }),
    useDeviceStore: () => ({
      canInstall: false,
      wakeLock: false,
      async install() {},
    }),
    useGrigDeskUpdateStore: () => ({ state: null, async load() {} }),
  };

  const [{ mount, flushPromises }, SettingsView] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileSettingsView({ confirm: true }),
  ]);
  const wrapper = mount(SettingsView, {
    attachTo: browser.document.querySelector('#mount'),
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__settingsApi;
    delete globalThis.__settingsStores;
    delete globalThis.__settingsConfirm;
  });

  for (let i = 0; i < 6; i += 1) {
    await flushPromises();
  }

  return {
    browser,
    wrapper,
    writes,
    flushPromises,
  };
}

test('тумблер автопродолжения показывает состояние и сохраняет выбор', async (t) => {
  const { wrapper, writes, flushPromises } = await mountRuns(t);
  const block = wrapper.get('[data-testid="runs-auto-continue"]');

  assert.match(block.text(), /Продолжать ход сам после обрыва связи/u);

  const checkbox = block.get('input[type="checkbox"]');

  assert.equal(checkbox.element.checked, true, 'по умолчанию автопродолжение включено');

  await checkbox.setValue(false);
  await flushPromises();

  assert.deepEqual(writes, [['/api/settings/prefs', { chatAutoContinue: false }]]);
});

test('без ключа в prefs тумблер включён', async (t) => {
  const { wrapper } = await mountRuns(t, {
    prefs: { chatLiveSessions: true, providerSettings: {} },
  });
  const checkbox = wrapper.get('[data-testid="runs-auto-continue"] input[type="checkbox"]');

  assert.equal(checkbox.element.checked, true, 'отсутствие ключа означает включённую настройку');
});

test('ошибка сохранения не выдаётся за успешную', async (t) => {
  const { wrapper, flushPromises } = await mountRuns(t, { postError: 'Сервер недоступен' });
  const checkbox = wrapper.get('[data-testid="runs-auto-continue"] input[type="checkbox"]');

  await checkbox.setValue(false);
  await flushPromises();

  const text = wrapper.text();

  assert.match(text, /Сервер недоступен/u, 'отказ показан человеку');
  assert.equal(text.includes('Сохранено.'), false, 'несохранённый выбор не объявлен успешным');
  assert.ok(
    wrapper.find('[data-testid="runs-live-card"] input[type="checkbox"]').exists(),
    'тумблер живых агентов на месте',
  );
});
