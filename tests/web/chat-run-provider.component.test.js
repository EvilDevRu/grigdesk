// Знак и цвет в шапке ответа агента. Смысл проверки: раньше у КАЖДОГО ответа рисовалась
// звезда Claude в её фирменном оранжевом — и у Codex, и у Kimi, и у чужой модели. Ход
// помнит свою модель, поэтому шапка обязана брать исполнителя из неё, а не из селекта
// сессии: ИИ меняют посреди разговора, и прошлые ходы остаются за прежним.
import assert from 'node:assert/strict';
globalThis.__sharedChatContextFill = (await import('../../shared/chatContext.ts')).contextFill;
import test from 'node:test';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { compileChatSession as compileChatSessionHarness } from './helpers/chat-session.js';

process.env.NODE_ENV = 'test';

const compileChatSession = () => compileChatSessionHarness('__runProvider');

const PROVIDERS = [
  {
    id: 'claude',
    name: 'Claude',
    color: '#d97757',
    available: true,
    models: [{ id: 'claude-opus-5', name: 'Opus 5', efforts: [] }],
  },
  {
    id: 'codex',
    name: 'Codex',
    color: '#10a37f',
    available: true,
    models: [{ id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol', efforts: [] }],
  },
  {
    id: 'kimi',
    name: 'Kimi',
    color: '#6657d9',
    available: true,
    models: [{ id: 'kimi-code/k3', name: 'K3', efforts: [] }],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    color: '#4D6BFE',
    available: true,
    models: [{ id: '["deepseek-official","deepseek-v4-flash"]', name: 'DeepSeek V4', efforts: [] }],
  },
];

// Ответы одного чата: сперва Claude, потом сменили ИИ на Codex, потом на Kimi, а последний
// ход остался на модели, которой в реестре уже нет (обновился CLI, снята версия).
const MESSAGES = [
  { role: 'user', text: 'привет' },
  { role: 'assistant', text: 'ответ Claude', model: 'claude-opus-5' },
  { role: 'assistant', text: 'ответ Codex', model: 'gpt-5.6-sol', actualModel: 'gpt-5.6-sol' },
  { role: 'assistant', text: 'ответ Kimi', model: 'kimi-code/k3' },
  { role: 'assistant', text: 'ответ DeepSeek', model: '["deepseek-official","deepseek-v4-flash"]' },
  { role: 'assistant', text: 'ответ ниоткуда', model: 'снятая-модель' },
];

async function installBrowser(t) {
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'https://cockpit.test/#/chats' });

  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    localStorage: browser.localStorage,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
    Document: browser.Document,
    ShadowRoot: browser.ShadowRoot,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    KeyboardEvent: browser.KeyboardEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';
  t.after(() => browser.close());

  return browser;
}

// Реестр отвечает ровно как настоящий стор: модель ищется по всем исполнителям, чужая
// не резолвится вовсе.
function modelOf(value) {
  const id = value && typeof value === 'object' ? value.model || '' : value || '';
  const provider = PROVIDERS.find((item) => item.models.some((model) => model.id === id)) || null;

  return { id, model: provider?.models.find((model) => model.id === id) || null, provider };
}

// Геометрия знака: сравниваем не разметку целиком (у неё свой scope-атрибут в каждой
// сборке), а сами фигуры — именно они отличают звезду Claude от узла OpenAI.
function glyph(element) {
  return [...element.querySelectorAll('path, circle, ellipse, polygon')]
    .map((shape) => shape.getAttribute('d') || shape.outerHTML);
}

async function mountChat(t, { sending = false } = {}) {
  const browser = await installBrowser(t);
  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const session = reactive({
    id: 'run-provider-chat',
    taskId: null,
    title: 'Смена ИИ посреди разговора',
    model: 'kimi-code/k3',
    modelRef: { provider: 'kimi', model: 'kimi-code/k3' },
    effort: '',
    mode: '',
    messages: structuredClone(MESSAGES),
    steps: [],
    draft: '',
    sessionId: null,
    contextTokens: 0,
    sending,
    compacting: false,
    sessionResetting: false,
  });

  globalThis.__runProviderApi = {
    url: (path) => path,
    async get(path) { return path === '/api/tasks' ? { tasks: [] } : {}; },
    async post() { return {}; },
  };
  globalThis.__runProviderChatStore = () => ({
    sessions: [session],
    compactWindow: 0,
    loadConveyor() {},
    markRead() {},
    setDraft() {},
    setEffort() {},
    setMode() {},
    setTask() {},
    setTitle() {},
    permFor() { return null; },
    questionFor() { return null; },
    isOnConveyor() { return false; },
    tabLabel() { return session.title; },
  });
  globalThis.__runProviderTasksStore = () => ({ async load() { return null; } });
  globalThis.__runProviderUiStore = () => ({ openTaskLaunch() {} });
  globalThis.__runProviderRouter = { async push() {} };
  globalThis.__runProviderProvidersStore = () => ({
    providers: PROVIDERS,
    load() {},
    modelOf,
    visibleModels(provider) { return provider.models; },
    modesOf() { return []; },
  });

  const [{ mount, flushPromises }, ChatSession] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileChatSession(),
  ]);
  const wrapper = mount(ChatSession, {
    attachTo: browser.document.querySelector('#mount'),
    props: { sid: session.id },
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__runProviderApi;
    delete globalThis.__runProviderChatStore;
    delete globalThis.__runProviderTasksStore;
    delete globalThis.__runProviderUiStore;
    delete globalThis.__runProviderRouter;
    delete globalThis.__runProviderProvidersStore;
  });
  await flushPromises();

  return wrapper;
}

// Эталон знака берём у самого ProviderIcon: тест обязан ловить подмену исполнителя,
// а не переезд конкретной кривой в svg.
async function expectedGlyph(t, provider) {
  const [{ mount }, ProviderIcon] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/shared/ProviderIcon.vue')),
  ]);
  const wrapper = mount(ProviderIcon, { props: { provider, size: 12 } });

  t.after(() => wrapper.unmount());

  return glyph(wrapper.element);
}

test('шапка ответа показывает знак и цвет исполнителя ЭТОГО хода', async (t) => {
  const wrapper = await mountChat(t);
  const answers = wrapper.findAll('.msg.assistant');
  assert.equal(answers.length, 5);

  for (const [index, provider] of PROVIDERS.entries()) {
    const answer = answers[index];
    const icon = answer.find('.ahead svg');
    assert.ok(icon.exists(), `${provider.id}: в шапке ответа нет знака`);
    assert.deepEqual(
      glyph(icon.element),
      await expectedGlyph(t, provider),
      `${provider.id}: в шапке ответа знак чужого исполнителя`,
    );
    assert.equal(
      answer.element.style.getPropertyValue('--prov').trim(),
      provider.color,
      `${provider.id}: цвет ответа не фирменный`,
    );
  }
});

test('шапка ответа называет модель именем из каталога, а не opaque id', async (t) => {
  const wrapper = await mountChat(t);
  const answers = wrapper.findAll('.msg.assistant');

  // DeepSeek хранит модель как JSON-массив: человеку показывается имя из каталога.
  assert.equal(answers[3].find('.amodel').text().includes('DeepSeek V4 · запрошено'), true);
  assert.equal(answers[3].find('.amodel').text().includes('deepseek-official'), false);
  // Факт из потока — тоже через каталог: Codex назвал модель сам, подпись без «запрошено».
  assert.equal(answers[1].find('.amodel').text().startsWith('GPT 5.6 Sol'), true);
  assert.equal(answers[1].find('.amodel').text().includes('запрошено'), false);
});

test('ход на модели вне реестра остаётся без знака и без чужого цвета', async (t) => {
  const wrapper = await mountChat(t);
  const orphan = wrapper.findAll('.msg.assistant')[4];

  assert.equal(orphan.find('.ahead svg').exists(), false, 'незнакомой модели пририсовали знак');
  assert.equal(orphan.find('.ahead .fb').exists(), false, 'незнакомой модели пририсовали кружок');
  assert.equal(orphan.element.style.getPropertyValue('--prov').trim(), '');
  // Подпись модели остаётся: без знака ход всё равно обязан называть, чем отвечали.
  assert.equal(orphan.find('.amodel').text().includes('снятая-модель'), true);
});

test('идущий ход с первой секунды несёт знак и цвет работающего исполнителя', async (t) => {
  const wrapper = await mountChat(t, { sending: true });
  const blocks = wrapper.findAll('.msg.assistant');
  const live = blocks[blocks.length - 1];
  const kimi = PROVIDERS.find((provider) => provider.id === 'kimi');

  // Живой ход отличаем по живой строке хода: своей модели у него ещё нет, а строка стоит
  // в его же блоке.
  assert.equal(live.find('[data-role="chat-thinking"]').exists(), true, 'взят не блок идущего хода');

  // Чат стоит на Kimi — работает сейчас он, и знак с цветом обязаны быть его: раньше
  // живой ход шёл без шапки вовсе, и знак появлялся только вместе с готовым ответом.
  const icon = live.find('.ahead svg');
  assert.ok(icon.exists(), 'у идущего хода нет знака исполнителя');
  assert.deepEqual(glyph(icon.element), await expectedGlyph(t, kimi), 'у идущего хода знак чужого исполнителя');
  assert.equal(live.element.style.getPropertyValue('--prov').trim(), kimi.color);
  assert.equal(live.find('.ahead').text().includes('Агент'), true, 'у идущего хода нет подписи агента');
  // Модель — выбор чата, и шапка честно называет её запрошенной, а не фактом из потока;
  // подпись — имя из каталога, а не машинный id.
  assert.equal(live.find('.amodel').text().includes('K3 · запрошено'), true);
  assert.equal(live.find('.amodel').text().includes('kimi-code/k3'), false);
});

test('живая строка хода идёт под переписку — последней строкой блока идущего хода', async (t) => {
  const wrapper = await mountChat(t, { sending: true });
  const blocks = wrapper.findAll('.msg.assistant');
  const live = blocks[blocks.length - 1];
  const lines = wrapper.findAll('[data-role="chat-thinking"]');

  // Строка одна и стоит в самом блоке хода, а не отдельной полосой у поля ввода: пока
  // переписка короткая, она держится под последним сообщением, а не у нижнего края окна.
  assert.equal(lines.length, 1, 'живая строка хода должна быть ровно одна');
  assert.equal(live.element.contains(lines[0].element), true, 'строка стоит не в блоке идущего хода');
  // Последняя строка блока: под шапкой хода и лентой шагов, ничего ниже неё в блоке нет.
  assert.equal(live.element.lastElementChild === lines[0].element, true,
    'строка стоит не последней в блоке');
});

test('без хода живой строки нет — ни в ленте, ни у поля ввода', async (t) => {
  const wrapper = await mountChat(t);

  assert.equal(wrapper.find('[data-role="chat-thinking"]').exists(), false, 'строка живёт вне хода');
});

test('пузырь человека фирменного цвета не получает', async (t) => {
  const wrapper = await mountChat(t);
  const mine = wrapper.find('.msg.user');

  assert.ok(mine.exists());
  assert.equal(mine.element.style.getPropertyValue('--prov').trim(), '');
  assert.equal(mine.find('.ahead').exists(), false);
});
