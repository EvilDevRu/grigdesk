// Блок MCP-серверов в плашке исполнителя («Настройки → Исполнители»). Смысл проверки:
// человек чинит сервер по ПРИЧИНЕ отказа и по тому, где сервер объявлен, — значит область
// видимости, состояние и текст ошибки обязаны доезжать до экрана. Плюс блок ленивый: его
// нельзя дёргать для исполнителя, который про MCP вообще не сообщает.
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
let compileNonce = 0;

async function compileSettingsView() {
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const source = await readFile(VIEW_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: VIEW_PATH });
  assert.deepEqual(errors, []);
  let code = compileScript(descriptor, {
    id: `data-v-settings-mcp-test-${compileNonce}`,
    inlineTemplate: true,
  }).content;
  const stubStore = (name) => `const ${name} = globalThis.__settingsStores.${name};`;
  code = code
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`)
    .replace("import { useRouter } from 'vue-router';", 'const useRouter = () => ({ push() {} });')
    .replace("import { api } from '../shared/api-client.js';", 'const api = globalThis.__settingsApi;')
    .replace("import { useProvidersStore } from '../stores/providers.js';", stubStore('useProvidersStore'))
    .replace("import { useUiContextStore } from '../stores/ui-context.js';", stubStore('useUiContextStore'))
    .replace(
      "import ProviderIcon from '../shared/ProviderIcon.vue';",
      "const ProviderIcon = { props: ['id'], template: '<i class=\"picon\"></i>' };",
    )
    .replace(
      "import ToggleSwitch from '../shared/ui/ToggleSwitch.vue';",
      "const ToggleSwitch = { props: ['modelValue'], template: '<button class=\"toggle\"></button>' };",
    )
    .replace(
      "import NumberField from '../shared/ui/NumberField.vue';",
      "const NumberField = { props: ['modelValue'], template: '<input class=\"numfield\" />' };",
    )
    .replace("import { useAuthStore } from '../stores/auth.js';", stubStore('useAuthStore'))
    .replace("import { usePluginsStore } from '../stores/plugins.js';", stubStore('usePluginsStore'))
    .replace("import { useChatStore } from '../stores/chat.js';", stubStore('useChatStore'))
    .replace("import { usePwaStore } from '../stores/pwa.js';", stubStore('usePwaStore'))
    .replace(
      /import \{\s*blockReasonLabel,\s*UPDATE_STAGE_LABELS,\s*useCockpitUpdateStore,\s*\} from '\.\.\/stores\/cockpit-update\.js';/,
      'const blockReasonLabel = (v) => String(v || ""); const UPDATE_STAGE_LABELS = {};'
      + ' const useCockpitUpdateStore = globalThis.__settingsStores.useCockpitUpdateStore;',
    )
    .replace(
      "import { confirmDialog } from '../shared/ui/confirm.js';",
      'const confirmDialog = async () => true;',
    )
    .replace("from '../shared/factory-debug.js';", `from "${FACTORY_DEBUG_URL}";`);
  const nonce = compileNonce++;
  return (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${nonce}`
  )).default;
}

async function installBrowser(t, storage = {}) {
  // Vite подставляет их на сборке (define в vite.config.js) — в node их надо объявить.
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

// Реестр из двух исполнителей: только один сообщает о MCP.
function providers() {
  return [
    { id: 'claude', name: 'Claude', vendor: 'Anthropic', available: true, installed: true, mcp: true, models: [], settings: [] },
    { id: 'codex', name: 'GPT (Codex)', vendor: 'OpenAI', available: true, installed: true, models: [], settings: [] },
    { id: 'kimi', name: 'Kimi', vendor: 'Moonshot', available: false, installed: false, mcp: true, models: [], settings: [] },
  ];
}

function makeProvidersStore(mcpByProvider = {}) {
  const calls = [];
  const store = {
    providers: providers(),
    usage: {},
    mcp: {},
    loaded: true,
    showAllModels: false,
    visibleModels: () => [],
    async load() {},
    async loadUsage() {},
    async saveSetting() { return { ok: true }; },
    async loadMcp(id, refresh = false) {
      calls.push({ id, refresh });
      const data = mcpByProvider[id] || { state: 'ok', servers: [] };
      store.mcp = { ...store.mcp, [id]: { ...data, loading: false } };
      return data;
    },
    async runUsageAction() { return { ok: true }; },
  };
  return { store, calls };
}

async function mountSettings(t, { mcpByProvider } = {}) {
  const browser = await installBrowser(t, { 'cockpit-settings-tab': 'providers' });
  const { store: prov, calls } = makeProvidersStore(mcpByProvider);
  // Настройки тянут полдюжины разделов сразу — все ответы пустые, кроме нужного нам реестра.
  globalThis.__settingsApi = {
    async get() { return {}; },
    async post() { return {}; },
  };
  globalThis.__settingsStores = {
    useProvidersStore: () => prov,
    useUiContextStore: () => ({ set() {}, clear() {} }),
    useAuthStore: () => ({ login: 'me', async logoutAll() {} }),
    usePluginsStore: () => ({ loaded: true, list: [], enabled: () => true, async load() {}, async setEnabled() {} }),
    useChatStore: () => ({ compactWindow: 0 }),
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
  return { wrapper, prov, calls, flushPromises };
}

const REAL_MCP = {
  state: 'ok',
  checkedAt: Date.parse('2026-08-07T10:20:30Z'),
  servers: [
    { name: 'playwright', target: 'node /home/u/cli.js', scope: 'user', state: 'ok', detail: 'Connected' },
    {
      name: 'bitrix',
      target: 'docker run -i --rm bitrix-mcp',
      scope: 'user',
      state: 'failed',
      detail: 'Failed to connect — -32000: MCP error -32000: Connection closed',
    },
    {
      name: 'claude.ai Google Drive',
      target: 'https://drivemcp.googleapis.com/mcp/v1',
      scope: 'account',
      state: 'needs-auth',
      detail: 'Needs authentication',
    },
    // Коннектор аккаунта, про который локально известно только имя.
    { name: 'claude.ai Canva', target: '', scope: 'account', state: 'remote', detail: '' },
  ],
};

test('серверы сгруппированы по области видимости, причина отказа видна', async (t) => {
  const { wrapper } = await mountSettings(t, { mcpByProvider: { claude: REAL_MCP } });

  const groups = wrapper.findAll('.mcpgrp');
  assert.deepEqual(groups.map((g) => g.find('.mcpgrpttl').text()), ['Свои (2)', 'claude.ai (2)']);

  const lines = wrapper.findAll('.mcpline');
  assert.deepEqual(lines.map((l) => l.find('.mcpname').text()),
    ['playwright', 'bitrix', 'claude.ai Google Drive', 'claude.ai Canva']);
  assert.deepEqual(lines.map((l) => l.find('.mcpst').text()),
    ['Подключён', 'Не подключился', 'Нужна авторизация', 'Включён на claude.ai']);
  // Цвет — часть ответа: отказ красный, «нужна авторизация» — предупреждение, а
  // непроверяемый локально коннектор аккаунта не тревожит цветом вовсе.
  assert.deepEqual(lines.map((l) => l.find('.mcpdot').classes().filter((c) => c !== 'mcpdot')),
    [['ok'], ['err'], ['warn'], ['idle']]);
  // Почему у секции claude.ai нет живых статусов — сказано прямо, а не додумывается.
  assert.match(groups[1].find('.mcpgrphint').text(), /локально их живость не проверяется/);

  const details = wrapper.findAll('.mcpdetail').map((d) => d.text());
  assert.ok(details.some((t2) => t2.includes('Connection closed')), 'причина отказа не показана');
  // Аккаунтный коннектор из кокпита не авторизуешь — подсказка обязана вести на claude.ai,
  // а не советовать `claude mcp login`, который для него ничего не сделает.
  assert.ok(details.some((t2) => t2.includes('claude.ai')), 'нет подсказки про коннекторы claude.ai');
  assert.ok(!details.some((t2) => t2.includes('claude mcp login claude.ai Google Drive')));
  // Команда запуска не в тексте, а в подсказке имени: длинный docker-вызов распёр бы плашку.
  assert.equal(wrapper.findAll('.mcpname')[1].attributes('title'), 'docker run -i --rm bitrix-mcp');
});

test('опрашиваем только тех, кто про MCP сообщает и доступен', async (t) => {
  const { calls } = await mountSettings(t, { mcpByProvider: { claude: REAL_MCP } });

  // codex не объявил mcpStatus, kimi не установлен — лишний health-check стоит секунд.
  assert.deepEqual(calls, [{ id: 'claude', refresh: false }]);
});

test('«Перепроверить» перечитывает мимо кэша', async (t) => {
  const { wrapper, calls } = await mountSettings(t, { mcpByProvider: { claude: REAL_MCP } });

  await wrapper.find('.mcpbtn').trigger('click');
  assert.deepEqual(calls.at(-1), { id: 'claude', refresh: true });
});

test('сбой опроса показывается человеку, а не выглядит пустым списком', async (t) => {
  const { wrapper } = await mountSettings(t, {
    mcpByProvider: { claude: { state: 'error', error: 'claude: command not found', servers: [] } },
  });

  const text = wrapper.find('.msg.err').text();
  assert.match(text, /command not found/);
  assert.equal(wrapper.findAll('.mcpgrp').length, 0);
});

test('исполнителя без MCP блок не показывает вовсе', async (t) => {
  const { wrapper } = await mountSettings(t, { mcpByProvider: { claude: REAL_MCP } });

  const titles = wrapper.findAll('.pvsetttl').map((n) => n.text());
  assert.equal(titles.filter((t2) => t2.includes('MCP-серверы')).length, 1);
});
