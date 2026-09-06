// Блок MCP-серверов в плашке исполнителя («Настройки → Исполнители»). Смысл проверки:
// человек чинит сервер по ПРИЧИНЕ отказа и по тому, где сервер объявлен, — значит область
// видимости, состояние и текст ошибки обязаны доезжать до экрана. Плюс блок ленивый: его
// нельзя дёргать для исполнителя, который про MCP вообще не сообщает.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compileSettingsView } from './helpers/settings-view.js';

process.env.NODE_ENV = 'test';

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

// Реестр с разными возможностями: три CLI сообщают о MCP, будущий адаптер — нет.
function providers() {
  return [
    {
      id: 'claude', name: 'Claude', vendor: 'Anthropic', available: true, installed: true,
      chatEnabled: true, trustedDirectories: true, mcp: true, models: [], settings: [],
    },
    {
      id: 'codex', name: 'GPT (Codex)', vendor: 'OpenAI', available: true, installed: true,
      chatEnabled: true, trustedDirectories: true, mcp: true, models: [], settings: [],
    },
    {
      id: 'kimi', name: 'Kimi', vendor: 'Moonshot', available: false, installed: true,
      chatEnabled: true, trustedDirectories: false, mcp: true, models: [], settings: [],
    },
    // Произвольный будущий адаптер доказывает, что строка собирается из реестра,
    // а не из списка известных названий в SettingsView.
    {
      id: 'local-next', name: 'Локальный Next', vendor: 'Test', available: true, installed: true,
      chatEnabled: true, trustedDirectories: true, models: [], settings: [],
    },
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
    useCompanionStore: () => ({ deviceEnabled: true, setDeviceEnabled() {} }),
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
  groups: [{
    id: 'account',
    label: 'claude.ai',
    hint: 'Коннекторы аккаунта: локально их живость не проверяется.',
  }],
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
      hint: 'Авторизуется в настройках коннекторов на claude.ai, не из Cockpit.',
    },
    // Коннектор аккаунта, про который локально известно только имя.
    { name: 'claude.ai Canva', target: '', scope: 'account', state: 'remote', detail: '' },
  ],
};

test('серверы сгруппированы по области видимости, причина отказа видна', async (t) => {
  const { wrapper } = await mountSettings(t, { mcpByProvider: { claude: REAL_MCP } });

  const groups = wrapper.findAll('.mcpgrp');
  assert.deepEqual(groups.map((g) => g.find('.mcpgrpttl').text()), [
    'Пользователь (2)', 'claude.ai (2)',
  ]);

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

test('опрашиваем всех установленных исполнителей с MCP capability', async (t) => {
  const { calls } = await mountSettings(t, { mcpByProvider: { claude: REAL_MCP } });

  assert.deepEqual(calls, [
    { id: 'claude', refresh: false },
    { id: 'codex', refresh: false },
    { id: 'kimi', refresh: false },
  ]);
});

test('«Обновить» перечитывает список мимо кэша', async (t) => {
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

test('блок MCP есть только у того, кто о MCP сообщает', async (t) => {
  const { wrapper } = await mountSettings(t, { mcpByProvider: { claude: REAL_MCP } });

  const slots = wrapper.findAll('.provider-mcp-slot');
  assert.deepEqual(
    slots.map((slot) => slot.attributes('data-provider-id')),
    ['claude', 'codex', 'kimi'],
    'у адаптера без mcpStatus пустой рамки на карточке не остаётся',
  );
  assert.ok(slots.every((slot) => slot.find('.mcpbtn').exists()));
  assert.equal(wrapper.findAll('.pvcard').length, 4);
});

test('Codex и Kimi показывают configured/disabled без ложного зелёного статуса', async (t) => {
  const { wrapper } = await mountSettings(t, {
    mcpByProvider: {
      codex: {
        state: 'ok',
        note: 'Живая проверка недоступна; показана конфигурация.',
        groups: [{ id: 'user', label: 'Codex' }],
        servers: [
          { name: 'figma', scope: 'user', state: 'configured', detail: '' },
          { name: 'old-server', scope: 'user', state: 'disabled', detail: 'Выключен.' },
        ],
      },
      kimi: {
        state: 'ok',
        note: 'Показана конфигурация mcp.json.',
        servers: [
          { name: 'docs', scope: 'project', state: 'configured', detail: '' },
        ],
      },
    },
  });

  const codex = wrapper.get('.provider-mcp-slot[data-provider-id="codex"]');
  assert.deepEqual(codex.findAll('.mcpst').map((node) => node.text()), ['Настроен', 'Выключен']);
  assert.ok(codex.findAll('.mcpdot').every((node) => node.classes().includes('idle')));
  assert.match(codex.text(), /Живая проверка недоступна/);

  const kimi = wrapper.get('.provider-mcp-slot[data-provider-id="kimi"]');
  assert.equal(kimi.get('.mcpgrpttl').text(), 'Проект (1)');
  assert.equal(kimi.get('.mcpst').text(), 'Настроен');
});

test('MCP-блок ограничен сверху и прокручивает только внутреннее содержимое', async () => {
  const source = await readFile(
    new URL('../../web/src/views/SettingsView.vue', import.meta.url),
    'utf8',
  );

  const pvmcp = source.match(/\.pvmcp\s*\{[^}]*\}/s)?.[0] || '';
  assert.match(pvmcp, /max-block-size:\s*220px/);
  assert.doesNotMatch(pvmcp, /(?<!max-)block-size:\s*220px/, 'высота не фиксируется');
  assert.match(source, /\.mcpbody\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(source, /\.mcpbody\s*\{[^}]*scrollbar-gutter:\s*stable/s);
});

test('доверенные каталоги перечисляют исполнителей по capability из реестра', async (t) => {
  const { wrapper } = await mountSettings(t);

  const text = wrapper.get('[data-testid="trusted-directory-providers"]').text();
  assert.match(text, /Claude/);
  assert.match(text, /GPT \(Codex\)/);
  assert.match(text, /Локальный Next/, 'новый адаптер появился без правки списка во Vue');
  assert.doesNotMatch(text, /Kimi/, 'исполнитель без capability не обещает доступ');
});
