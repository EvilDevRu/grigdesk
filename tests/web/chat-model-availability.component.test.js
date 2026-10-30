// Выбор модели в чате при «недоступном» исполнителе. Смысл проверки: «недоступен» —
// это итог последней проверки CLI, а не приговор. Причина бывает временной (сеть,
// тайм-аут опроса, минутный разлогин), и раньше один неудачный опрос гасил в селекте
// все модели исполнителя — решение отбиралось у человека. Пометка обязана остаться,
// блокировка — нет: отказ приходит от самого запуска и называет настоящую причину.
import assert from 'node:assert/strict';

import { after, before, test } from 'node:test';
import { compileChatSession as compileChatSessionHarness } from './helpers/chat-session.js';
import { createUiBrowser } from './helpers/ui-components.js';

globalThis.__sharedChatContextFill = (await import('../../shared/chat/chatContext.ts')).contextFill;

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

let sharedBrowser;

before(async () => {
  sharedBrowser = await createUiBrowser('https://grigdesk.test/#/chats');
});

after(async () => {
  await sharedBrowser?.close();
});

/**
 * Один document на файл нужен новым пользовательским проверкам Teleport.
 * Каждый mount получает чистое body, глобальные Vue DOM singletons остаются прежними.
 */
async function installBrowser() {
  sharedBrowser.document.body.innerHTML = '<div id="mount"></div>';

  return sharedBrowser;
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
async function mountChat(t, { initial = {}, reset = async () => true, binding = false } = {}) {
  const browser = await installBrowser();
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
  const resetOptions = [];

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
    /**
     * Наблюдает параметры сброса, не скрывая ожидание подтверждения сервера.
     * Плашка добавляется только после успеха, согласно тому же note, что у стора.
     */
    async resetContext(sid, options = {}) {
      resetCalls.push({ sid, modelRef: { ...session.modelRef } });
      resetOptions.push(options);

      const accepted = await reset(sid);

      if (accepted && options.note !== false) {
        session.messages.push({ role: 'note', text: '🧹 Память агента сброшена' });
      }

      return accepted;
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
    modelOf(value) {
      const resolved = modelOf(value);

      return binding && resolved.provider
        ? { ...resolved, provider: { ...resolved.provider, sessionBinding: true } }
        : resolved;
    },
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
    resetOptions,
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

test('смена исполнителя меняет справку усилия вместе с каталогом модели', async (t) => {
  const claudeModel = PROVIDERS[0].models[0];
  const codexModel = PROVIDERS[1].models[0];
  const originalClaude = { ...claudeModel };
  const originalCodex = { ...codexModel };

  t.after(() => {
    Object.assign(claudeModel, originalClaude);
    Object.assign(codexModel, originalCodex);
    delete claudeModel.effortHints;
    delete codexModel.effortHints;
  });

  claudeModel.efforts = ['low', 'high'];
  claudeModel.effortHints = { low: 'Экономное усилие.', high: 'Тщательная работа.' };
  codexModel.efforts = ['high', 'ultra'];
  codexModel.effortHints = { high: 'Глубокое рассуждение.', ultra: 'Делегирование субагентам.' };

  const { wrapper, flushPromises } = await mountChat(t);

  assert.deepEqual(wrapper.findComponent({ name: 'EffortSlider' }).props('hints'), claudeModel.effortHints);

  await wrapper.find('.sel.model select').setValue(codexModel.id);
  await flushPromises();

  const slider = wrapper.findComponent({ name: 'EffortSlider' });

  assert.deepEqual(slider.props('levels'), ['high', 'ultra']);
  assert.deepEqual(slider.props('hints'), codexModel.effortHints);
});

test('MODEL-NOTE-B1: смена непустого чата сохраняет плашку и переписку', async (t) => {
  const messages = [{ role: 'user', text: 'Вопрос' }, { role: 'assistant', text: 'Ответ' }];
  const { wrapper, session, resetCalls, resetOptions, flushPromises } = await mountChat(t, {
    initial: { messages: messages.map((message) => ({ ...message })) },
    binding: true,
  });

  await wrapper.find('.sel.model select').setValue('gpt-5.6-sol');
  await flushPromises();

  assert.equal(resetCalls.length, 1);
  assert.notEqual(resetOptions[0].note, false);
  assert.deepEqual(session.messages.slice(0, 2), messages.slice(0, 2));
  assert.ok(session.messages.some((message) => message.role === 'note'
    && message.text.includes('Память агента сброшена')));
  assert.match(wrapper.text(), /Память агента сброшена/);
  assert.equal(session.modelRef.model, 'gpt-5.6-sol');
});

for (const draft of ['', 'Черновик без единого хода']) {
  test(`MODEL-NOTE-01: пустой чат меняет исполнителя без плашки, draft=${Boolean(draft)}`, async (t) => {
    const { wrapper, session, resetOptions, setModelCalls, flushPromises } = await mountChat(t, {
      initial: {
        revision: 3,
        messages: [],
        draft,
      },
      binding: true,
    });

    await wrapper.find('.sel.model select').setValue('gpt-5.6-sol');
    await flushPromises();

    assert.equal(resetOptions.length, 1, 'серверный reset в пустом сохранённом чате остаётся');
    assert.equal(resetOptions[0].note, false);
    assert.equal(setModelCalls.length, 1);
    assert.equal(session.modelRef.model, 'gpt-5.6-sol');
    assert.equal(session.draft, draft);
    assert.equal(session.messages.some((message) => message.role === 'note'), false);
    assert.doesNotMatch(wrapper.text(), /Память агента сброшена/);
  });
}

test('SELECT-CHAT-01: отказ async reset сохраняет прежнюю видимую модель', async (t) => {
  const gate = Promise.withResolvers();

  t.after(() => gate.resolve(false));

  const { wrapper, session, resetCalls, setModelCalls, flushPromises } = await mountChat(t, {
    initial: RETIRED_SESSION,
    reset: () => gate.promise,
  });
  const trigger = wrapper.get('.sel.model button.ui-select');
  const before = trigger.text();

  await trigger.trigger('click');
  await flushPromises();

  const native = wrapper.get('.sel.model select').element;
  const index = [...native.options].findIndex((option) => option.value === 'gpt-5.6-sol');
  const item = document.querySelector('.ui-select-popup [data-option-index="' + index + '"]');

  assert.ok(Boolean(item));
  item.click();
  await flushPromises();
  assert.equal(resetCalls.length, 1);
  assert.equal(setModelCalls.length, 0);
  assert.equal(trigger.text(), before);
  gate.resolve(false);
  await flushPromises();
  assert.equal(trigger.text(), before);
  assert.equal(native.value, RETIRED_SESSION.model);
  assert.deepEqual(session.modelRef, RETIRED_SESSION.modelRef);
  assert.equal(setModelCalls.length, 0);
});

test('SELECT-CHAT-02: видимый выбор недоступного исполнителя доходит до стора', async (t) => {
  const { wrapper, session, setModelCalls, flushPromises } = await mountChat(t);

  await wrapper.get('.sel.model button.ui-select').trigger('click');
  await flushPromises();

  const native = wrapper.get('.sel.model select').element;
  const index = [...native.options].findIndex((option) => option.value === 'gpt-5.6-sol');
  const item = document.querySelector('.ui-select-popup [data-option-index="' + index + '"]');

  assert.ok(Boolean(item));
  assert.equal(item.disabled, false);
  item.click();
  await flushPromises();
  assert.deepEqual(setModelCalls, [{ sid: session.id, modelId: 'gpt-5.6-sol' }]);
  assert.equal(session.modelRef.model, 'gpt-5.6-sol');
  assert.match(wrapper.get('.sel.model button.ui-select').text(), /GPT 5.6 Sol/u);
});
