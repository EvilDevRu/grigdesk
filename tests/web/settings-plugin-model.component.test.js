// Настройка плагина типа `model` («Настройки → Плагины»). Смысл проверки: модель для
// автомата общего Inbox человек выбирает ИЗ ОБЩЕГО РЕЕСТРА исполнителей кокпита, а не из
// зашитого в код списка вендора, и хранится выбор парой «исполнитель + модель». Склеенной
// строкой её не разобрать: у локальных исполнителей id модели сам бывает со слэшами и
// двоеточиями (`hf.co/user/repo:tag`) — разбор такой строки молча увёл бы ход не туда.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { SYSTEM } from '../../server/src/lib/plugins-registry.js';
import { webFile } from './helpers/compile-vue.js';
import { compileSettingsView } from './helpers/settings-view.js';

process.env.NODE_ENV = 'test';

const VIEW_PATH = webFile('src/views/SettingsView.vue');

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

// Реестр как в жизни: облачный исполнитель со «свежей» и «старой» моделями плюс локальный,
// у которого id модели с точкой, двоеточием и слэшем.
function providers() {
  return [
    {
      id: 'claude',
      name: 'Claude',
      available: true,
      capabilities: { scopedWorkspace: true },
      // Лестницы эффорта у моделей РАЗНЫЕ — на этом и держится проверка переноса.
      models: [
        { id: 'claude-opus-5', name: 'Opus 5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { id: 'claude-opus-4-8', name: 'Opus 4.8', extra: true, efforts: ['low', 'high'] },
      ],
    },
    {
      id: 'ollama',
      name: 'Ollama',
      available: true,
      capabilities: { scopedWorkspace: false },
      // У локального эффорт бинарный: `xhigh` ему передать нельзя.
      models: [{ id: 'hf.co/unsloth/qwen3.6:latest', name: 'qwen3.6 (hf)', efforts: ['low', 'high'] }],
    },
    {
      id: 'codex',
      name: 'GPT (Codex)',
      available: false,
      capabilities: { scopedWorkspace: true },
      models: [{ id: 'gpt-5.6', name: 'GPT-5.6' }],
    },
  ];
}

function makeProvidersStore() {
  const store = {
    providers: providers(),
    usage: {},
    mcp: {},
    loaded: true,
    showAllModels: false,
    // Те же правила, что в чате: краткий список — только не-`extra`.
    visibleModels: (p, selectedId = null) => (p?.models || [])
      .filter((m) => store.showAllModels || !m.extra || m.id === selectedId),
    modelOf: (saved) => {
      const providerId = typeof saved === 'object' ? String(saved?.provider || '') : '';
      const modelId = typeof saved === 'object' ? String(saved?.model || '') : String(saved || '');
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

const TRIAGE_SETTING = {
  key: 'triageModel',
  label: 'Модель для разбора',
  type: 'model',
  hint: 'Пока не выбрана, автоматические задачи не создаются ни в одном чате.',
  default: null,
};

const INBOX_PLUGIN = {
  id: 'inbox',
  system: true,
  name: 'Входящие',
  version: '1.0.0',
  description: 'Единая очередь обращений из подключённых каналов.',
  nav: { path: '/inbox', label: 'Входящие', icon: 'inbox' },
  settings: [TRIAGE_SETTING],
};
const CODE_PLUGIN = SYSTEM.find((plugin) => plugin.id === 'code');
const ANALYSIS_PLUGIN = {
  id: 'analysis',
  system: true,
  name: 'Триаж',
  version: '1.0.0',
  description: 'Оценка сложности и рисков по коду.',
  settings: [{
    ...TRIAGE_SETTING,
    label: 'Модель триажа',
    requiresCapability: 'scopedWorkspace',
  }],
};

function makePluginsStore(values, manifest = INBOX_PLUGIN) {
  const saved = [];
  const setting = manifest.settings[0];
  const plugin = {
    ...manifest,
    enabled: true,
    values: { [setting.key]: values },
  };
  return {
    saved,
    store: {
      loaded: true,
      list: [plugin],
      plugin,
      enabled: () => true,
      byId: (id) => (id === plugin.id ? plugin : null),
      async load() {},
      async toggle() {},
      async saveSettings(id, next) { saved.push({ id, values: JSON.parse(JSON.stringify(next)) }); },
    },
  };
}

async function mountSettings(t, { value = null, plugin = INBOX_PLUGIN } = {}) {
  const browser = await installBrowser(t, { 'cockpit-settings-tab': 'plugins' });
  const prov = makeProvidersStore();
  const { store: plugins, saved } = makePluginsStore(value, plugin);
  globalThis.__settingsApi = {
    async get() { return {}; },
    async post() { return {}; },
  };
  globalThis.__settingsStores = {
    useProvidersStore: () => prov,
    useUiContextStore: () => ({ set() {}, clear() {} }),
    useAuthStore: () => ({ login: 'me', async logoutAll() {} }),
    usePluginsStore: () => plugins,
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
  const select = wrapper.find('.plugrow select.inp');
  return { wrapper, prov, plugins, saved, select, flushPromises };
}

test('модели берутся из общего реестра исполнителей, группами', async (t) => {
  const { wrapper, select } = await mountSettings(t);

  assert.ok(select.exists(), 'селекта модели нет — настройка нарисована полем ввода');
  assert.deepEqual(
    wrapper.findAll('.plugrow optgroup').map((g) => g.attributes('label')),
    ['Claude', 'Ollama', 'GPT (Codex) — недоступен'],
    'исполнители обязаны стоять группами, а недоступный — с оговоркой',
  );
  // Старая версия («extra») в кратком списке не показывается — то же правило, что в чате.
  assert.deepEqual(
    wrapper.findAll('.plugrow optgroup option').map((o) => o.text()),
    ['Opus 5', 'qwen3.6 (hf)', 'GPT-5.6'],
  );
  // Недоступного исполнителя видно, но выбрать нельзя — иначе автомат уехал бы в никуда.
  assert.deepEqual(
    wrapper.findAll('.plugrow optgroup option').map((o) => o.attributes('disabled') !== undefined),
    [false, false, true],
  );
  // Подсказка манифеста должна доехать до экрана: она объясняет, почему без модели
  // автоматических задач не будет вовсе.
  assert.match(wrapper.find('.plughint').text(), /автоматические задачи не создаются/);
});

test('карточка триажа предлагает только исполнителей с изолированным рабочим каталогом', async (t) => {
  const { wrapper } = await mountSettings(t, { plugin: ANALYSIS_PLUGIN });

  assert.deepEqual(
    wrapper.findAll('.plugrow optgroup').map((group) => group.attributes('label')),
    ['Claude', 'GPT (Codex) — недоступен'],
  );
});

test('выбор сохраняется парой «исполнитель + модель», а id со слэшем не рвётся', async (t) => {
  const { plugins, saved, select, flushPromises } = await mountSettings(t);

  await select.setValue('ollama:hf.co/unsloth/qwen3.6:latest');
  assert.deepEqual(
    plugins.plugin.values.triageModel,
    { provider: 'ollama', model: 'hf.co/unsloth/qwen3.6:latest' },
    'id модели содержит и слэши, и двоеточия — режем строку по ПЕРВОМУ двоеточию',
  );

  await select.element.closest('.plugset').querySelector('button').click();
  await flushPromises();
  assert.deepEqual(saved, [{
    id: 'inbox',
    values: { triageModel: { provider: 'ollama', model: 'hf.co/unsloth/qwen3.6:latest' } },
  }], 'на сервер уезжает пара, а не склеенная строка');
});

test('сохранённый выбор показан выбранным', async (t) => {
  const { select } = await mountSettings(t, { value: { provider: 'claude', model: 'claude-opus-5' } });

  assert.equal(select.element.value, 'claude:claude-opus-5');
});

test('«не выбрана» обнуляет настройку — автомат обязан замолчать', async (t) => {
  const { plugins, select } = await mountSettings(t, { value: { provider: 'claude', model: 'claude-opus-5' } });

  await select.setValue('');
  assert.equal(plugins.plugin.values.triageModel, null, 'пустой выбор — это null, а не пустая пара');
});

test('пропавшая из реестра модель не выдаётся за «не выбрана»', async (t) => {
  // Сменили CLI, выключили демон — модели в каталоге больше нет. Выбор при этом остался
  // в настройках, и сервер ходит именно им: показать «не выбрана» значило бы соврать.
  const { wrapper, select } = await mountSettings(t, { value: { provider: 'ollama', model: 'сгинувшая:latest' } });

  assert.equal(select.element.value, 'ollama:сгинувшая:latest');
  const lost = wrapper.findAll('.plugrow select.inp > option').map((o) => o.text());
  assert.ok(lost.some((text) => text.includes('ollama:сгинувшая:latest') && text.includes('нет в реестре')),
    'выбор должен остаться в списке с пометкой');
});

// ── Усилие ──────────────────────────────────────────────────────────────────
// Усилие — свойство ЗАПУСКА, а не модели: одна и та же модель разбирает встречу и
// быстро, и вдумчиво, а до правки выбора не было вовсе и ход всегда шёл на умолчании
// исполнителя. Лестницу объявляет сама модель, поэтому контрол не универсальный.

/** Селект усилия — второй `select.inp` карточки; первый всегда модель. */
function effortSelect(wrapper) {
  const all = wrapper.findAll('.plugrow select.inp');
  return all.length > 1 ? all[1] : null;
}

test('карточка «Код» показывает модель сообщения и effort из серверного манифеста', async (t) => {
  const value = { provider: 'claude', model: 'claude-opus-5', effort: 'high' };
  const { wrapper, select } = await mountSettings(t, { value, plugin: CODE_PLUGIN });

  assert.equal(select.element.value, 'claude:claude-opus-5');
  assert.deepEqual(
    wrapper.findAll('.plugset label').map((label) => label.text()),
    ['Модель для сообщения коммита', 'Усилие'],
  );
  assert.equal(effortSelect(wrapper).element.value, 'high');
});

test('усилия нет, пока не выбрана модель: выбирать уровень не у чего', async (t) => {
  const { wrapper } = await mountSettings(t);

  assert.equal(Boolean(effortSelect(wrapper)), false);
});

test('у модели без своей лестницы контрола усилия нет вовсе', async (t) => {
  // Тот же принцип, что у слайдера в чате: пустой список эффортов — не «выбери низкий»,
  // а «этой модели уровень передать нечем».
  const { wrapper } = await mountSettings(t, { value: { provider: 'codex', model: 'gpt-5.6' } });

  assert.equal(Boolean(effortSelect(wrapper)), false, 'у модели без efforts селект усилия рисовать нельзя');
});

test('усилие уезжает в ту же пару и сохраняется вместе с моделью', async (t) => {
  const { wrapper, plugins, saved, flushPromises } = await mountSettings(
    t, { value: { provider: 'claude', model: 'claude-opus-5' } },
  );
  const effort = effortSelect(wrapper);

  assert.ok(effort, 'у Opus 5 лестница объявлена — селект обязан быть');
  assert.deepEqual(
    effort.findAll('option').map((o) => o.element.value),
    ['', 'low', 'medium', 'high', 'xhigh', 'max'],
    'уровни берутся у модели, а не из общего списка',
  );
  assert.equal(effort.element.value, '', 'без выбора — умолчание исполнителя, а не выдуманный уровень');

  await effort.setValue('xhigh');
  assert.deepEqual(plugins.plugin.values.triageModel,
    { provider: 'claude', model: 'claude-opus-5', effort: 'xhigh' });

  await wrapper.find('.plugset button').trigger('click');
  await flushPromises();
  assert.deepEqual(saved.at(-1).values.triageModel,
    { provider: 'claude', model: 'claude-opus-5', effort: 'xhigh' },
    'на сервер уезжает тройка, а не отдельный ключ рядом');
});

test('пустое усилие СНИМАЕТ ключ, а не пишет пустую строку', async (t) => {
  const { wrapper, plugins } = await mountSettings(
    t, { value: { provider: 'claude', model: 'claude-opus-5', effort: 'max' } },
  );

  await effortSelect(wrapper).setValue('');
  assert.deepEqual(plugins.plugin.values.triageModel, { provider: 'claude', model: 'claude-opus-5' },
    'пустая строка в effort означала бы «уровень выбран и он пустой»');
});

test('смена модели не переносит уровень, которого у новой нет', async (t) => {
  // Ровно та грабля, из-за которой уровень вообще сверяется: `--effort xhigh` у модели
  // без такой возможности не игнорируется, а РОНЯЕТ запуск CLI.
  const { wrapper, plugins, select } = await mountSettings(
    t, { value: { provider: 'claude', model: 'claude-opus-5', effort: 'xhigh' } },
  );

  await select.setValue('ollama:hf.co/unsloth/qwen3.6:latest');
  assert.deepEqual(plugins.plugin.values.triageModel,
    { provider: 'ollama', model: 'hf.co/unsloth/qwen3.6:latest' },
    'у локальной модели эффорт бинарный — xhigh переносить некуда');

  // А совпавший уровень переносится: терять осознанный выбор человека тоже нельзя.
  await effortSelect(wrapper).setValue('high');
  await select.setValue('claude:claude-opus-5');
  assert.equal(plugins.plugin.values.triageModel.effort, 'high');
});

test('уровень, пропавший у модели, показан пометкой, а не молча стёрт', async (t) => {
  // Обновили CLI, лестница модели изменилась. Сервер такой уровень снимет и пойдёт на
  // умолчании — человек обязан видеть, что его выбор больше не действует.
  const { wrapper } = await mountSettings(
    t, { value: { provider: 'ollama', model: 'hf.co/unsloth/qwen3.6:latest', effort: 'xhigh' } },
  );
  const effort = effortSelect(wrapper);

  assert.equal(effort.element.value, 'xhigh');
  assert.ok(effort.findAll('option').some((o) => o.text().includes('нет у этой модели')),
    'исчезнувший уровень обязан остаться в списке с оговоркой');
});

test('широкая плашка занимает две колонки, а в одну колонку — ни одной лишней', async () => {
  // happy-dom раскладку не считает вовсе, поэтому правило стережём чтением стиля;
  // сама геометрия замерена в headless Chrome на 1620/1200/860/600 px.
  const source = await readFile(VIEW_PATH, 'utf8');
  const style = source.slice(source.indexOf('<style'));

  assert.match(style, /\.plugcards \{[^}]*grid-auto-flow: dense/s,
    'без dense обычная плашка между двумя широкими остаётся одна в ряду (замер: 24% ряда)');
  assert.match(style, /\.plugcard\.wide \{ grid-column: span 2; \}/,
    'целый ряд под одну плашку — та же пустота, что и полупустой сосед');
  const narrow = style.slice(style.indexOf('@media (max-width: 639px)'));
  assert.match(narrow, /\.plugcard\.wide \{ grid-column: auto; \}/,
    'в одну колонку `span 2` создаёт вторую, неявную: замер на 600 px давал плашку в 30 px');
  assert.match(style, /\.plugset > \.btn \{ align-self: flex-start; \}/,
    'кнопка обязана быть по содержимому: общий max-width растягивал её на 760 px');
});
