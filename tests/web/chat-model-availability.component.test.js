// Каталог выбора скрывает недоступных и отключённых исполнителей вместе с моделями.
// Сохранённый выбор и память разговора при этом остаются прежними до действия человека.
import assert from 'node:assert/strict';

import { after, before, test } from 'node:test';
import { compileChatSession as compileChatSessionHarness } from './helpers/chat-session.js';
import { createUiBrowser } from './helpers/ui-components.js';

globalThis.__sharedChatContextFill = (await import('../../shared/chat/chatContext.ts')).contextFill;

process.env.NODE_ENV = 'test';

const compileChatSession = () => compileChatSessionHarness('__modelAvail');

let PROVIDERS = [
  {
    id: 'claude',
    chatSpeed: { modes: ['standard', 'fast'] },
    name: 'Claude',
    color: '#d97757',
    available: true,
    models: [{
      id: 'claude-opus-5',
      name: 'Opus 5',
      chatSpeedModes: ['standard', 'fast'],
      efforts: [],
    }],
  },
  {
    id: 'codex',
    chatSpeed: { modes: ['standard', 'fast', 'ultrafast'] },
    name: 'Codex',
    color: '#10a37f',
    available: true,
    models: [{
      id: 'gpt-5.6-sol',
      name: 'GPT 5.6 Sol',
      chatSpeedModes: ['standard', 'fast'],
      efforts: [],
    }],
  },
];

let sharedBrowser;

before(async () => {
  sharedBrowser = await createUiBrowser('https://grigdesk.test/#/chats');

  const { reactive } = await import('../../web/node_modules/vue/index.mjs');

  PROVIDERS = reactive(PROVIDERS);
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
  const speedCalls = [];
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
    setSpeed(sid, speed) {
      speedCalls.push({ sid, speed });
      session.speed = speed;
    },
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
    // Как настоящий стор: нечат-модель не выводится, сохранённый выбор остаётся.
    visibleModels(provider, selectedId) {
      return provider.models.filter((m) => m.id === selectedId || !m.nonChat);
    },
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
    speedCalls,
    resetCalls,
    resetOptions,
    flushPromises,
  };
}

const modelOption = (wrapper, id) => wrapper.findAll('.sel.model option')
  .find((option) => option.attributes('value') === id);

test('модели доступного исполнителя доступны для выбора', async (t) => {
  const { wrapper } = await mountChat(t);
  const option = modelOption(wrapper, 'gpt-5.6-sol');

  assert.ok(option, 'модель доступного исполнителя пропала из селекта');
  assert.equal(option.attributes('disabled'), undefined);
  assert.equal(option.element.disabled, false);
});

// Нечат-модель каталога: реестр помечает её extra/nonChat с причиной запрета запуска.
const NON_CHAT_PROVIDER = {
  id: 'qwen',
  name: 'Qwen Code',
  available: true,
  models: [
    {
      id: 'qwen3.8-max',
      name: 'Qwen3.8 Max',
      efforts: [],
    },
    {
      id: 'wan3.0-video',
      name: 'Wan3.0 Video',
      efforts: [],
      extra: true,
      nonChat: true,
      nonChatReason: 'Генерация видео, не текстовый чат',
    },
  ],
};

/**
 * Подключает нечат-модель к общему реестру теста и убирает её после проверки.
 * Оба сценария — скрытие и сохранённый выбор — читают один и тот же каталог.
 */
function mountWithNonChat(t) {
  PROVIDERS.push(NON_CHAT_PROVIDER);
  t.after(() => PROVIDERS.splice(PROVIDERS.indexOf(NON_CHAT_PROVIDER), 1));
}

test('нечат-модель не выводится в выборе', async (t) => {
  mountWithNonChat(t);

  const { wrapper } = await mountChat(t);

  assert.equal(modelOption(wrapper, 'wan3.0-video'), undefined);
  assert.equal(modelOption(wrapper, 'qwen3.8-max').element.disabled, false);
});

test('сохранённый нечат-выбор остаётся видимым запрещённым вариантом', async (t) => {
  mountWithNonChat(t);

  const { wrapper } = await mountChat(t, {
    initial: {
      model: 'wan3.0-video',
      modelRef: { provider: 'qwen', model: 'wan3.0-video' },
    },
  });
  const option = modelOption(wrapper, 'wan3.0-video');

  assert.ok(option, 'селект теряет сохранённое значение без этого варианта');
  assert.equal(option.element.disabled, true);
  assert.match(option.text(), /не для чата/u);
  assert.match(option.attributes('title'), /Генерация видео/u);
});

test('каталог доступных исполнителей не содержит пометок недоступности', async (t) => {
  const { wrapper } = await mountChat(t);
  const groups = wrapper.findAll('.sel.model optgroup');
  const labels = groups.map((group) => group.attributes('label'));

  assert.deepEqual(labels, ['Claude', 'Codex']);
  assert.doesNotMatch(modelOption(wrapper, 'claude-opus-5').attributes('title'), /недоступен/u);
});

test('переключение на модель доступного исполнителя доходит до стора', async (t) => {
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

test('SELECT-CHAT-02: видимый выбор доступного исполнителя доходит до стора', async (t) => {
  const { wrapper, session, setModelCalls, flushPromises } = await mountChat(t);

  await wrapper.get('.sel.model button.ui-select').trigger('click');
  await flushPromises();

  const group = [...document.querySelectorAll('.ui-select-group-nav button')]
    .find((button) => button.textContent.includes('Codex'));

  assert.ok(Boolean(group));
  group.click();
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

for (const unavailable of [[1], [0], [0, 1]]) {
  test(`SELECT-CHAT-UNAVAILABLE: недоступные исполнители скрыты: ${unavailable.join(',')}`, async (t) => {
    for (const index of unavailable) {
      PROVIDERS[index].available = false;
    }

    t.after(() => {
      for (const index of unavailable) {
        PROVIDERS[index].available = true;
      }
    });

    const { wrapper, session, setModelCalls, resetCalls, flushPromises } = await mountChat(t);
    const trigger = wrapper.get('.sel.model button.ui-select');

    assert.match(trigger.text(), /Opus 5/u);
    assert.equal(wrapper.get('.sel.model select').element.value, 'claude-opus-5');
    await trigger.trigger('click');
    await flushPromises();

    const popup = document.querySelector('.ui-select-popup');

    for (const index of unavailable) {
      const provider = PROVIDERS[index];
      const tabs = [...popup.querySelectorAll('.ui-select-group-nav button')];
      const native = modelOption(wrapper, provider.models[0].id);

      assert.equal(tabs.some((button) => button.getAttribute('aria-label') === provider.name), false);
      assert.equal(Boolean(native && !native.element.hidden), false);
    }

    popup.querySelector('[data-select-group="all"]')?.click();
    await flushPromises();
    assert.equal(popup.querySelectorAll('[role="option"]').length, PROVIDERS.length - unavailable.length);

    const search = popup.querySelector('input[type="search"]');

    search.value = unavailable.includes(0) ? 'Opus' : 'GPT';
    search.dispatchEvent(new sharedBrowser.Event('input', { bubbles: true }));
    await flushPromises();
    assert.equal(popup.querySelectorAll('[role="option"]').length, 0);
    assert.equal(session.modelRef.model, 'claude-opus-5');
    assert.deepEqual(setModelCalls, []);
    assert.deepEqual(resetCalls, []);
  });
}

test('SELECT-CHAT-03: GLM показывает имена без wire-массива и длинных повторов', async (t) => {
  const id = JSON.stringify(['zai', 'glm-5.3']);
  const glm = {
    id: 'glm',
    name: 'GLM (Z.ai)',
    available: true,
    models: [{
      id,
      name: 'GLM-5.3',
      contextRuntimeOnly: true,
      efforts: [],
    }],
  };

  PROVIDERS.push(glm);
  t.after(() => PROVIDERS.splice(PROVIDERS.indexOf(glm), 1));

  const { wrapper, setModelCalls, flushPromises } = await mountChat(t, {
    initial: { model: id, modelRef: { provider: 'glm', model: id } },
  });

  await wrapper.get('.sel.model button.ui-select').trigger('click');
  await flushPromises();

  const popup = document.querySelector('.ui-select-popup');
  const rows = [...popup.querySelectorAll('[role="option"]')];

  assert.equal(rows.length, 1);
  assert.equal(rows[0].textContent.trim().replace('✓', '').trim(), 'GLM-5.3');
  assert.equal(popup.textContent.includes('["zai"'), false);
  assert.equal(popup.textContent.includes('после первого хода'), false);
  assert.match(modelOption(wrapper, id).attributes('title'), /рабочее окно появится/u);
  assert.deepEqual(setModelCalls, []);
});

for (const disabled of [[1], [0], [0, 1]]) {
  test(`SELECT-CHAT-OFF: отключённые исполнители скрыты: ${disabled.join(',')}`, async (t) => {
    for (const index of disabled) {
      PROVIDERS[index].chatEnabled = false;
    }

    t.after(() => {
      for (const index of disabled) {
        delete PROVIDERS[index].chatEnabled;
      }
    });

    const { wrapper, setModelCalls, flushPromises } = await mountChat(t);
    const trigger = wrapper.get('.sel.model button.ui-select');

    assert.match(trigger.text(), /Opus 5/u);
    await trigger.trigger('click');
    await flushPromises();

    const popup = document.querySelector('.ui-select-popup');
    const tabs = [...popup.querySelectorAll('.ui-select-group-nav button')];
    const options = [...wrapper.get('.sel.model select').element.options];

    for (const index of disabled) {
      const provider = PROVIDERS[index];

      assert.equal(tabs.some((button) => button.textContent.includes(provider.name)), false);
      assert.equal(options.some((option) => option.value === provider.models[0].id && !option.hidden), false);
    }

    const all = popup.querySelector('[data-select-group="all"]');

    all?.click();
    await flushPromises();
    assert.equal(popup.querySelectorAll('[role="option"]').length, PROVIDERS.length - disabled.length);
    assert.deepEqual(setModelCalls, []);
  });
}


test('SPEED-UI: скорость выбирается рядом с моделью, effort не меняется', async (t) => {
  const { wrapper, session, speedCalls } = await mountChat(t,
    { initial: { speed: 'standard', effort: 'high' } });
  const control = wrapper.find('[data-role="chat-speed"] select');

  assert.equal(control.exists(), true);
  await control.setValue('fast');
  assert.deepEqual(speedCalls, [{ sid: session.id, speed: 'fast' }]);
  assert.equal(session.effort, 'high');
  assert.match(wrapper.find('[data-role="chat-speed"]').attributes('aria-description'),
    /расход|лимит|кредит/iu);
});

test('SPEED-UI-INHERIT: отсутствие старого поля не выдаётся за выключенный Fast', async (t) => {
  const { wrapper } = await mountChat(t);

  const control = wrapper.find('[data-role="chat-speed"] select');

  assert.equal(control.exists(), true);
  assert.equal(control.element.value, '');
});

test('SPEED-UI-UNKNOWN: исчезнувшая поддержка закрывает Fast и сохраняет выбор', async (t) => {
  const { wrapper, session, flushPromises } = await mountChat(t, { initial: { speed: 'fast' } });
  const model = PROVIDERS[0].models[0];
  const previous = model.chatSpeedModes;

  t.after(() => {
    model.chatSpeedModes = previous;
  });
  model.chatSpeedModes = ['standard'];
  await flushPromises();

  const fast = wrapper.find('[data-role="chat-speed"] option[value="fast"]');
  const standard = wrapper.find('[data-role="chat-speed"] option[value="standard"]');

  assert.equal(fast.exists(), true);
  assert.equal(standard.exists(), true);
  assert.equal(fast.element.disabled, true);
  assert.equal(standard.element.disabled, false);
  assert.equal(session.speed, 'fast');
  model.chatSpeedModes = ['standard', 'fast'];
  await flushPromises();
  assert.equal(wrapper.find('[data-role="chat-speed"] option[value="fast"]').element.disabled, false);
});

test('SPEED-UI-OTHER: без capability управление не появляется', async (t) => {
  const previous = PROVIDERS[0].chatSpeed;

  t.after(() => {
    PROVIDERS[0].chatSpeed = previous;
  });
  delete PROVIDERS[0].chatSpeed;

  const { wrapper } = await mountChat(t);

  assert.equal(wrapper.find('[data-role="chat-speed"]').exists(), false);
});

test('SPEED-UI-FROZEN: перенос или сброс памяти блокирует изменение', async (t) => {
  const { wrapper } = await mountChat(t, { initial: { sessionResetting: true } });

  const control = wrapper.find('[data-role="chat-speed"] select');

  assert.equal(control.exists(), true);
  assert.equal(control.element.disabled, true);
});

test('SPEED-ULTRA-UI: synthetic metadata разрешает только Ultrafast без смены effort', async (t) => {
  const provider = {
    id: 'synthetic-speed',
    name: 'Synthetic',
    available: true,
    chatSpeed: { modes: ['standard', 'fast', 'ultrafast'] },
    models: [{
      id: 'speed-ui',
      name: 'Speed UI',
      efforts: ['high'],
      chatSpeedModes: ['standard', 'ultrafast'],
    }],
  };

  PROVIDERS.push(provider);
  t.after(() => {
    PROVIDERS.pop();
  });

  const { wrapper, session, speedCalls, flushPromises } = await mountChat(t, {
    initial: {
    model: 'speed-ui',
    modelRef: { provider: provider.id, model: 'speed-ui' },
    speed: 'standard',
    effort: 'high',
  },
  });
  const control = wrapper.find('[data-role="chat-speed"] select');

  assert.equal(control.exists(), true);
  assert.equal(wrapper.find('[data-role="chat-speed"] option[value="fast"]').element.disabled, true);
  assert.equal(wrapper.find('[data-role="chat-speed"] option[value="ultrafast"]').element.disabled, false);
  await control.setValue('ultrafast');
  assert.deepEqual(speedCalls, [{ sid: session.id, speed: 'ultrafast' }]);
  assert.equal(session.effort, 'high');
  PROVIDERS.at(-1).models[0].chatSpeedModes = ['standard'];
  await flushPromises();
  assert.equal(wrapper.find('[data-role="chat-speed"] option[value="ultrafast"]').element.disabled, true);
  assert.equal(session.speed, 'ultrafast');
});

test('SPEED-UI-CLAUDE: capability не объявляет лишнюю платную скорость', async (t) => {
  const { wrapper } = await mountChat(t);

  assert.equal(wrapper.find('[data-role="chat-speed"] option[value="ultrafast"]').exists(), false);
});
