// Блок MCP-серверов в плашке исполнителя («Настройки → Исполнители»). Смысл проверки:
// человек чинит сервер по ПРИЧИНЕ отказа и по тому, где сервер объявлен, — значит область
// видимости, состояние и текст ошибки обязаны доезжать до экрана. Плюс блок ленивый: его
// нельзя дёргать для исполнителя, который про MCP вообще не сообщает.
import assert from 'node:assert/strict';
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

      id: 'claude',
      name: 'Claude',
      vendor: 'Anthropic',
      available: true,
      installed: true,

      chatEnabled: true,
      mcp: true,
      models: [],
      settings: [],

    },
    {

      id: 'codex',
      name: 'GPT (Codex)',
      vendor: 'OpenAI',
      available: true,
      installed: true,

      chatEnabled: true,
      mcp: true,
      models: [],
      settings: [],

    },
    {

      id: 'kimi',
      name: 'Kimi',
      vendor: 'Moonshot',
      available: false,
      installed: true,

      chatEnabled: true,
      mcp: true,
      models: [],
      settings: [],

    },
    // Произвольный будущий адаптер доказывает, что строка собирается из реестра,
    // а не из списка известных названий в SettingsView.
    {

      id: 'local-next',
      name: 'Локальный Next',
      vendor: 'Test',
      available: true,
      installed: true,

      chatEnabled: true,
      models: [],
      settings: [],

    },
  ];
}

// Стор реактивный и опрос в нём асинхронный — как в настоящем: `loadMcp` сначала
// ЧИТАЕТ `mcp` (чтобы не потерять прошлый список на время загрузки), потом ждёт сеть
// и пишет ответ туда же. На плоском объекте без reactive Vue ничего не отслеживает, и
// зацикливание опроса такой стенд пропускает — проверять было бы нечего.
async function makeProvidersStore(mcpByProvider = {}, providerPatch = {}, extraProviders = []) {
  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const calls = [];
  const store = reactive({
    providers: [...providers(), ...extraProviders].map((p) => ({ ...p, ...(providerPatch[p.id] || {}) })),
    usage: {},
    mcp: {},
    loaded: true,
    showAllModels: false,
    updating: '',
    updateResults: {},
    visibleModels: () => [],
    async load() {},
    // Установку CLI держит стор — плашка настроек только читает его состояние.
    async updateCli(id) {
      store.updating = id;
      await Promise.resolve();
      store.updateResults = {
        ...store.updateResults,
        [id]: { type: 'ok', text: 'Уже последняя версия (1.0.0).', changed: false },
      };
      store.updating = '';
    },
    async loadUsage() {},
    async saveSetting() { return { ok: true }; },
    async loadMcp(id, refresh = false) {
      calls.push({ id, refresh });
      // Ограничитель стенда: зацикленный опрос иначе съел бы память до самого assert.
      if (calls.length > MCP_CALLS_LIMIT) return { state: 'ok', servers: [] };
      store.mcp = { ...store.mcp, [id]: { ...(store.mcp[id] || {}), loading: true } };
      await Promise.resolve();
      const data = mcpByProvider[id] || { state: 'ok', servers: [] };
      store.mcp = { ...store.mcp, [id]: { ...data, loading: false } };
      return data;
    },
    async runUsageAction() { return { ok: true }; },
  });
  return { store, calls };
}

// Потолок вызовов опроса на стенде: троих исполнителей хватает, чтобы отличить
// один заход от самоперезапуска, а память стенда остаётся целой.
const MCP_CALLS_LIMIT = 30;

/**
 * Настоящая страница монтируется с реактивным асинхронным источником MCP.
 * Дополнительные providers задаются отдельно и сохраняют исходный состав по умолчанию.
 */
async function mountSettings(t, { mcpByProvider, providerPatch, extraProviders } = {}) {
  const browser = await installBrowser(t, { 'cockpit-settings-tab': 'providers' });
  const { store: prov, calls } = await makeProvidersStore(mcpByProvider, providerPatch, extraProviders);
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
    useDeviceStore: () => ({ canInstall: false, wakeLock: false, async install() {} }),
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
  assert.equal(wrapper.findAll('.mcpname')[1].attributes('data-ui-tooltip'), 'docker run -i --rm bitrix-mcp');
});

test('опрашиваем всех установленных исполнителей с MCP capability', async (t) => {
  const { calls } = await mountSettings(t, { mcpByProvider: { claude: REAL_MCP } });

  assert.deepEqual(calls, [
    { id: 'claude', refresh: false },
    { id: 'codex', refresh: false },
    { id: 'kimi', refresh: false },
  ]);
});

// Опрос пишет ответ в тот же `prov.mcp`, который читает сам. Наблюдатель, собирающий
// зависимости автоматически, подписался бы на эту запись и перезапускался бы от своего
// же ответа: вкладка исполнителей молотила бы опрос без конца, живой health-check не
// успевал бы за 30-секундный таймаут запроса (панель показывала бы отказ), а очередь
// соединений браузера не пускала бы к серверу даже «Обновить» на карточке.
test('ответ опроса не перезапускает опрос', async (t) => {
  const { calls, flushPromises } = await mountSettings(t, { mcpByProvider: { claude: REAL_MCP } });

  for (let i = 0; i < 20; i += 1) await flushPromises();
  assert.deepEqual(calls.map((call) => call.id), ['claude', 'codex', 'kimi']);
});

test('«Обновить» перечитывает список мимо кэша', async (t) => {
  const { wrapper, calls } = await mountSettings(t, { mcpByProvider: { claude: REAL_MCP } });

  await wrapper.get('#provider-toggle-claude').trigger('click');
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

test('закрытые строки показывают сводки и связывают кнопки с панелями', async (t) => {
  const { wrapper } = await mountSettings(t, {
    providerPatch: { claude: { version: '2.1.9', models: [{ id: 'test-model' }] } },
  });

  const toggles = wrapper.findAll('[data-testid="provider-toggle"]');
  const panels = wrapper.findAll('[data-testid="provider-panel"]');

  assert.equal(toggles.length, 4);
  assert.ok(toggles.every((toggle) => toggle.attributes('aria-expanded') === 'false'));
  assert.ok(panels.every((panel) => !panel.isVisible()));
  assert.match(toggles[0].text(), /Claude.*2\.1\.9.*Модели: 1.*доступен/s);
  assert.match(toggles[2].text(), /Kimi.*недоступен/s);

  for (const [index, toggle] of toggles.entries()) {
    assert.equal(toggle.element.tagName, 'BUTTON');
    assert.equal(toggle.attributes('aria-controls'), panels[index].attributes('id'));
    assert.equal(panels[index].attributes('aria-labelledby'), toggle.attributes('id'));
  }
});

test('гармошка открывает одну панель и сохраняет настройки при повторном раскрытии', async (t) => {
  const { wrapper, calls } = await mountSettings(t, {
    providerPatch: { claude: { settings: [{
      id: 'endpoint',
      kind: 'text',
      label: 'Адрес сервера',
      value: 'http://localhost:11434',
    }] } },
  });
  const toggles = wrapper.findAll('[data-testid="provider-toggle"]');
  const panels = wrapper.findAll('[data-testid="provider-panel"]');

  await toggles[0].trigger('click');
  await panels[0].get('input').setValue('http://localhost:11435');
  assert.deepEqual(panels.map((panel) => panel.isVisible()), [true, false, false, false]);

  await toggles[1].trigger('click');
  assert.deepEqual(panels.map((panel) => panel.isVisible()), [false, true, false, false]);
  assert.deepEqual(toggles.map((toggle) => toggle.attributes('aria-expanded')),
    ['false', 'true', 'false', 'false']);

  await toggles[1].trigger('click');
  assert.ok(panels.every((panel) => !panel.isVisible()));

  await toggles[0].trigger('click');
  assert.equal(panels[0].isVisible(), true);
  assert.equal(panels[0].get('input').element.value, 'http://localhost:11435');
  assert.deepEqual(calls.map((call) => call.id), ['claude', 'codex', 'kimi']);
});

// Строка «доступно обновление» была только у отставшего исполнителя и сдвигала вниз
// содержимое одной карточки ряда. Индикатор — точка у имени, а текст живёт в тултипе.
test('версия CLI показана точкой у имени, а не строкой в фактах', async (t) => {
  const { wrapper } = await mountSettings(t, {
    providerPatch: {
      claude: { latest: '2.1.9', updateAvailable: true },
      codex: { latest: '0.152.1', updateAvailable: false },
    },
  });

  assert.equal(wrapper.findAll('.pvupd').length, 0, 'строка обновления осталась в фактах');

  const cards = wrapper.findAll('.pvcard');
  const dots = cards.map((card) => card.find('[data-testid="provider-update-dot"]'));
  assert.deepEqual(dots.map((dot) => dot.exists()), [true, true, false, false],
    'точка есть ровно там, где фоновая проверка назвала последнюю версию');
  assert.ok(dots[0].classes().includes('hot'), 'отставший CLI не выделен');
  assert.ok(!dots[1].classes().includes('hot'), 'свежий CLI показан тревожным цветом');

  // Текст ушёл в тултип — в самой карточке его быть не должно.
  assert.doesNotMatch(cards[0].text(), /Доступно обновление/);
  const tips = cards.map((card) => card.findComponent({ name: 'UiTooltip' }));
  assert.match(tips[0].props('text'), /Доступно обновление: 2\.1\.9/);
  assert.match(tips[1].props('text'), /Последняя версия \(0\.152\.1\)/);
});

test('итог обновления стоит у своей кнопки после настроек и диагностики', async (t) => {
  const { wrapper, flushPromises } = await mountSettings(t, {
    providerPatch: { claude: { canUpdate: true } },
  });

  const card = wrapper.findAll('.pvcard')[0];

  await card.get('[data-testid="provider-toggle"]').trigger('click');
  await card.get('.upd').trigger('click');
  await flushPromises();

  const result = card.get('[data-testid="provider-update-result"]');
  assert.ok(card.get('.pvfoot').element.contains(result.element), 'итог не в строке кнопки');
  assert.ok(
    card.get('.pvsections').element.nextElementSibling.matches('.pvfoot'),
    'футер должен следовать за настройками и диагностикой',
  );
});

test('общего списка доверенных каталогов больше нет в настройках', async (t) => {
  const { wrapper } = await mountSettings(t);

  assert.equal(wrapper.find('[data-testid="trusted-directory-providers"]').exists(), false);
  assert.doesNotMatch(wrapper.text(), /Доверенные каталоги/u);
});

const DEEPSEEK_EMPTY_TEXT = 'Для папки кокпита нет MCP-серверов, выбранных для запуска.';
const DEEPSEEK_NOTE = 'Показана конфигурация MCP для папки кокпита. '
  + 'В другой папке чата список может отличаться. '
  + 'Соединение не проверялось. Показаны только stdio-серверы, выбранные для запуска.';
const DEEPSEEK_MCP = {
  state: 'ok',
  note: DEEPSEEK_NOTE,
  emptyText: DEEPSEEK_EMPTY_TEXT,
  checkedAt: Date.parse('2026-10-01T10:20:30Z'),
  servers: [{
    name: 'Документы',
    target: '',
    scope: 'project',
    state: 'configured',
    detail: '',
  }],
};

/**
 * Недоступность модельного входа не препятствует чтению MCP установленного CLI.
 * Capability адаптера отдельно доказана серверным тестом настоящего DeepSeek.
 */
function deepSeekProvider(patch = {}) {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    vendor: 'DeepSeek',
    available: false,
    installed: true,
    chatEnabled: true,
    mcp: true,
    models: [],
    settings: [],
    ...patch,
  };
}

/**
 * Дополнительный provider после mount сохраняет исходные ожидания трёх запросов.
 * Явное чтение готовит его ответ; изменение реестра само по себе не запускает опрос.
 */
async function openDeepSeek(fixture, patch = {}) {
  fixture.prov.providers.push(deepSeekProvider(patch));
  await fixture.prov.loadMcp('deepseek');
  await fixture.flushPromises();
  await fixture.wrapper.get('#provider-toggle-deepseek').trigger('click');

  return fixture.wrapper.find('.provider-mcp-slot[data-provider-id="deepseek"]');
}

test('пустой MCP-ответ показывает emptyText адаптера и пояснение о папке кокпита', async (t) => {
  const fixture = await mountSettings(t, {
    mcpByProvider: { deepseek: { ...DEEPSEEK_MCP, servers: [] } },
  });
  const slot = await openDeepSeek(fixture);

  assert.equal(slot.isVisible(), true);
  assert.match(slot.text(), /Для папки кокпита нет MCP-серверов, выбранных для запуска\./);
  assert.doesNotMatch(slot.text(), /Серверов не настроено/);
  assert.equal(slot.get('.mcpnote').text(), DEEPSEEK_NOTE);
});

test('пустой MCP-ответ без emptyText сохраняет общий fallback', async (t) => {
  const { wrapper } = await mountSettings(t);
  const slot = wrapper.get('.provider-mcp-slot[data-provider-id="kimi"]');

  assert.match(slot.text(), /Серверов не настроено\./);
});

test('DeepSeek показывает configured и границы списка при недоступном модельном входе', async (t) => {
  const fixture = await mountSettings(t, { mcpByProvider: { deepseek: DEEPSEEK_MCP } });
  const slot = await openDeepSeek(fixture);

  assert.equal(slot.isVisible(), true);
  assert.equal(slot.get('.mcpgrpttl').text(), 'Проект (1)');
  assert.equal(slot.get('.mcpname').text(), 'Документы');
  assert.equal(slot.get('.mcpst').text(), 'Настроен');
  assert.equal(slot.get('.mcpdot').classes().includes('idle'), true);
  assert.equal(slot.get('.mcpname').attributes('title'), undefined);
  assert.equal(slot.get('.mcpnote').text(), DEEPSEEK_NOTE);
  assert.doesNotMatch(slot.text(), /Подключён|mcp login|cockpit-work|cockpit-perm|canary/);
});

test('имя DeepSeek MCP с HTML остаётся текстом без элементов и обработчиков', async (t) => {
  const name = '<img src=x onerror="alert(1)">';
  const fixture = await mountSettings(t, {
    mcpByProvider: {
      deepseek: { ...DEEPSEEK_MCP, servers: [{ ...DEEPSEEK_MCP.servers[0], name }] },
    },
  });
  const slot = await openDeepSeek(fixture);

  assert.equal(slot.get('.mcpname').text(), name);
  assert.equal(slot.find('img').exists(), false);
  assert.equal(slot.find('[onerror]').exists(), false);
});

test('частичный DeepSeek MCP-ответ показывает хорошую карточку и нейтральный note', async (t) => {
  const note = `${DEEPSEEK_NOTE} Конфигурация MCP для папки кокпита прочитана или проверена не полностью. `
    + 'Список может быть неполным; проверьте `.mcp.json` и команды запуска.';
  const fixture = await mountSettings(t, {
    mcpByProvider: { deepseek: { ...DEEPSEEK_MCP, note } },
  });
  const slot = await openDeepSeek(fixture);

  assert.equal(slot.get('.mcpname').text(), 'Документы');
  assert.equal(slot.get('.mcpnote').text(), note);
  assert.equal(slot.find('.msg.err').exists(), false);
});

test('полная ошибка DeepSeek MCP не выглядит успешным пустым списком', async (t) => {
  const error = 'Не удалось получить список MCP для папки кокпита. '
    + 'Проверьте `.mcp.json` и команды запуска.';
  const fixture = await mountSettings(t, {
    mcpByProvider: { deepseek: {
      state: 'error',
      error,
      servers: [],
    } },
  });
  const slot = await openDeepSeek(fixture);

  assert.equal(slot.get('.msg.err').text(), `Не удалось получить список: ${error}`);
  assert.equal(slot.find('.mcpgrp').exists(), false);
  assert.doesNotMatch(slot.text(), /Серверов не настроено|нет MCP-серверов, выбранных/);
});

test('refresh DeepSeek добавляет ровно один запрос, асинхронный ответ не создаёт цикл', async (t) => {
  const fixture = await mountSettings(t, { mcpByProvider: { deepseek: DEEPSEEK_MCP } });
  const slot = await openDeepSeek(fixture);
  const before = fixture.calls.length;

  await slot.get('.mcpbtn').trigger('click');

  for (let i = 0; i < 20; i += 1) {
    await fixture.flushPromises();
  }

  assert.equal(fixture.calls.length, before + 1);
  assert.deepEqual(fixture.calls.at(-1), { id: 'deepseek', refresh: true });
});

for (const patch of [{ installed: false }, { mcp: false }]) {
  test(`DeepSeek MCP скрыт при ${JSON.stringify(patch)}`, async (t) => {
    const fixture = await mountSettings(t, { mcpByProvider: { deepseek: DEEPSEEK_MCP } });
    const slot = await openDeepSeek(fixture, patch);

    assert.equal(slot.exists(), false);
  });
}

test('первый опрос включает установленный DeepSeek без модельной авторизации', async (t) => {
  const { calls, flushPromises } = await mountSettings(t, {
    extraProviders: [deepSeekProvider()],
    mcpByProvider: { deepseek: DEEPSEEK_MCP },
  });

  for (let i = 0; i < 20; i += 1) {
    await flushPromises();
  }

  assert.deepEqual(calls, ['claude', 'codex', 'kimi', 'deepseek'].map((id) => ({ id, refresh: false })));
});

test('первый опрос пропускает отсутствующий CLI DeepSeek', async (t) => {
  const { calls } = await mountSettings(t, {
    extraProviders: [deepSeekProvider({ installed: false })],
  });

  assert.deepEqual(calls.map((call) => call.id), ['claude', 'codex', 'kimi']);
});
