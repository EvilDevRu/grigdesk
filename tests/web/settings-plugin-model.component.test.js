// Настройка плагина типа `model` («Настройки → Плагины»). Смысл проверки: модель для
// автомата общего Inbox человек выбирает ИЗ ОБЩЕГО РЕЕСТРА исполнителей кокпита, а не из
// зашитого в код списка вендора, и хранится выбор парой «исполнитель + модель». Склеенной
// строкой её не разобрать: у локальных исполнителей id модели сам бывает со слэшами и
// двоеточиями (`hf.co/user/repo:tag`) — разбор такой строки молча увёл бы ход не туда.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { SYSTEM } from '../../server/src/lib/pluginsRegistry.ts';
import { webFile } from './helpers/compile-vue.js';
import { compilePluginsCatalog } from './helpers/plugins-catalog.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

const CATALOG_PATH = webFile('src/views/settings/PluginsCatalog.vue');

// Реестр как в жизни: облачный исполнитель со «свежей» и «старой» моделями плюс локальный,
// у которого id модели с точкой, двоеточием и слэшем.
function providers() {
  return [
    {
      id: 'claude',
      name: 'Claude',
      available: true,
      capabilities: { scopedWorkspace: true, untrustedText: true },
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
      capabilities: { scopedWorkspace: false, untrustedText: true },
      // У локального эффорт бинарный: `xhigh` ему передать нельзя.
      models: [{ id: 'hf.co/unsloth/qwen3.6:latest', name: 'qwen3.6 (hf)', efforts: ['low', 'high'] }],
    },
    {
      id: 'codex',
      name: 'GPT (Codex)',
      available: false,
      capabilities: { scopedWorkspace: true, untrustedText: false },
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

let mountNonce = 0;

/**
 * Форма параметров живёт в модалке плитки, поэтому каждый тест открывает нужный плагин
 * и дальше работает с её содержимым. Teleport на время теста оставляем на месте.
 */
async function mountSettings(t, { value = null, plugin = INBOX_PLUGIN } = {}) {
  const prefix = `__pluginModel${mountNonce += 1}`;
  const browser = await installUiBrowser(t, 'http://cockpit.test/#/settings');
  const prov = makeProvidersStore();
  const { store: plugins, saved } = makePluginsStore(value, plugin);
  globalThis[`${prefix}Stores`] = {
    usePluginsStore: () => plugins,
    useProvidersStore: () => prov,
  };

  const [{ mount, flushPromises }, PluginsCatalog] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compilePluginsCatalog({ prefix }),
  ]);
  const wrapper = mount(PluginsCatalog, {
    attachTo: browser.document.querySelector('#mount'),
    global: { stubs: { teleport: true } },
  });
  t.after(() => {
    wrapper.unmount();
    delete globalThis[`${prefix}Stores`];
  });
  for (let i = 0; i < 3; i += 1) await flushPromises();

  await wrapper.get(`[data-plugin-id="${plugins.plugin.id}"] .plugin-tile-open`).trigger('click');
  await flushPromises();

  const dialog = wrapper.find('.ui-dialog');
  assert.ok(dialog.exists(), 'модалка параметров не открылась');

  return { wrapper: dialog, prov, plugins, saved, select: dialog.find('.plugrow select.inp'), flushPromises };
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
  // Недоступность — итог последней проверки, а не приговор: CLI мог не ответить на опрос,
  // моргнуть сетью или разлогиниться на минуту. Оговорка в названии группы остаётся,
  // блокировки выбора нет — иначе один неудачный опрос решал бы за человека.
  assert.deepEqual(
    wrapper.findAll('.plugrow optgroup option').map((o) => o.attributes('disabled') !== undefined),
    [false, false, false],
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
  const { wrapper, plugins, saved, select, flushPromises } = await mountSettings(t);

  await select.setValue('ollama:hf.co/unsloth/qwen3.6:latest');
  assert.deepEqual(
    plugins.plugin.values.triageModel,
    { provider: 'ollama', model: 'hf.co/unsloth/qwen3.6:latest' },
    'id модели содержит и слэши, и двоеточия — режем строку по ПЕРВОМУ двоеточию',
  );

  await wrapper.get('.plugin-save').trigger('click');
  await flushPromises();
  assert.deepEqual(saved, [{
    id: 'inbox',
    values: { triageModel: { provider: 'ollama', model: 'hf.co/unsloth/qwen3.6:latest' } },
  }], 'на сервер уезжает пара, а не склеенная строка');
});

test('модель недоступного исполнителя выбирается и сохраняется', async (t) => {
  // Причина недоступности бывает временной, а настройка живёт дольше: человек вправе
  // назначить модель заранее — сервер попробует запустить её и назовёт настоящий отказ.
  const { wrapper, plugins, saved, select, flushPromises } = await mountSettings(t);

  await select.setValue('codex:gpt-5.6');
  assert.deepEqual(plugins.plugin.values.triageModel, { provider: 'codex', model: 'gpt-5.6' });

  await wrapper.get('.plugin-save').trigger('click');
  await flushPromises();
  assert.deepEqual(saved, [{ id: 'inbox', values: { triageModel: { provider: 'codex', model: 'gpt-5.6' } } }]);
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

test('сохранённая несовместимая модель остаётся видимой до явной замены', async (t) => {
  const value = { provider: 'codex', model: 'gpt-5.6' };
  const { wrapper, select } = await mountSettings(t, { value, plugin: CODE_PLUGIN });

  assert.equal(select.element.value, 'codex:gpt-5.6');
  assert.match(
    wrapper.get('.plugrow select.inp > option[disabled]').text(),
    /GPT \(Codex\): GPT-5\.6.*не подходит для этой настройки/u,
  );
  assert.deepEqual(
    wrapper.findAll('.plugrow optgroup').map((group) => group.attributes('label')),
    ['Claude', 'Ollama'],
  );
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
    wrapper.findAll('.plugrow optgroup').map((group) => group.attributes('label')),
    ['Claude', 'Ollama'],
    'небезопасный model transport нельзя предложить для чтения staged diff',
  );
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

  await wrapper.get('.plugin-save').trigger('click');
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

test('каталог — сетка плиток, и на узком экране она остаётся сеткой', async () => {
  // happy-dom раскладку не считает вовсе, поэтому адаптивный контракт стережём чтением
  // стиля, а поведение плиток и модалки — отдельными компонентными тестами.
  const source = await readFile(CATALOG_PATH, 'utf8');
  const style = source.slice(source.indexOf('<style'));

  assert.match(style, /\.plugin-grid \{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(150px/s,
    'плитки должны заполнять ширину сами, а не выстраиваться в одну колонку');
  assert.doesNotMatch(style, /grid-auto-flow:\s*dense/,
    'dense меняет визуальный порядок относительно DOM и клавиатурного фокуса');
  assert.match(style, /\.plugin-tile-power \{ position: absolute;/,
    'кнопка питания лежит поверх плитки, а не внутри её кнопки — иначе интерактив вложен в интерактив');

  const mobile = style.slice(style.indexOf('@media (max-width: 639px)'));
  assert.match(mobile, /\.plugin-grid \{ grid-template-columns: repeat\(auto-fill, minmax\(128px/,
    'на телефоне плитки сужаются, но список из них не делается');
});
