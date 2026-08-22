// Карточка «Голосовой компаньон» во вкладке «Настройки → Приложение».
//
// Смысл проверок: у компаньона три разных решения, и области у них РАЗНЫЕ. Показывать
// ли аватар и озвучивать ли ответы — выбор устройства (браузер), а чем он отвечает —
// server-owned настройка, общая для всех окон: разговор у компаньона один на все
// устройства, и один разговор не должен идти разными моделями.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';

const VIEW_PATH = fileURLToPath(new URL('../../web/src/views/SettingsView.vue', import.meta.url));
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;
const FACTORY_DEBUG_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/src/shared/factory-debug.js', import.meta.url),
)).href;
const COMPANION_RUN_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/src/shared/companion-run.js', import.meta.url),
)).href;
let compileNonce = 0;

// Node кэширует модуль по всему `data:`-URL, а две компиляции одного SFC дают побайтово
// равный текст — без хвоста-nonce второй тест работал бы со сторами первого.
async function compileSettingsView() {
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const source = await readFile(VIEW_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: VIEW_PATH });
  assert.deepEqual(errors, []);
  let code = compileScript(descriptor, {
    id: `data-v-companion-settings-${compileNonce}`,
    inlineTemplate: true,
  }).content;
  const stubStore = (name) => `const ${name} = globalThis.__settingsStores.${name};`;
  code = code
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`)
    .replace("import { useRouter } from 'vue-router';", 'const useRouter = () => ({ push() {} });')
    .replace("import { api } from '../shared/api-client.js';", 'const api = globalThis.__settingsApi;')
    .replace("import { useProvidersStore } from '../stores/providers.js';", stubStore('useProvidersStore'))
    .replace(
      "import { useUiContextSource } from '../composables/useUiContextSource.js';",
      'const useUiContextSource = () => ({ update() {}, focus() {}, blur() {}, dispose() {} });',
    )
    .replace(
      "import { useToolLauncher } from '../shared/tools/launcher.js';",
      'const useToolLauncher = () => ({ openTerminal() {} });',
    )
    .replace(
      "import ProviderIcon from '../shared/ProviderIcon.vue';",
      "const ProviderIcon = { props: ['id'], template: '<i class=\"picon\"></i>' };",
    )
    .replace(
      "import AccessOverview from './settings/AccessOverview.vue';",
      "const AccessOverview = { template: '<div class=\"access-overview-stub\"></div>' };",
    )
    // Тумблер настоящий по поведению, но без своей вёрстки: проверяем не его, а карточку.
    .replace(
      "import ToggleSwitch from '../shared/ui/ToggleSwitch.vue';",
      "const ToggleSwitch = { props: ['modelValue', 'label'], emits: ['update:modelValue'],"
      + " template: '<button class=\"toggle\" :aria-pressed=\"String(!!modelValue)\""
      + " @click=\"$emit(\\'update:modelValue\\', !modelValue)\">{{ label }}</button>' };",
    )
    .replace(
      "import NumberField from '../shared/ui/NumberField.vue';",
      "const NumberField = { props: ['modelValue'], template: '<input class=\"numfield\" />' };",
    )
    .replace("import { useAuthStore } from '../stores/auth.js';", stubStore('useAuthStore'))
    .replace("import { usePluginsStore } from '../stores/plugins.js';", stubStore('usePluginsStore'))
    .replace("import { useChatStore } from '../stores/chat.js';", stubStore('useChatStore'))
    .replace("import { useCompanionStore } from '../stores/companion.js';", stubStore('useCompanionStore'))
    .replace("import { usePwaStore } from '../stores/pwa.js';", stubStore('usePwaStore'))
    .replace(
      /import \{\s*blockReasonLabel,\s*UPDATE_STAGE_LABELS,\s*useCockpitUpdateStore,\s*\} from '\.\.\/stores\/cockpit-update\.js';/,
      'const blockReasonLabel = (v) => String(v || ""); const UPDATE_STAGE_LABELS = {};'
      + ' const useCockpitUpdateStore = globalThis.__settingsStores.useCockpitUpdateStore;',
    )
    .replace("import { confirmDialog } from '../shared/ui/confirm.js';", 'const confirmDialog = async () => true;')
    .replace(
      "import { useSse } from '../composables/useSse.js';",
      'const useSse = () => ({ connected: { value: false } });',
    )
    .replace("from '../shared/factory-debug.js';", `from "${FACTORY_DEBUG_URL}";`)
    // Настоящий модуль, а не заглушка: правило «полупустая ссылка = дефолт реестра»
    // должно проверяться тем же кодом, что резолвит модель перед ходом.
    .replace("from '../shared/companion-run.js';", `from "${COMPANION_RUN_URL}";`);
  const nonce = compileNonce++;
  return (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${nonce}`
  )).default;
}

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
        models: [
          { id: 'claude-opus-5', name: 'Opus 5', efforts: ['low', 'medium', 'high', 'xhigh'] },
          { id: 'claude-haiku-4-5', name: 'Haiku 4.5' }, // без своей лестницы уровней
        ],
      },
      // id локальной модели со слэшем и двоеточием: склеенную строку не разобрать наивно.
      { id: 'ollama', name: 'Ollama', available: true, models: [{ id: 'hf.co/unsloth/qwen3.6:latest', name: 'qwen3.6', efforts: ['low', 'high'] }] },
    ],
    usage: {},
    mcp: {},
    loaded: true,
    showAllModels: false,
    visibleModels: (p, selectedId = null) => (p?.models || [])
      .filter((m) => store.showAllModels || !m.extra || m.id === selectedId),
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

async function mountSettings(t, { companion = null, deviceEnabled = true } = {}) {
  const browser = await installBrowser(t, { 'cockpit-settings-tab': 'app' });
  const prov = makeProvidersStore();
  const saved = [];
  // Серверная сторона: prefs отвечают тем, что записали — как настоящий endpoint.
  let storedPrefs = { companion: companion || { modelRef: null, effort: '' }, plugins: {}, pluginSettings: {} };
  globalThis.__settingsApi = {
    async get(url) { return url === '/api/settings/prefs' ? storedPrefs : {}; },
    async post(url, body) {
      if (url !== '/api/settings/prefs') return {};
      saved.push(JSON.parse(JSON.stringify(body)));
      storedPrefs = { ...storedPrefs, ...body };
      return storedPrefs;
    },
  };
  const device = { deviceEnabled, setDeviceEnabled(v) { device.deviceEnabled = v; }, outputState: { prefs: {}, available: true, voices: [] } };
  const chatStore = { compactWindow: 0, companion: { modelRef: null, effort: '' } };
  globalThis.__settingsStores = {
    useProvidersStore: () => prov,
    useUiContextStore: () => ({ set() {}, clear() {} }),
    useAuthStore: () => ({ login: 'me', async logoutAll() {} }),
    usePluginsStore: () => ({ loaded: true, list: [], enabled: () => true, byId: () => null, async load() {}, async toggle() {}, async saveSettings() {} }),
    useChatStore: () => chatStore,
    useCompanionStore: () => device,
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
  return { wrapper, prov, saved, chatStore, device, flushPromises };
}

const card = (wrapper) => wrapper.find('[data-testid="companion-settings"]');
const modelSelect = (wrapper) => wrapper.find('[data-testid="companion-model-select"]');
const effortSelect = (wrapper) => wrapper.find('[data-testid="companion-effort-select"]');

test('COMP-SET-01: у компаньона своя карточка с видимым состоянием подключения', async (t) => {
  const { wrapper } = await mountSettings(t, { deviceEnabled: true });
  assert.ok(card(wrapper).exists(), 'карточки компаньона нет во вкладке «Приложение»');
  assert.match(card(wrapper).text(), /Голосовой компаньон/);
  const state = wrapper.find('[data-testid="companion-connection-state"]');
  assert.equal(state.text().trim(), 'Подключён');
  assert.ok(state.classes().includes('ok'));
});

test('COMP-SET-02: отключённый компаньон говорит об этом прямо, а не пустым тумблером', async (t) => {
  const { wrapper } = await mountSettings(t, { deviceEnabled: false });
  const state = wrapper.find('[data-testid="companion-connection-state"]');
  assert.equal(state.text().trim(), 'Отключён');
  assert.equal(state.classes().includes('ok'), false);
});

test('COMP-SET-03: тумблер подключения остаётся настройкой этого устройства', async (t) => {
  const { wrapper, device, saved, flushPromises } = await mountSettings(t, { deviceEnabled: true });
  await wrapper.find('[data-testid="companion-device-setting"] .toggle').trigger('click');
  await flushPromises();
  assert.equal(device.deviceEnabled, false);
  // Устройство не должно уносить свой выбор в общие prefs: на планшете компаньон свой.
  assert.deepEqual(saved, []);
});

test('COMP-SET-04: модель берётся из общего реестра и сохраняется парой «исполнитель + модель»', async (t) => {
  const { wrapper, saved, chatStore, flushPromises } = await mountSettings(t);
  const select = modelSelect(wrapper);
  assert.ok(select.exists(), 'селекта модели в карточке компаньона нет');
  const groups = select.findAll('optgroup').map((g) => g.attributes('label'));
  assert.deepEqual(groups, ['Claude', 'Ollama']);

  // id со слэшем и двоеточием обязан доехать целиком.
  await select.setValue('ollama:hf.co/unsloth/qwen3.6:latest');
  await flushPromises();
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].companion, {
    modelRef: { provider: 'ollama', model: 'hf.co/unsloth/qwen3.6:latest' },
    effort: '',
  });
  // Ход резолвит модель в браузере: стор чата обязан узнать новое значение сразу,
  // а не после F5 — иначе следующий ход уйдёт прежней моделью.
  assert.deepEqual(chatStore.companion.modelRef, {
    provider: 'ollama',
    model: 'hf.co/unsloth/qwen3.6:latest',
  });
});

test('COMP-SET-05: усилие появляется только у модели со своей лестницей', async (t) => {
  const { wrapper, flushPromises } = await mountSettings(t);
  assert.equal(effortSelect(wrapper).exists(), false, 'уровень не у чего применять без модели');

  await modelSelect(wrapper).setValue('claude:claude-haiku-4-5');
  await flushPromises();
  assert.equal(effortSelect(wrapper).exists(), false, 'у модели без лестницы контрола быть не должно');

  await modelSelect(wrapper).setValue('claude:claude-opus-5');
  await flushPromises();
  const levels = effortSelect(wrapper).findAll('option').map((o) => o.attributes('value'));
  assert.deepEqual(levels, ['', 'low', 'medium', 'high', 'xhigh']);
});

test('COMP-SET-06: усилие уезжает в ту же пару, пустое значит «умолчание исполнителя»', async (t) => {
  const { wrapper, saved, flushPromises } = await mountSettings(t, {
    companion: { modelRef: { provider: 'claude', model: 'claude-opus-5' }, effort: '' },
  });
  await effortSelect(wrapper).setValue('high');
  await flushPromises();
  assert.deepEqual(saved.at(-1).companion, {
    modelRef: { provider: 'claude', model: 'claude-opus-5' },
    effort: 'high',
  });

  await effortSelect(wrapper).setValue('');
  await flushPromises();
  assert.equal(saved.at(-1).companion.effort, '');
});

test('COMP-SET-07: смена модели не переносит уровень, которого у новой нет', async (t) => {
  const { wrapper, saved, flushPromises } = await mountSettings(t, {
    // `xhigh` есть у Opus 5 и нет у локальной модели: перенос уронил бы запуск CLI.
    companion: { modelRef: { provider: 'claude', model: 'claude-opus-5' }, effort: 'xhigh' },
  });
  await modelSelect(wrapper).setValue('ollama:hf.co/unsloth/qwen3.6:latest');
  await flushPromises();
  assert.equal(saved.at(-1).companion.effort, '');
});

test('COMP-SET-08: пропавшая из реестра модель названа, а не выдана за «по умолчанию»', async (t) => {
  const { wrapper } = await mountSettings(t, {
    companion: { modelRef: { provider: 'claude', model: 'claude-opus-4-1' }, effort: 'high' },
  });
  const select = modelSelect(wrapper);
  assert.equal(select.element.value, 'claude:claude-opus-4-1');
  assert.match(select.text(), /claude:claude-opus-4-1 — нет в реестре/);
  // Молчать нельзя: ход компаньона сейчас не уйдёт вовсе.
  assert.ok(wrapper.find('[data-testid="companion-model-lost"]').exists());
});

test('COMP-SET-09: уровень, пропавший у модели, показан пометкой, а не молча стёрт', async (t) => {
  const { wrapper } = await mountSettings(t, {
    companion: { modelRef: { provider: 'ollama', model: 'hf.co/unsloth/qwen3.6:latest' }, effort: 'xhigh' },
  });
  const select = effortSelect(wrapper);
  assert.equal(select.element.value, 'xhigh');
  assert.match(select.text(), /xhigh — нет у этой модели/);
});
