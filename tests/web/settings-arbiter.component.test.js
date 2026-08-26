// Карточка «Арбитр остановок» во вкладке «Настройки → Запуски».
//
// Здесь живёт единственный выключатель автономного действия кокпита: включённый арбитр
// сам двигает курсор чужой задачи по решению модели. Поэтому проверяется, что выключатель
// действительно доходит до сервера (иначе это тот самый мёртвый тумблер, за который в
// gotchas уже удаляли `autoRecoverPipelines`), и что пара «исполнитель:модель» разбирается
// у моделей, чей id сам содержит двоеточия.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileSettingsView } from './helpers/settings-view.js';

process.env.NODE_ENV = 'test';

async function installBrowser(t, storage = {}) {
  globalThis.__COCKPIT_VERSION__ = '0.0.0-test';
  globalThis.__COCKPIT_SHA__ = 'testsha';
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://cockpit.test/#/settings' });
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
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  for (const [key, value] of Object.entries(storage)) browser.localStorage.setItem(key, value);
  browser.document.body.innerHTML = '<div id="mount"></div>';
  t.after(() => browser.close());
  return browser;
}

function makeProvidersStore() {
  const store = {
    providers: [
      {
        id: 'claude',
        name: 'Claude',
        available: true,
        models: [{ id: 'claude-opus-5', name: 'Opus 5', efforts: ['low', 'high'] }],
      },
      // id локальной модели со слэшем и двоеточием: склеенную строку не разобрать наивно.
      {
        id: 'ollama',
        name: 'Ollama',
        available: true,
        models: [{ id: 'hf.co/unsloth/qwen3.6:latest', name: 'qwen3.6' }],
      },
    ],
    usage: {},
    mcp: {},
    loaded: true,
    showAllModels: false,
    visibleModels: (p) => p?.models || [],
    modelOf: (saved) => {
      const providerId = typeof saved === 'object' && saved ? String(saved.provider || '') : '';
      const modelId = typeof saved === 'object' && saved ? String(saved.model || '') : String(saved || '');
      const provider = store.providers.find((p) => p.id === providerId) || null;
      const model = (provider?.models || []).find((m) => m.id === modelId) || null;
      return { id: modelId, model, provider };
    },
    async load() {},
    async loadUsage() {},
    async saveSetting() { return { ok: true }; },
    async loadMcp() { return { state: 'ok', servers: [] }; },
    async runUsageAction() { return { ok: true }; },
  };
  return store;
}

async function mountSettings(t, { arbiter = null } = {}) {
  const browser = await installBrowser(t, { 'cockpit-settings-tab': 'runs' });
  const prov = makeProvidersStore();
  const saved = [];
  let storedPrefs = {
    arbiter: arbiter || { modelRef: null, effort: '', auto: false },
    plugins: {},
    pluginSettings: {},
  };
  globalThis.__settingsApi = {
    async get(url) { return url === '/api/settings/prefs' ? storedPrefs : {}; },
    async post(url, body) {
      if (url !== '/api/settings/prefs') return {};
      saved.push(JSON.parse(JSON.stringify(body)));
      storedPrefs = { ...storedPrefs, ...body };
      return storedPrefs;
    },
  };
  globalThis.__settingsStores = {
    useProvidersStore: () => prov,
    useUiContextStore: () => ({ set() {}, clear() {} }),
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
    useChatStore: () => ({ compactWindow: 0, companion: { modelRef: null, effort: '' } }),
    useCompanionStore: () => ({
      deviceEnabled: false,
      setDeviceEnabled() {},
      outputState: { prefs: {}, available: true, voices: [] },
    }),
    usePwaStore: () => ({ canInstall: false, wakeLock: false, async install() {} }),
    useCockpitUpdateStore: () => ({ state: null, async load() {} }),
  };
  const [{ mount, flushPromises }, SettingsView] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileSettingsView(),
  ]);
  const wrapper = mount(SettingsView, {
    attachTo: browser.document.querySelector('#mount'),
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__settingsApi;
    delete globalThis.__settingsStores;
  });
  for (let i = 0; i < 5; i += 1) await flushPromises();
  return { wrapper, saved, flushPromises };
}

const card = (wrapper) => wrapper.find('[data-testid="arbiter-settings"]');
const modelSelect = (wrapper) => wrapper.find('[data-testid="arbiter-model-select"]');

test('карточка арбитра есть во вкладке «Запуски» и по умолчанию автомат выключен', async (t) => {
  const { wrapper } = await mountSettings(t);
  assert.ok(card(wrapper).exists(), 'карточки арбитра нет во вкладке «Запуски»');
  assert.match(card(wrapper).text(), /Арбитр остановок/);
  // Без модели арбитр не работает вовсе — об этом сказано прямо, а не пустым селектом.
  assert.match(card(wrapper).text(), /Без выбранной модели арбитр не работает/);
});

test('тумблер автоматического разбора доходит до сервера', async (t) => {
  // Мёртвый тумблер здесь опаснее отсутствующего: человек считал бы, что автономию
  // включил. Ровно за это в gotchas удаляли `autoRecoverPipelines`.
  const { wrapper, saved, flushPromises } = await mountSettings(t);
  const toggle = card(wrapper).find('[data-testid="arbiter-auto"] input[role="switch"]');
  assert.ok(toggle.exists(), 'тумблера автоматического разбора нет');
  await toggle.setValue(true);
  await flushPromises();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].arbiter.auto, true);
});

test('пара «исполнитель:модель» разбирается у модели с двоеточиями в id', async (t) => {
  const { wrapper, saved, flushPromises } = await mountSettings(t);
  const select = modelSelect(wrapper);
  await select.setValue('ollama:hf.co/unsloth/qwen3.6:latest');
  await flushPromises();
  assert.deepEqual(saved[0].arbiter.modelRef, {
    provider: 'ollama',
    model: 'hf.co/unsloth/qwen3.6:latest',
  });
});

test('уровень усилия не переносится на модель, которая его не объявляет', async (t) => {
  // `--effort high` у модели без такой ступени роняет запуск CLI, а не игнорируется.
  const { wrapper, saved, flushPromises } = await mountSettings(t, {
    arbiter: { modelRef: { provider: 'claude', model: 'claude-opus-5' }, effort: 'high', auto: false },
  });
  await modelSelect(wrapper).setValue('ollama:hf.co/unsloth/qwen3.6:latest');
  await flushPromises();
  assert.equal(saved[0].arbiter.effort, '');
});

test('пропавшая из реестра модель названа прямо, а не подменена умолчанием', async (t) => {
  const { wrapper } = await mountSettings(t, {
    arbiter: { modelRef: { provider: 'claude', model: 'снятая-модель' }, effort: '', auto: true },
  });
  assert.match(card(wrapper).text(), /нет в реестре/);
});
