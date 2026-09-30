// Выбор модели в чате при «недоступном» исполнителе. Смысл проверки: «недоступен» —
// это итог последней проверки CLI, а не приговор. Причина бывает временной (сеть,
// тайм-аут опроса, минутный разлогин), и раньше один неудачный опрос гасил в селекте
// все модели исполнителя — решение отбиралось у человека. Пометка обязана остаться,
// блокировка — нет: отказ приходит от самого запуска и называет настоящую причину.
import assert from 'node:assert/strict';
globalThis.__sharedChatContextFill = (await import('../../shared/chatContext.ts')).contextFill;
import test from 'node:test';
import { compileChatSession as compileChatSessionHarness } from './helpers/chat-session.js';

process.env.NODE_ENV = 'test';

const compileChatSession = () => compileChatSessionHarness('__modelAvail');

const PROVIDERS = [
  {
    id: 'claude',
    name: 'Claude',
    color: '#d97757',
    available: true,
    models: [{ id: 'claude-opus-5', name: 'Opus 5', efforts: [] }],
  },
  // Опрос этого исполнителя не удался — реестр отдал его без доступности, но с моделями:
  // каталог не стирается от непрочитанного бинаря.
  {
    id: 'codex',
    name: 'Codex',
    color: '#10a37f',
    available: false,
    models: [{ id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol', efforts: [] }],
  },
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

// Реестр отвечает как настоящий стор: модель ищется по всем исполнителям, доступность
// на поиск не влияет.
function modelOf(value) {
  const id = value && typeof value === 'object' ? value.model || '' : value || '';
  const provider = PROVIDERS.find((item) => item.models.some((model) => model.id === id)) || null;

  return { id, model: provider?.models.find((model) => model.id === id) || null, provider };
}

/**
 * Монтирует настоящий селект с управляемым ответом на сброс памяти.
 * Сохранённое состояние задаётся до загрузки реестра и не исправляется фикстурой.
 */
async function mountChat(t, { initial = {}, reset = async () => true } = {}) {
  const browser = await installBrowser(t);
  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const session = reactive({
    id: 'model-availability-chat',
    taskId: null,
    title: 'Исполнитель не отозвался',
    model: 'claude-opus-5',
    modelRef: { provider: 'claude', model: 'claude-opus-5' },
    effort: '',
    mode: '',
    messages: [{ role: 'user', text: 'привет' }],
    steps: [],
    draft: '',
    sessionId: null,
    contextTokens: 0,
    sending: false,
    compacting: false,
    sessionResetting: false,
    ...initial,
  });
  const setModelCalls = [];
  const resetCalls = [];

  globalThis.__modelAvailApi = {
    url: (path) => path,
    async get(path) { return path === '/api/tasks' ? { tasks: [] } : {}; },
    async post() { return {}; },
  };
  globalThis.__modelAvailChatStore = () => ({
    sessions: [session],
    compactWindow: 0,
    loadConveyor() {},
    markRead() {},
    setDraft() {},
    setEffort() {},
    setMode() {},
    setTask() {},
    setTitle() {},
    setModel(sid, modelId) {
      setModelCalls.push({ sid, modelId });
      session.model = modelId;
      session.modelRef = { provider: modelOf(modelId).provider?.id || '', model: modelId };
    },
    async resetContext(sid) {
      resetCalls.push({ sid, modelRef: { ...session.modelRef } });

      return reset(sid);
    },
    permFor() { return null; },
    questionFor() { return null; },
    isOnConveyor() { return false; },
    tabLabel() { return session.title; },
  });
  globalThis.__modelAvailTasksStore = () => ({ async load() { return null; } });
  globalThis.__modelAvailUiStore = () => ({ openTaskLaunch() {} });
  globalThis.__modelAvailRouter = { async push() {} };
  globalThis.__modelAvailProvidersStore = () => ({
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
    delete globalThis.__modelAvailApi;
    delete globalThis.__modelAvailChatStore;
    delete globalThis.__modelAvailTasksStore;
    delete globalThis.__modelAvailUiStore;
    delete globalThis.__modelAvailRouter;
    delete globalThis.__modelAvailProvidersStore;
  });
  await flushPromises();

  return {
    wrapper,
    session,
    setModelCalls,
    resetCalls,
    flushPromises,
  };
}

const modelOption = (wrapper, id) => wrapper.findAll('.sel.model option')
  .find((option) => option.attributes('value') === id);

test('модели недоступного исполнителя выбор не теряют', async (t) => {
  const { wrapper } = await mountChat(t);
  const option = modelOption(wrapper, 'gpt-5.6-sol');

  assert.ok(option, 'модель недоступного исполнителя пропала из селекта');
  assert.equal(option.attributes('disabled'), undefined, 'модель заблокирована по недоступности');
  assert.equal(option.element.disabled, false);
});

test('недоступность названа в группе и в подсказке пункта', async (t) => {
  const { wrapper } = await mountChat(t);
  const groups = wrapper.findAll('.sel.model optgroup');
  const labels = groups.map((group) => group.attributes('label'));

  assert.deepEqual(labels, ['Claude', 'Codex — недоступен']);
  assert.match(
    modelOption(wrapper, 'gpt-5.6-sol').attributes('title'),
    /исполнитель недоступен по последней проверке/u,
  );
  // У доступного исполнителя лишней оговорки в подсказке нет.
  assert.doesNotMatch(modelOption(wrapper, 'claude-opus-5').attributes('title'), /недоступен/u);
});

test('переключение на модель недоступного исполнителя доходит до стора', async (t) => {
  const { wrapper, setModelCalls } = await mountChat(t);

  await wrapper.find('.sel.model select').setValue('gpt-5.6-sol');

  assert.deepEqual(setModelCalls, [{ sid: 'model-availability-chat', modelId: 'gpt-5.6-sol' }]);
});

const RETIRED_SESSION = {
  revision: 3,
  model: 'retired-model',
  modelRef: { provider: 'retired-provider', model: 'retired-model' },
  sessionId: 'retired-fixture-session',
  pendingSeed: 'Сохранённая память',
};

test('снятая модель остаётся выбранной, а история видна после загрузки реестра', async (t) => {
  const { wrapper, session, setModelCalls, resetCalls } = await mountChat(t, {
    initial: RETIRED_SESSION,
  });

  assert.equal(wrapper.find('.sel.model select').element.value, RETIRED_SESSION.model);
  assert.equal(wrapper.text().includes('привет'), true);
  assert.equal(setModelCalls.length, 0);
  assert.equal(resetCalls.length, 0);
  assert.deepEqual(session.modelRef, RETIRED_SESSION.modelRef);
});

test('перевыбор снятого исполнителя ждёт сброса с прежним modelRef', async (t) => {
  let finishReset;
  const gate = new Promise((resolve) => {
    finishReset = resolve;
  });

  t.after(() => finishReset(true));

  const { wrapper, session, resetCalls, setModelCalls, flushPromises } = await mountChat(t, {
    initial: RETIRED_SESSION,
    reset: () => gate,
  });

  await wrapper.find('.sel.model select').setValue('gpt-5.6-sol');

  assert.deepEqual(resetCalls, [{
    sid: session.id,
    modelRef: RETIRED_SESSION.modelRef,
  }]);
  assert.equal(setModelCalls.length, 0);
  assert.deepEqual(session.modelRef, RETIRED_SESSION.modelRef);

  finishReset(true);
  await flushPromises();

  assert.deepEqual(setModelCalls, [{ sid: session.id, modelId: 'gpt-5.6-sol' }]);
  assert.deepEqual(session.modelRef, { provider: 'codex', model: 'gpt-5.6-sol' });
  assert.equal(session.messages[0].text, 'привет');
});

test('отказ сброса снятого исполнителя возвращает селект и сохраняет пару', async (t) => {
  const { wrapper, session, resetCalls, setModelCalls, flushPromises } = await mountChat(t, {
    initial: RETIRED_SESSION,
    reset: async () => false,
  });

  await wrapper.find('.sel.model select').setValue('gpt-5.6-sol');
  await flushPromises();

  assert.equal(resetCalls.length, 1);
  assert.equal(setModelCalls.length, 0);
  assert.equal(wrapper.find('.sel.model select').element.value, RETIRED_SESSION.model);
  assert.deepEqual(session.modelRef, RETIRED_SESSION.modelRef);
  assert.equal(session.messages[0].text, 'привет');
});

test('сохранённый seed снятого исполнителя требует сброса даже без sessionId', async (t) => {
  const { wrapper, session, resetCalls, setModelCalls, flushPromises } = await mountChat(t, {
    initial: { ...RETIRED_SESSION, sessionId: null },
  });

  await wrapper.find('.sel.model select').setValue('gpt-5.6-sol');
  await flushPromises();

  assert.deepEqual(resetCalls, [{ sid: session.id, modelRef: RETIRED_SESSION.modelRef }]);
  assert.deepEqual(setModelCalls, [{ sid: session.id, modelId: 'gpt-5.6-sol' }]);
});
