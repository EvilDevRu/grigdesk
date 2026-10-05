// Каталог плагинов («Настройки → Плагины»). Смысл проверки: модули разложены по РОДУ
// РАБОТЫ (общий контракт категорий), плитка включает плагин на месте, а описание и
// параметры открываются модалкой — второй колонки, которая пустует у большинства
// модулей, здесь больше нет.
import assert from 'node:assert/strict';
import test from 'node:test';

import { compilePluginsCatalog } from './helpers/plugins-catalog.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

const PLUGINS = [
  {
    // Сервер этой установки ещё не перезапущен: категории в ответе нет, и встроенный
    // модуль обязан встать в свою группу по запасной карте, а не уехать в «Прочее».
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
    category: 'dev',
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
    category: 'knowledge',
    description: 'Проверенные факты и продуктовые договорённости команды.',
    nav: { label: 'Знания', icon: 'knowledge' },
    needsRestart: false,
    settings: [],
    values: {},
    // Плагин с ручкой готовности: диалог рисует её по общему контракту.
    setup: { path: '/api/knowledge/setup' },
  },
  {
    id: 'secure-shell',
    name: 'SSH',
    version: '1.0.0',
    system: true,
    enabled: false,
    category: 'dev',
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
    // Системный модуль ещё не перезапущенного сервера: категории в ответе нет вовсе.
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
    // Чужая категория не заводит на экране свою группу — модуль уходит в «Прочее».
    id: 'team-alerts',
    name: 'Командные сигналы',
    version: '0.4.0',
    system: false,
    enabled: true,
    category: 'notifications',
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
    visibleModels: () => [],
    modelOf: () => ({ id: '', provider: null, model: null }),
  };
}

async function mountCatalog(t) {
  const prefix = `__pluginCatalog${mountNonce += 1}`;
  const browser = await installUiBrowser(t, 'http://cockpit.test/#/settings');

  const toggles = [];
  const saves = [];
  const setups = [];
  const list = structuredClone(PLUGINS);
  // Готовность как её отдаёт сервер: одно требование с кнопкой, одно готовое.
  const setupStatus = () => ({
    checkedAt: '2026-09-11T00:00:00.000Z',
    items: [
      {
        id: 'browser',
        title: 'Браузер записи',
        status: 'blocked',
        reason: 'Браузер записи не установлен.',
        action: { label: 'Установить Chromium', hint: 'Скачается около 170 МБ.' },
        job: null,
      },
      {
        id: 'storage',
        title: 'Хранилище',
        status: 'ready',
        reason: 'Каталог доступен для записи.',
        action: null,
        job: null,
      },
    ],
  });
  const plugins = {
    loaded: true,
    list,
    enabled: (id) => list.some((plugin) => plugin.id === id && plugin.enabled),
    byId: (id) => list.find((plugin) => plugin.id === id) || null,
    async load() {},
    async toggle(id, enabled) { toggles.push([id, enabled]); },
    async saveSettings(id, values) { saves.push([id, structuredClone(values)]); },
    async loadSetup() { return setupStatus(); },
    async runSetup(plugin, itemId) {
      setups.push([plugin.id, itemId]);

      const status = setupStatus();

      status.items[0].job = { state: 'running', label: 'скачиваю Chromium', error: null };

      return status;
    },
    async cancelSetup() { return setupStatus(); },
  };
  globalThis[`${prefix}Stores`] = {
    usePluginsStore: () => plugins,
    useProvidersStore: () => makeProvidersStore(),
  };

  const [vtu, PluginsCatalog] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compilePluginsCatalog({ prefix }),
  ]);
  const { mount, flushPromises } = vtu;
  // Модалка уезжает в <body> через Teleport: на время теста оставляем её на месте,
  // иначе до её полей пришлось бы ходить мимо wrapper, вручную по документу.
  const wrapper = mount(PluginsCatalog, {
    attachTo: browser.document.querySelector('#mount'),
    global: { stubs: { teleport: true } },
  });
  t.after(() => {
    wrapper.unmount();
    delete globalThis[`${prefix}Stores`];
  });
  for (let index = 0; index < 3; index += 1) await flushPromises();

  return { wrapper, flushPromises, toggles, saves, setups, browser, vtu };
}

function tileIds(wrapper) {
  return wrapper.findAll('.plugin-tile').map((tile) => tile.attributes('data-plugin-id'));
}

function groupIds(wrapper) {
  return wrapper.findAll('.plugin-group').map((group) => [
    group.attributes('data-category'),
    group.findAll('.plugin-tile').map((tile) => tile.attributes('data-plugin-id')),
  ]);
}

function configurableButton(wrapper) {
  const button = wrapper.findAll('.plugin-filter-group button')
    .find((candidate) => candidate.text().startsWith('С параметрами'));
  assert.ok(button, 'не найдена кнопка фильтра «С параметрами»');
  return button;
}

async function openPlugin({ wrapper, flushPromises }, id) {
  await wrapper.get(`[data-plugin-id="${id}"] .plugin-tile-open`).trigger('click');
  await flushPromises();

  const dialog = wrapper.find('.ui-dialog');
  assert.ok(dialog.exists(), `модалка плагина «${id}» не открылась`);

  return dialog;
}

test('плитки разложены по категориям в порядке общего контракта', async (t) => {
  const { wrapper } = await mountCatalog(t);

  assert.deepEqual(groupIds(wrapper), [
    ['work', ['video']],
    ['dev', ['code', 'secure-shell']],
    ['knowledge', ['knowledge']],
    ['other', ['legacy-reports', 'team-alerts']],
  ]);
  assert.equal(
    wrapper.get('button[aria-label="Только пользовательские плагины"]').text(),
    'Свои 1',
  );
  assert.equal(wrapper.get('[data-category="work"] h3').text(), 'Задачи и связь');
  assert.equal(wrapper.get('[data-plugin-id="video"] .plugin-tile-meta').text(), '1 параметр');
  assert.equal(
    wrapper.get('[data-plugin-id="code"] .plugin-tile-meta').text(),
    'без параметров',
  );
});

test('кнопка питания переключает именно свой плагин, не открывая модалку', async (t) => {
  const { wrapper, flushPromises, toggles } = await mountCatalog(t);
  const power = wrapper.get('[data-plugin-id="secure-shell"] .plugin-tile-power button');

  assert.equal(power.attributes('aria-label'), 'Включить SSH');
  await power.trigger('click');
  await flushPromises();

  assert.deepEqual(toggles, [['secure-shell', true]]);
  assert.equal(wrapper.find('.ui-dialog').exists(), false);
  assert.equal(
    Boolean(power.element.closest('.plugin-tile-open')),
    false,
    'кнопка питания лежит вне кнопки плитки: интерактив внутри интерактива недоступен',
  );
});

test('включённое состояние видно по самой кнопке питания, а не только по плитке', async (t) => {
  // Кнопка заменила тумблер, поэтому «горит/не горит» обязано читаться с неё самой:
  // залитая акцентом — модуль работает, тихая — выключен.
  const { wrapper } = await mountCatalog(t);
  const power = (id) => wrapper.get(`[data-plugin-id="${id}"] .plugin-tile-power button`);

  assert.equal(power('code').attributes('data-variant'), 'solid');
  assert.equal(power('code').attributes('data-tone'), 'accent');
  assert.equal(power('code').attributes('data-ui-tooltip'), 'Плагин включён');

  assert.equal(power('secure-shell').attributes('data-variant'), 'ghost');
  assert.equal(power('secure-shell').attributes('data-tone'), 'neutral');
  assert.equal(power('secure-shell').attributes('data-ui-tooltip'), 'Плагин выключен');
});

test('модалка открывается по плитке и сохраняет значения всех полей плагина', async (t) => {
  const mounted = await mountCatalog(t);
  const { wrapper, flushPromises, saves } = mounted;
  const dialog = await openPlugin(mounted, 'secure-shell');

  assert.match(dialog.text(), /SSH/);
  assert.match(dialog.get('.pd-state').text(), /Плагин выключен/);
  assert.match(dialog.get('.pd-state').text(), /параметры можно подготовить заранее/);
  assert.equal(dialog.get('.pd-category').text(), 'Разработка');

  const checkbox = dialog.get('.plugset input[type="checkbox"]');
  const number = dialog.get('.plugset input[type="number"]');
  assert.equal(checkbox.attributes('disabled'), undefined);
  assert.equal(number.attributes('disabled'), undefined);

  await checkbox.setValue(false);
  await number.setValue('96');
  await dialog.get('.plugin-save').trigger('click');
  await flushPromises();

  assert.deepEqual(saves, [[
    'secure-shell',
    { echoToTerminal: false, outputLimitKiB: 96 },
  ]]);
});

test('модалка называет ту же группу, в которой стоит плитка', async (t) => {
  const mounted = await mountCatalog(t);
  const dialog = await openPlugin(mounted, 'video');

  assert.equal(dialog.get('.pd-category').text(), 'Задачи и связь');
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
    assert.deepEqual(tileIds(wrapper), [expectedId], `не найден запрос «${query.trim()}»`);
  }
});

test('фильтр состояния пересекается с фильтром наличия параметров', async (t) => {
  const { wrapper, flushPromises } = await mountCatalog(t);

  await wrapper.get('.plugin-filter [data-option-value="disabled"]').trigger('click');
  await flushPromises();
  assert.deepEqual(groupIds(wrapper), [
    ['dev', ['secure-shell']],
    ['other', ['legacy-reports']],
  ]);

  await configurableButton(wrapper).trigger('click');
  await flushPromises();
  assert.deepEqual(tileIds(wrapper), ['secure-shell']);
});

test('пустая выдача предлагает reset, который очищает запрос и все фильтры', async (t) => {
  const { wrapper, flushPromises } = await mountCatalog(t);
  const search = wrapper.get('input[aria-label="Поиск плагинов"]');

  await wrapper.get('.plugin-filter [data-option-value="disabled"]').trigger('click');
  await configurableButton(wrapper).trigger('click');
  await search.setValue('такого плагина нет');
  await flushPromises();

  assert.equal(wrapper.findAll('.plugin-group').length, 0);
  assert.match(wrapper.get('.plugin-empty').text(), /Плагины не найдены/);
  await wrapper.get('.plugin-empty button').trigger('click');
  await flushPromises();

  assert.equal(search.element.value, '');
  assert.equal(
    wrapper.get('.plugin-filter [data-option-value="all"]').attributes('aria-pressed'),
    'true',
  );
  assert.equal(configurableButton(wrapper).attributes('aria-pressed'), 'false');
  assert.deepEqual(groupIds(wrapper), [
    ['work', ['video']],
    ['dev', ['code', 'secure-shell']],
    ['knowledge', ['knowledge']],
    ['other', ['legacy-reports', 'team-alerts']],
  ]);
});

test('готовность плагина показывает требования и ставит недостающее кнопкой', async (t) => {
  const mounted = await mountCatalog(t);
  const { flushPromises, setups } = mounted;
  const dialog = await openPlugin(mounted, 'knowledge');

  await flushPromises();

  const items = dialog.findAll('.pd-setup-list li');

  assert.equal(items.length, 2, 'каждое требование — своя строка');
  assert.match(dialog.get('.pd-setup .plugset-head').text(), /1 из 2 готово/);
  assert.equal(dialog.get('[data-setup-id="storage"] .pd-setup-dot').attributes('data-status'), 'ready');
  assert.equal(dialog.find('[data-setup-id="storage"] button').exists(), false, 'готовому кнопка не нужна');

  const install = dialog.get('[data-setup-id="browser"] button');

  assert.equal(install.text(), 'Установить Chromium');
  await install.trigger('click');
  await flushPromises();

  assert.deepEqual(setups, [['knowledge', 'browser']]);
  assert.match(dialog.get('[data-setup-id="browser"]').text(), /скачиваю Chromium/);
  assert.equal(dialog.get('[data-setup-id="browser"] button').text(), 'Отменить');
});

test('плагин без ручки готовности блока готовности не показывает', async (t) => {
  const mounted = await mountCatalog(t);
  const dialog = await openPlugin(mounted, 'code');

  assert.equal(dialog.find('.pd-setup').exists(), false);
});
