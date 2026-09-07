import assert from 'node:assert/strict';
import test from 'node:test';

import { compileSettingsView } from './helpers/settings-view.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

const PLUGINS = [
  {
    id: 'video',
    name: 'Видео и встречи',
    version: '1.0.0',
    system: true,
    enabled: true,
    description: 'Расшифровка записей и подготовка итогов совещаний.',
    nav: { label: 'Видео', icon: 'video' },
    needsRestart: false,
    settings: [{
      key: 'makeSummary',
      label: 'Готовить резюме',
      type: 'checkbox',
      default: true,
    }],
    values: { makeSummary: true },
  },
  {
    id: 'code',
    name: 'Код',
    version: '1.0.0',
    system: true,
    enabled: true,
    description: 'Работа с изменениями в репозитории.',
    nav: { label: 'Код', icon: 'code' },
    needsRestart: false,
    settings: [],
    values: {},
  },
  {
    id: 'knowledge',
    name: 'Знания',
    version: '1.0.0',
    system: true,
    enabled: true,
    description: 'Проверенные факты и продуктовые договорённости команды.',
    nav: { label: 'Знания', icon: 'knowledge' },
    needsRestart: false,
    settings: [],
    values: {},
  },
  {
    id: 'secure-shell',
    name: 'SSH',
    version: '1.0.0',
    system: true,
    enabled: false,
    description: 'Команды на удалённых машинах под надзором человека.',
    nav: { label: 'SSH', icon: 'terminal' },
    needsRestart: false,
    settings: [
      {
        key: 'echoToTerminal',
        label: 'Дублировать команды в терминал',
        type: 'checkbox',
        default: true,
      },
      {
        key: 'outputLimitKiB',
        label: 'Лимит вывода, KiB',
        type: 'number',
        min: 4,
        max: 1024,
        step: 4,
        default: 64,
      },
    ],
    values: { echoToTerminal: true, outputLimitKiB: 64 },
  },
  {
    id: 'legacy-reports',
    name: 'Старые отчёты',
    version: '1.0.0',
    system: true,
    enabled: false,
    description: 'Архивный экспорт отчётов.',
    nav: null,
    needsRestart: false,
    settings: [],
    values: {},
  },
  {
    id: 'team-alerts',
    name: 'Командные сигналы',
    version: '0.4.0',
    system: false,
    enabled: true,
    description: 'Пользовательские уведомления о важных событиях.',
    nav: null,
    needsRestart: true,
    settings: [],
    values: {},
  },
];

let mountNonce = 0;

function makeProvidersStore() {
  return {
    providers: [],
    usage: {},
    mcp: {},
    loaded: true,
    showAllModels: false,
    visibleModels: () => [],
    modelOf: () => ({ id: '', provider: null, model: null }),
    async load() {},
    async loadUsage() {},
    async loadMcp() { return { state: 'ok', servers: [] }; },
    async runUsageAction() { return { ok: true }; },
  };
}

async function mountCatalog(t) {
  const prefix = `__pluginCatalog${mountNonce += 1}`;
  const browser = await installUiBrowser(t, 'http://cockpit.test/#/settings');
  browser.localStorage.setItem('cockpit-settings-tab', 'plugins');
  globalThis.__COCKPIT_VERSION__ = '0.0.0-test';
  globalThis.__COCKPIT_SHA__ = 'testsha';

  const toggles = [];
  const saves = [];
  const list = structuredClone(PLUGINS);
  const plugins = {
    loaded: true,
    list,
    enabled: (id) => list.some((plugin) => plugin.id === id && plugin.enabled),
    byId: (id) => list.find((plugin) => plugin.id === id) || null,
    async load() {},
    async toggle(id, enabled) { toggles.push([id, enabled]); },
    async saveSettings(id, values) {
      saves.push([id, structuredClone(values)]);
    },
  };
  globalThis[`${prefix}Api`] = {
    async get() { return {}; },
    async post() { return {}; },
  };
  globalThis[`${prefix}Stores`] = {
    useProvidersStore: () => makeProvidersStore(),
    useUiContextStore: () => ({ set() {}, clear() {} }),
    useAuthStore: () => ({ login: 'tester', async logoutAll() {} }),
    usePluginsStore: () => plugins,
    useChatStore: () => ({ compactWindow: 0 }),
    useCompanionStore: () => ({ deviceEnabled: true, setDeviceEnabled() {} }),
    usePwaStore: () => ({ canInstall: false, wakeLock: false, async install() {} }),
    useCockpitUpdateStore: () => ({ state: null, status: null, async load() {} }),
  };

  const [{ mount, flushPromises }, SettingsView] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileSettingsView({ prefix }),
  ]);
  const wrapper = mount(SettingsView, {
    attachTo: browser.document.querySelector('#mount'),
    global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  });
  t.after(() => {
    wrapper.unmount();
    delete globalThis[`${prefix}Api`];
    delete globalThis[`${prefix}Stores`];
    delete globalThis.__COCKPIT_VERSION__;
    delete globalThis.__COCKPIT_SHA__;
  });
  for (let index = 0; index < 5; index += 1) await flushPromises();

  return { wrapper, flushPromises, toggles, saves };
}

function catalogIds(wrapper) {
  return wrapper.findAll('.plugin-catalog-item')
    .map((row) => row.attributes('data-plugin-id'));
}

function configurableButton(wrapper) {
  const button = wrapper.findAll('.plugin-filter-group button')
    .find((candidate) => candidate.text().startsWith('С параметрами'));
  assert.ok(button, 'не найдена кнопка фильтра «С параметрами»');
  return button;
}

test('каталог показывает много строк, один detail и переключает именно выбранный плагин', async (t) => {
  const { wrapper, flushPromises, toggles } = await mountCatalog(t);

  assert.deepEqual(catalogIds(wrapper), PLUGINS.map((plugin) => plugin.id));
  assert.equal(
    wrapper.get('button[aria-label="Только пользовательские плагины"]').text(),
    'Свои 1',
  );
  assert.equal(wrapper.findAll('.plugin-detail').length, 1);
  assert.equal(wrapper.get('.plugin-detail').attributes('aria-label'), 'Плагин Видео и встречи');

  const sshRow = wrapper.get('[data-plugin-id="secure-shell"]');
  await sshRow.get('.ui-selectable-row__primary').trigger('click');
  await flushPromises();

  assert.equal(wrapper.findAll('.plugin-detail').length, 1);
  assert.equal(wrapper.get('.plugin-detail').attributes('aria-label'), 'Плагин SSH');
  assert.equal(sshRow.get('.ui-selectable-row__primary').attributes('aria-selected'), 'true');

  const pluginSwitch = wrapper.get('.plugin-detail input[role="switch"]');
  assert.equal(pluginSwitch.attributes('aria-label'), 'Включить SSH');
  await pluginSwitch.setValue(true);
  await flushPromises();

  assert.deepEqual(toggles, [['secure-shell', true]]);
});

test('поиск находит по name, id и description без учёта регистра и внешних пробелов', async (t) => {
  const { wrapper, flushPromises } = await mountCatalog(t);
  const search = wrapper.get('input[aria-label="Поиск плагинов"]');

  for (const [query, expectedId] of [
    ['  вИдЕо И ВСТРЕЧИ  ', 'video'],
    ['  SECURE-SHELL  ', 'secure-shell'],
    ['  ПРОВЕРЕННЫЕ ФАКТЫ  ', 'knowledge'],
  ]) {
    await search.setValue(query);
    await flushPromises();
    assert.deepEqual(catalogIds(wrapper), [expectedId], `не найден запрос «${query.trim()}»`);
  }
});

test('фильтр состояния пересекается с фильтром наличия параметров', async (t) => {
  const { wrapper, flushPromises } = await mountCatalog(t);

  await wrapper.get('.plugin-filter [data-option-value="disabled"]').trigger('click');
  await flushPromises();
  assert.deepEqual(catalogIds(wrapper), ['secure-shell', 'legacy-reports']);

  await configurableButton(wrapper).trigger('click');
  await flushPromises();
  assert.deepEqual(catalogIds(wrapper), ['secure-shell']);
  assert.equal(wrapper.get('.plugin-detail').attributes('aria-label'), 'Плагин SSH');
});

test('выключенный плагин настраивается, а save отправляет значения всех его полей', async (t) => {
  const { wrapper, flushPromises, saves } = await mountCatalog(t);

  await wrapper.get('[data-plugin-id="secure-shell"] .ui-selectable-row__primary').trigger('click');
  await flushPromises();

  assert.match(wrapper.get('.plugin-detail-state').text(), /Плагин выключен/);
  assert.match(wrapper.get('.plugin-detail-state').text(), /параметры можно подготовить заранее/);
  const checkbox = wrapper.get('.plugset input[type="checkbox"]');
  const number = wrapper.get('.plugset input[type="number"]');
  assert.equal(checkbox.attributes('disabled'), undefined);
  assert.equal(number.attributes('disabled'), undefined);

  await checkbox.setValue(false);
  await number.setValue('96');
  await wrapper.get('.plugin-save').trigger('click');
  await flushPromises();

  assert.deepEqual(saves, [[
    'secure-shell',
    { echoToTerminal: false, outputLimitKiB: 96 },
  ]]);
});

test('пустая выдача предлагает reset, который очищает запрос и все фильтры', async (t) => {
  const { wrapper, flushPromises } = await mountCatalog(t);
  const search = wrapper.get('input[aria-label="Поиск плагинов"]');

  await wrapper.get('.plugin-filter [data-option-value="disabled"]').trigger('click');
  await configurableButton(wrapper).trigger('click');
  await search.setValue('такого плагина нет');
  await flushPromises();

  assert.equal(wrapper.findAll('.plugin-detail').length, 0);
  assert.match(wrapper.get('.plugin-empty').text(), /Плагины не найдены/);
  await wrapper.get('.plugin-empty button').trigger('click');
  await flushPromises();

  assert.equal(search.element.value, '');
  assert.equal(
    wrapper.get('.plugin-filter [data-option-value="all"]').attributes('aria-pressed'),
    'true',
  );
  assert.equal(configurableButton(wrapper).attributes('aria-pressed'), 'false');
  assert.deepEqual(catalogIds(wrapper), PLUGINS.map((plugin) => plugin.id));
  assert.equal(wrapper.findAll('.plugin-detail').length, 1);
});
