import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.__sharedChatContextFill = (await import('../../shared/chat/chatContext.ts')).contextFill;
import { compileVue, webFile } from './helpers/compile-vue.js';
import { compileChatSession as compileChatSessionHarness } from './helpers/chat-session.js';

process.env.NODE_ENV = 'test';

const UI_TOOLTIP_PATH = webFile('src/components/overlays/UiTooltip.vue');

async function compileTooltip() {
  return compileVue(UI_TOOLTIP_PATH);
}

const compileChatSession = () => compileChatSessionHarness('__chatTaskTooltip');

// Окно на весь файл, а не на тест: Vue захватывает `document` один раз при импорте
// runtime-dom, поэтому Teleport подсказки из второго окна ушёл бы в body первого.
let shared = null;

async function browserHarness(t) {
  if (shared) {
    shared.document.body.innerHTML = '<div id="mount"></div>';
    return shared;
  }
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://grigdesk.test/#/chats' });
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
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: (callback) => {
      queueMicrotask(() => callback(Date.now()));

      return 1;
    },
    cancelAnimationFrame: () => {},
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';
  shared = browser;
  return browser;
}

function contextTooltipRows(tip) {
  return Object.fromEntries(tip.findAll('.ctx-pop-row').map((row) => [
    row.get('.ctx-pop-label').text(),
    row.get('.ctx-pop-value').text(),
  ]));
}

/**
 * UiTooltip телепортирует surface за пределы wrapper, поэтому связываем его с trigger
 * по aria-describedby и возвращаем DOMWrapper над фактическим узлом в document.body.
 */
async function openTooltip(wrapper, selector) {
  const trigger = wrapper.get(selector);

  await trigger.trigger('mouseenter');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await wrapper.vm.$nextTick();

  const id = trigger.attributes('aria-describedby');
  const element = document.getElementById(id);
  assert.ok(element, `tooltip ${id || selector} не открылся`);

  const { DOMWrapper } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );

  return new DOMWrapper(element);
}

async function openContextTooltip(wrapper) {
  return (await openTooltip(wrapper, '.ctx-meter')).get('[data-testid="context-tooltip"]');
}

test('UiTooltip не добавляет второй Tab-stop составному триггеру и открывается по наведению', async (t) => {
  const browser = await browserHarness(t);
  const [{ h }, { mount }, UiTooltip] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileTooltip(),
  ]);
  const wrapper = mount(UiTooltip, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      text: 'Полное название задачи',
    },
    slots: {
      trigger: () => h('span', { class: 'compound-trigger' }, [
        h('select', [h('option', 'Задача')]),
      ]),
    },
  });
  t.after(() => wrapper.unmount());

  const trigger = wrapper.get('.compound-trigger');
  assert.equal(trigger.attributes('tabindex'), undefined);
  // Подсказка телепортирована в <body>: искать её в поддереве компонента нельзя,
  // зато её не обрежет ни один скролл-контейнер страницы.
  assert.equal(Boolean(browser.document.querySelector('[role="tooltip"]')), false);
  await trigger.trigger('mouseenter');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await wrapper.vm.$nextTick();
  let tip = browser.document.querySelector('[role="tooltip"]');
  assert.ok(tip);
  assert.equal(browser.document.body.contains(tip), true);
  assert.equal(Boolean(tip.closest('#mount')), false, 'tooltip должен выйти из скролл-контейнера trigger-а');
  assert.equal(tip.textContent.trim(), 'Полное название задачи');
  assert.equal(tip.dataset.state, 'open');

  // У составного триггера своего Tab-stop нет, но фокус внутрь (в <select>) обязан
  // показать подсказку — иначе с клавиатуры её не прочитать.
  await trigger.trigger('mouseleave');
  await new Promise((resolve) => setTimeout(resolve, 120));
  await wrapper.vm.$nextTick();
  assert.equal(Boolean(browser.document.querySelector('[role="tooltip"]')), false);
  await wrapper.find('select').trigger('focusin');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await wrapper.vm.$nextTick();
  tip = browser.document.querySelector('[role="tooltip"]');
  assert.ok(tip);
  assert.equal(tip.dataset.state, 'open');

  await trigger.trigger('focusout');
  await new Promise((resolve) => setTimeout(resolve, 120));
  await wrapper.vm.$nextTick();
  assert.equal(Boolean(browser.document.querySelector('[role="tooltip"]')), false);
});

test('кольцо контекста открывает форматированный UiTooltip без системного title', async (t) => {
  const browser = await browserHarness(t);
  const [{ mount, flushPromises }, { reactive, nextTick }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
  ]);
  const session = reactive({
    id: 'ring-help-tip',
    taskId: null,
    title: 'Тест подсказки',
    model: 'claude-opus-5[1m]',
    effort: '',
    mode: '',
    messages: [],
    steps: [],
    draft: '',
    sessionId: 'claude-session',
    contextTokens: 160_000,
    totalInputTokens: 29_236_962,
    cachedInputTokens: 28_474_880,
    contextCache: {
      scope: 'request', status: 'reported', readTokens: 180_000, writeTokens: 10_000, uncachedTokens: 10_000,
    },
    sending: false,
  });
  globalThis.__chatTaskTooltipApi = { async get() { return { tasks: [] }; } };
  globalThis.__chatTaskTooltipChatStore = () => ({
    sessions: [session],
    compactWindow: 200_000,
    loadConveyor() {},
    markRead() {},
    setDraft() {},
    permFor() { return null; },
    questionFor() { return null; },
    isOnConveyor() { return false; },
    tabLabel() { return session.title; },
  });
  globalThis.__chatTaskTooltipRouter = { async push() {} };
  globalThis.__chatTaskTooltipTasksStore = () => ({ async load() { return null; } });
  globalThis.__chatTaskTooltipUiStore = () => ({ openTaskLaunch() {} });
  globalThis.__chatTaskTooltipProvidersStore = () => ({
    providers: [],
    load() {},
    modelOf() {
      return {
        id: session.model,
        model: { name: 'Opus 5 (1M)', context: 1_000_000, efforts: [] },
        provider: { id: 'claude', capabilities: { chatAutoCompact: true } },
      };
    },
    visibleModels() { return []; },
    modesOf() { return []; },
  });
  const ChatSession = await compileChatSession();
  t.after(() => {
    delete globalThis.__chatTaskTooltipApi;
    delete globalThis.__chatTaskTooltipChatStore;
    delete globalThis.__chatTaskTooltipTasksStore;
    delete globalThis.__chatTaskTooltipUiStore;
    delete globalThis.__chatTaskTooltipProvidersStore;
    delete globalThis.__chatTaskTooltipRouter;
  });

  const wrapper = mount(ChatSession, {
    attachTo: browser.document.querySelector('#mount'),
    props: { sid: session.id },
  });
  t.after(() => wrapper.unmount());
  await flushPromises();

  const ring = wrapper.get('.ctx-meter');
  const headerMeter = wrapper.get('[data-context="chat-header-context"]');

  assert.equal(headerMeter.attributes('aria-valuenow'), '80');
  assert.equal(headerMeter.classes().includes('ui-progress--warning'), true);
  assert.equal(headerMeter.attributes('aria-valuetext'), ring.attributes('aria-label'));
  assert.equal(ring.attributes('title'), undefined);
  assert.match(ring.attributes('aria-label'), /Контекст: 160[\s\u00a0]000/);
  assert.equal(Boolean(browser.document.querySelector('[data-testid="context-tooltip"]')), false);

  await ring.trigger('mouseenter');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await nextTick();
  let content = browser.document.querySelector('[data-testid="context-tooltip"]');
  assert.ok(content, 'форматированный слот не попал в UiTooltip');
  let tip = content.closest('[role="tooltip"]');
  assert.equal(tip.dataset.state, 'open');
  assert.equal(content.querySelector('.ctx-pop-pct')?.textContent.trim(), '80%');
  assert.deepEqual(
    [...content.querySelectorAll('.ctx-pop-label')].map((node) => node.textContent.trim()),
    ['Сейчас', 'Порог', 'Окно', 'За сессию', 'Кэш'],
  );
  const compactValues = Object.fromEntries([...content.querySelectorAll('.ctx-pop-row')].map((row) => [
    row.querySelector('.ctx-pop-label')?.textContent.trim(),
    row.querySelector('.ctx-pop-value')?.textContent.trim(),
  ]));
  assert.equal(compactValues['За сессию'], '29,2 млн');
  assert.match(compactValues.Кэш, /90% · чт\. 180 тыс\. · зап\. 10 тыс\. · мимо 10 тыс\./);
  assert.equal(content.querySelector('.ctx-pop-pct')?.textContent.trim(), '80%', 'процент кольца не смешан с DTO кэша');
  assert.doesNotMatch(content.textContent, /28,5 млн/, 'накопительный счётчик не подменяет снимок запроса');

  session.sending = true;
  await nextTick();
  assert.match(ring.attributes('aria-label'), /замер прошлого хода/);
  session.liveContextUsage = {
    contextTokens: 40_000, contextWindow: 100_000,
    contextMetric: 'active-input-v1', contextIsEstimate: false,
  };
  await nextTick();
  assert.match(ring.attributes('aria-label'), /40[\s\u00a0]000 из 80[\s\u00a0]000.*50%/);
  assert.match(ring.attributes('aria-label'), /замер этого хода/);
  assert.equal(headerMeter.attributes('aria-valuenow'), '50');
  assert.equal(headerMeter.classes().includes('ui-progress--success'), true);

  session.sessionId = null;
  await nextTick();
  assert.match(ring.attributes('aria-label'), /40[\s\u00a0]000 из 80[\s\u00a0]000.*50%/);
  assert.equal(content.querySelector('.ctx-pop-pct')?.textContent.trim(), '50%');
  assert.equal(ring.attributes('aria-disabled'), 'true');
  session.sessionId = 'claude-session';

  session.liveContextUsage.contextTokens = 0;
  await nextTick();
  assert.match(ring.attributes('aria-label'), /Контекст: 0 из/);
  assert.equal(content.querySelector('.ctx-pop-pct')?.textContent.trim(), '0%');
  assert.equal(ring.get('.ctx-meter-value').text(), '0%');
  assert.equal(headerMeter.attributes('aria-valuenow'), '0');

  session.liveContextUsage.contextTokens = 90_000;
  session.liveContextUsage.contextMetric = 'unavailable';
  await nextTick();
  assert.equal(ring.get('.ui-progress__bar').element.style.width, '0%');
  assert.equal(ring.get('.ctx-meter-value').text(), '—');
  assert.equal(Boolean(content.querySelector('.ctx-pop-pct')), false);
  assert.match(content.textContent, /Точная заполненность пока недоступна/);
  assert.equal(ring.classes().includes('hi'), false);
  assert.equal(headerMeter.get('.ui-progress__bar').element.style.width, '0%');
  assert.match(headerMeter.attributes('aria-valuetext'), /недоступна/);

  session.compacting = true;
  await nextTick();
  assert.equal(headerMeter.attributes('aria-valuenow'), undefined);
  assert.equal(headerMeter.find('.is-indeterminate').exists(), true);
  session.compacting = false;
  session.sending = false;
  session.liveContextUsage = null;

  // Временно недоступное действие остаётся фокусируемым: иначе вместе с native disabled
  // клавиатура теряла и саму форматированную подсказку.
  await ring.trigger('mouseleave');
  await new Promise((resolve) => setTimeout(resolve, 120));
  session.sessionId = null;
  await nextTick();
  assert.equal(ring.attributes('disabled'), undefined);
  assert.equal(ring.attributes('aria-disabled'), 'true');
  await ring.trigger('focusin');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await nextTick();
  content = browser.document.querySelector('[data-testid="context-tooltip"]');
  assert.ok(content);
  tip = content.closest('[role="tooltip"]');
  assert.equal(tip.dataset.state, 'open');
  assert.equal(content.querySelector('.ctx-pop-status')?.textContent.trim(), 'Контекст пуст');
});

test('ChatSession передаёт в тултип полное загруженное название выбранной задачи', async (t) => {
  const browser = await browserHarness(t);
  const title = 'Ключевые фразы | Сохранить полный заголовок без обрезания';
  let loadConveyorCalls = 0;
  const previewedImages = [];
  const sentAt = new Date(2030, 0, 1, 12, 0).getTime();
  const session = {
    id: 'chat-42',
    taskId: '42',
    title: 'Широкий селект задачи',
    model: '',
    effort: '',
    mode: '',
    messages: [
      {
        role: 'user',
        text: 'Ошибка в форме',
        sentAt,
        attachments: [{ file: 'shot.png', name: 'Скриншот.png', url: '/api/chat/files/shot.png', mime: 'image/png' }],
      },
      { role: 'assistant', text: 'Воспроизвел проблему' },
    ],
    steps: [],
    draft: '',
    sessionId: 'codex-thread',
    contextTokens: 80_000,
    contextWindow: 256_000,
    contextMetric: 'active-input-v1',
    totalInputTokens: 240_000,
    cachedInputTokens: 220_000,
    contextCache: { scope: 'request', status: 'reported', readTokens: 72_000, uncachedTokens: 8_000 },
    sending: false,
  };
  globalThis.__chatTaskTooltipApi = {
    url(path) { return path; },
    async get(path) {
      assert.equal(path, '/api/tasks');
      return { tasks: [{ task: '42', route: 'demo-profile' }] };
    },
  };
  globalThis.__chatTaskTooltipDocumentPreview = {
    show() {},
    showImage(image) { previewedImages.push(image); },
  };
  globalThis.__chatTaskTooltipChatStore = () => ({
    sessions: [session],
    loadConveyor() {
      loadConveyorCalls += 1;
    },
    markRead() {},
    setDraft() {},
    permFor() { return null; },
    questionFor() { return null; },
    isOnConveyor() { return false; },
    tabLabel() { return session.title; },
  });
  globalThis.__chatTaskTooltipRouter = {
    async push() {
    },
  };
  globalThis.__chatTaskTooltipTasksStore = () => ({
    async load(id) {
      assert.equal(String(id), '42');
      return { title };
    },
  });
  globalThis.__chatTaskTooltipUiStore = () => ({});
  globalThis.__chatTaskTooltipProvidersStore = () => ({
    providers: [],
    load() {},
    modelOf() {
      return {
        id: 'gpt-test',
        model: { name: 'GPT Test', context: 200000, efforts: [] },
        provider: { id: 'codex', capabilities: { chatAutoCompact: true } },
      };
    },
    visibleModels() { return []; },
    modesOf() { return []; },
  });
  t.after(() => {
    delete globalThis.__chatTaskTooltipApi;
    delete globalThis.__chatTaskTooltipChatStore;
    delete globalThis.__chatTaskTooltipTasksStore;
    delete globalThis.__chatTaskTooltipUiStore;
    delete globalThis.__chatTaskTooltipProvidersStore;
    delete globalThis.__chatTaskTooltipRouter;
    delete globalThis.__chatTaskTooltipDocumentPreview;
  });

  const [{ mount, flushPromises }, ChatSession] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileChatSession(),
  ]);
  const wrapper = mount(ChatSession, {
    attachTo: browser.document.querySelector('#mount'),
    props: { sid: session.id },
  });
  t.after(() => wrapper.unmount());
  await flushPromises();
  await flushPromises();

  const taskTip = await openTooltip(wrapper, '.task-tip');
  assert.equal(taskTip.text(), `#42 · ${title}`);
  assert.equal(wrapper.get('.task-tip').attributes('tabindex'), undefined);
  assert.equal(wrapper.find('.sel.task option[value="42"]').text(), `#42 · ${title}`);

  const ring = wrapper.find('.ctx-meter');
  const ringLabel = ring.attributes('aria-label');
  assert.equal(ring.attributes('title'), undefined, 'native title снова создаст системную подсказку');
  assert.equal(ring.classes().includes('ctx-tip'), true);
  assert.ok(ring.attributes('aria-describedby'));
  // Заполненность — доля практического потолка (здесь автосжатие выключено, значит 80%
  // окна), а окно модели осталось справочной строкой: см. gotchas про кольцо.
  assert.match(ringLabel, /Контекст: 80[\s ]000 из 204[\s ]800 до потолка окна \(39%\)/);
  assert.match(ringLabel, /окно модели 256[\s ]000/);
  assert.match(ringLabel, /за сессию обработано 240[\s\u00a0]000 входных токенов/);
  assert.match(ringLabel, /кэш: 90% · чт\. 72 тыс\. · мимо 8 тыс\./);
  const contextTip = await openContextTooltip(wrapper);

  assert.equal(contextTip.get('.ctx-pop-head b').text(), 'Контекст сессии');
  assert.equal(contextTip.get('.ctx-pop-unit').text(), '· токены');
  assert.equal(contextTip.get('.ctx-pop-pct').text(), '39%');
  const rows = contextTooltipRows(contextTip);
  assert.match(rows.Сейчас, /80[\s\u00a0]000/);
  assert.match(rows.Порог, /204[\s\u00a0]800 · 80% окна/);
  assert.match(rows.Окно, /256[\s\u00a0]000/);
  assert.match(rows['За сессию'], /240[\s\u00a0]000/);
  assert.match(rows.Кэш, /90% · чт\. 72 тыс\. · мимо 8 тыс\./);
  assert.doesNotMatch(contextTip.text(), /220[\s\u00a0]000/);
  assert.deepEqual(contextTip.findAll('.ctx-pop-action').map((action) => action.text()), [
    'Кликсжать',
    'Alt + кликсбросить',
  ]);
  const messageTime = wrapper.find('.msg.user .m-time');
  assert.equal(messageTime.text(), new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(sentAt)));
  assert.equal(messageTime.attributes('datetime'), new Date(sentAt).toISOString());
  assert.match(messageTime.attributes('data-ui-tooltip'), /^Отправлено /);

  await wrapper.find('.m-atts a').trigger('click');
  assert.deepEqual(previewedImages, [{
    src: '/api/chat/files/shot.png',
    name: 'Скриншот.png',
    mime: 'image/png',
  }]);

  // Сессия привязана к задаче и содержит сообщения: раньше обе кнопки были доступны.
  // Проверяем узлы интерфейса, не пользовательский текст ленты или название задачи.
  assert.equal(wrapper.find('.cs').exists(), true);
  assert.equal(wrapper.find('.cs-input').exists(), true);
  assert.equal(wrapper.find('.cs-act').exists(), false);
  assert.equal(wrapper.findAll('[data-role="chat-task-action"]').length, 0);
  assert.equal(loadConveyorCalls, 0, 'чат не загружает статус конвейера ради снятой кнопки');
});

test('ChatSession сохраняет выбранную модель после асинхронного reset Kimi', async (t) => {
  const browser = await browserHarness(t);
  const [{ reactive, nextTick }, { mount, flushPromises }] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
  ]);
  const models = {
    kimi: [{ id: 'kimi-code/k3', name: 'K3', context: 131072, efforts: [] }],
    codex: [{ id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol', context: 258400, efforts: [] }],
  };
  const providers = [
    { id: 'kimi', name: 'Kimi', available: true, models: models.kimi },
    { id: 'codex', name: 'Codex', available: true, models: models.codex },
  ];
  const session = reactive({
    id: 'kimi-model-switch',
    taskId: null,
    title: 'Kimi model switch',
    model: 'kimi-code/k3',
    modelRef: { provider: 'kimi', model: 'kimi-code/k3' },
    revision: 3,
    effort: '',
    mode: '',
    messages: [],
    steps: [],
    draft: '',
    sessionId: 'kimi-session',
    contextTokens: 100,
    sending: false,
    compacting: false,
    sessionResetting: false,
  });
  const setModels = [];
  let resets = 0;
  const modelOf = (value) => {
    const ref = value && typeof value === 'object' ? value : null;
    const id = ref?.model || value || '';
    const provider = providers.find((candidate) => (
      candidate.id === ref?.provider || candidate.models.some((model) => model.id === id)
    )) || null;
    const model = provider?.models.find((candidate) => candidate.id === id) || null;
    return { id, model, provider };
  };
  globalThis.__chatTaskTooltipApi = { async get() { return { tasks: [] }; } };
  globalThis.__chatTaskTooltipChatStore = () => ({
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
    async resetContext() {
      resets += 1;
      session.sessionResetting = true;
      await nextTick();
      session.messages.push({ role: 'note', text: 'Память агента сброшена' });
      session.sessionResetting = false;
      await nextTick();
      return true;
    },
    setModel(_id, model) {
      setModels.push(model);
      const resolved = modelOf(model);
      session.model = resolved.id;
      session.modelRef = { provider: resolved.provider.id, model: resolved.model.id };
    },
  });
  globalThis.__chatTaskTooltipRouter = { async push() {} };
  globalThis.__chatTaskTooltipTasksStore = () => ({ async load() { return null; } });
  globalThis.__chatTaskTooltipUiStore = () => ({ openTaskLaunch() {} });
  globalThis.__chatTaskTooltipProvidersStore = () => ({
    providers,
    load() {},
    modelOf,
    visibleModels(provider) { return provider.models; },
    modesOf() { return []; },
  });
  const ChatSession = await compileChatSession();
  t.after(() => {
    delete globalThis.__chatTaskTooltipApi;
    delete globalThis.__chatTaskTooltipChatStore;
    delete globalThis.__chatTaskTooltipTasksStore;
    delete globalThis.__chatTaskTooltipUiStore;
    delete globalThis.__chatTaskTooltipProvidersStore;
    delete globalThis.__chatTaskTooltipRouter;
  });

  const wrapper = mount(ChatSession, {
    attachTo: browser.document.querySelector('#mount'),
    props: { sid: session.id },
  });
  t.after(() => wrapper.unmount());
  await flushPromises();

  const select = wrapper.find('.sel.model select');
  assert.equal(select.element.value, 'kimi-code/k3');
  await select.setValue('gpt-5.6-sol');
  await flushPromises();

  assert.equal(resets, 1);
  assert.deepEqual(setModels, ['gpt-5.6-sol']);
  assert.deepEqual(session.modelRef, { provider: 'codex', model: 'gpt-5.6-sol' });
  assert.equal(select.element.value, 'gpt-5.6-sol');
});

test('ChatSession возвращает селект задачи к привязке чата, если переход не подтверждён', async (t) => {
  const browser = await browserHarness(t);
  const [{ reactive }, { mount, flushPromises }] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
  ]);
  const session = reactive({
    id: 'task-select-cancel',
    taskId: null,
    title: 'Свободный чат',
    model: '',
    effort: '',
    mode: '',
    messages: [],
    steps: [],
    draft: '',
    sending: false,
    compacting: false,
    sessionResetting: false,
  });
  const requested = [];

  globalThis.__chatTaskTooltipApi = {
    async get() {
      return { tasks: [{ task: '42', route: 'demo-profile' }] };
    },
  };
  globalThis.__chatTaskTooltipChatStore = () => ({
    sessions: [session],
    compactWindow: 0,
    loadConveyor() {},
    markRead() {},
    setDraft() {},
    permFor: () => null,
    questionFor: () => null,
    isOnConveyor: () => false,
    tabLabel: () => session.title,
    // Переход ждёт решения в окне выбора или получил отказ: привязка чата не изменилась.
    async setTask(_id, taskId) {
      requested.push(taskId);

      return false;
    },
  });
  globalThis.__chatTaskTooltipRouter = { async push() {} };
  globalThis.__chatTaskTooltipTasksStore = () => ({ load: async () => null });
  globalThis.__chatTaskTooltipUiStore = () => ({ openTaskLaunch() {} });
  globalThis.__chatTaskTooltipProvidersStore = () => ({
    providers: [],
    load() {},
    modelOf: () => ({
      id: '',
      model: null,
      provider: null
    }),
    visibleModels: () => [],
    modesOf: () => [],
  });

  const ChatSession = await compileChatSession();

  t.after(() => {
    delete globalThis.__chatTaskTooltipApi;
    delete globalThis.__chatTaskTooltipChatStore;
    delete globalThis.__chatTaskTooltipTasksStore;
    delete globalThis.__chatTaskTooltipUiStore;
    delete globalThis.__chatTaskTooltipProvidersStore;
    delete globalThis.__chatTaskTooltipRouter;
  });

  const wrapper = mount(ChatSession, {
    attachTo: browser.document.querySelector('#mount'),
    props: { sid: session.id },
  });

  t.after(() => wrapper.unmount());
  await flushPromises();

  const select = wrapper.find('.sel.task select');

  assert.equal(select.element.value, '');
  await select.setValue('42');
  await flushPromises();
  assert.deepEqual(requested, ['42']);
  assert.equal(session.taskId, null);
  assert.equal(select.element.value, '', 'селект показывает фактическую привязку чата');
});

// Сторож согласованности шкал кольца. Цвет считался от порога сжатия, а дуга и подсказка —
// от окна модели: на 1M это расходилось впятеро (жёлтое кольцо, залитое на 17%), и человек
// читал форму, а не оттенок — «места ещё дофига», пока CLI уже сжимал контекст по кругу.
test('ChatSession рисует полосу и процент по тому же порогу, что и его цвет', async (t) => {
  const browser = await browserHarness(t);
  const [{ mount, flushPromises }, { reactive, nextTick }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
  ]);
  const CONTEXT_TOKENS = 160_000; // синтетические 80% от порога сжатия
  const COMPACT_WINDOW = 200_000; // «Настройки → Запуски → Сжимать контекст чата»
  const MODEL_WINDOW = 1_000_000; // окно Opus 5 (1M) — впятеро больше порога
  const session = reactive({
    id: 'ctx-ring-scale',
    taskId: null,
    title: 'Тестовый проект',
    model: 'claude-opus-5[1m]',
    effort: '',
    mode: '',
    messages: [],
    steps: [],
    draft: '',
    sessionId: 'claude-session',
    contextTokens: CONTEXT_TOKENS,
    sending: false,
  });
  globalThis.__chatTaskTooltipApi = { async get() { return { tasks: [] }; } };
  globalThis.__chatTaskTooltipChatStore = () => ({
    sessions: [session],
    compactWindow: COMPACT_WINDOW,
    loadConveyor() {},
    markRead() {},
    setDraft() {},
    permFor() { return null; },
    questionFor() { return null; },
    isOnConveyor() { return false; },
    tabLabel() { return session.title; },
  });
  globalThis.__chatTaskTooltipRouter = { async push() {} };
  globalThis.__chatTaskTooltipTasksStore = () => ({ async load() { return null; } });
  globalThis.__chatTaskTooltipUiStore = () => ({ openTaskLaunch() {} });
  globalThis.__chatTaskTooltipProvidersStore = () => ({
    providers: [],
    load() {},
    modelOf() {
      return {
        id: 'claude-opus-5[1m]',
        model: { name: 'Opus 5 (1M)', context: MODEL_WINDOW, efforts: [] },
        provider: { id: 'claude', capabilities: { chatAutoCompact: true } },
      };
    },
    visibleModels() { return []; },
    modesOf() { return []; },
  });
  const ChatSession = await compileChatSession();
  t.after(() => {
    delete globalThis.__chatTaskTooltipApi;
    delete globalThis.__chatTaskTooltipChatStore;
    delete globalThis.__chatTaskTooltipTasksStore;
    delete globalThis.__chatTaskTooltipUiStore;
    delete globalThis.__chatTaskTooltipProvidersStore;
    delete globalThis.__chatTaskTooltipRouter;
  });

  const wrapper = mount(ChatSession, {
    attachTo: browser.document.querySelector('#mount'),
    props: { sid: session.id },
  });
  t.after(() => wrapper.unmount());
  await flushPromises();

  const ring = wrapper.find('.ctx-meter');
  assert.equal(ring.attributes('title'), undefined);
  // Порог сжатия ниже потолка окна (80% от 1M), значит считаем по нему и так и пишем.
  assert.match(ring.attributes('aria-label'), /Контекст: 160[\s ]000 из 200[\s ]000 до сжатия \(80%\)/);
  assert.match(ring.attributes('aria-label'), /порог близко — пора сжать/);
  assert.doesNotMatch(ring.attributes('aria-label'), /уже подорожал/);
  // Окно модели остаётся справочным: как основная шкала оно и обещало запас, которого нет.
  assert.match(ring.attributes('aria-label'), /окно модели 1[\s ]000[\s ]000/);
  const contextTip = await openContextTooltip(wrapper);

  assert.equal(contextTip.get('.ctx-pop-head b').text(), 'Контекст сессии');
  assert.equal(contextTip.get('.ctx-pop-pct').text(), '80%');
  assert.equal(ring.get('.ctx-meter-value').text(), '80%');
  assert.equal(contextTip.get('.ctx-pop-status').text(), 'Порог близко — пора сжать');
  assert.match(contextTooltipRows(contextTip).Порог, /200[\s\u00a0]000 · автосжатие/);
  assert.equal(ring.classes().includes('mid'), true);

  // Форма обязана говорить то же, что цвет: дуга заполнена на те же 80%, а не на 16%.
  const filled = parseFloat(ring.get('.ui-progress__bar').element.style.width) / 100;
  assert.ok(
    Math.abs(filled - CONTEXT_TOKENS / COMPACT_WINDOW) < 0.01,
    `дуга залита на ${Math.round(filled * 100)}% — она обязана идти по порогу сжатия`,
  );
  assert.ok(filled > CONTEXT_TOKENS / MODEL_WINDOW * 2, 'дуга снова считается от окна модели');

  session.contextTokens = COMPACT_WINDOW;
  await nextTick();
  assert.match(ring.attributes('aria-label'), /порог достигнут — пора сжать/);
  assert.equal(contextTip.get('.ctx-pop-status').text(), 'Порог достигнут — пора сжать');
  assert.equal(contextTip.get('.ctx-pop-pct').text(), '100%');
  assert.equal(ring.get('.ctx-meter-value').text(), '100%');
  assert.equal(ring.classes().includes('hi'), true);
});

// Старый реестр мог оставить поле эвристической «границы цены». Оно больше не является
// частью шкалы: заполненность и цвет считаются только от контекста.
test('ChatSession игнорирует устаревшую границу стоимости provider-а', async (t) => {
  const browser = await browserHarness(t);
  const [{ mount, flushPromises }, { reactive, nextTick }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
  ]);
  const CONTEXT_TOKENS = 200_000;
  const LEGACY_COST_CLIFF = 250_000;
  const MODEL_WINDOW = 1_000_000; // окно Fable 5 — встроенный миллион
  const session = reactive({
    id: 'ctx-ring-cliff',
    taskId: null,
    title: 'Тестовый проект',
    model: 'claude-fable-5',
    effort: '',
    mode: '',
    messages: [],
    steps: [],
    draft: '',
    sessionId: 'claude-session',
    contextTokens: CONTEXT_TOKENS,
    contextCache: { scope: 'request', status: 'unavailable' },
    sending: false,
  });
  globalThis.__chatTaskTooltipApi = { async get() { return { tasks: [] }; } };
  globalThis.__chatTaskTooltipChatStore = () => ({
    sessions: [session],
    compactWindow: 0, // «Настройки → Запуски»: автосжатие выключено человеком
    loadConveyor() {},
    markRead() {},
    setDraft() {},
    permFor() { return null; },
    questionFor() { return null; },
    isOnConveyor() { return false; },
    tabLabel() { return session.title; },
  });
  globalThis.__chatTaskTooltipRouter = { async push() {} };
  globalThis.__chatTaskTooltipTasksStore = () => ({ async load() { return null; } });
  globalThis.__chatTaskTooltipUiStore = () => ({ openTaskLaunch() {} });
  globalThis.__chatTaskTooltipProvidersStore = () => ({
    providers: [],
    load() {},
    modelOf() {
      return {
        id: 'claude-fable-5',
        model: { name: 'Fable 5', context: MODEL_WINDOW, efforts: [] },
        provider: { id: 'claude', contextCostCliff: LEGACY_COST_CLIFF },
      };
    },
    visibleModels() { return []; },
    modesOf() { return []; },
  });
  const ChatSession = await compileChatSession();
  t.after(() => {
    delete globalThis.__chatTaskTooltipApi;
    delete globalThis.__chatTaskTooltipChatStore;
    delete globalThis.__chatTaskTooltipTasksStore;
    delete globalThis.__chatTaskTooltipUiStore;
    delete globalThis.__chatTaskTooltipProvidersStore;
    delete globalThis.__chatTaskTooltipRouter;
  });

  const wrapper = mount(ChatSession, {
    attachTo: browser.document.querySelector('#mount'),
    props: { sid: session.id },
  });
  t.after(() => wrapper.unmount());
  await flushPromises();

  const ring = wrapper.find('.ctx-meter');
  assert.equal(ring.attributes('title'), undefined);
  assert.match(ring.attributes('aria-label'), /Контекст: 200[\s ]000 из 800[\s ]000 до потолка окна \(25%\)/);
  assert.doesNotMatch(ring.attributes('aria-label'), /подорож/);
  assert.equal(ring.classes().includes('mid'), false);
  const contextTip = await openContextTooltip(wrapper);
  assert.equal(contextTooltipRows(contextTip).Кэш, 'нет данных');

  const filled = parseFloat(ring.get('.ui-progress__bar').element.style.width) / 100;
  assert.ok(
    Math.abs(filled - CONTEXT_TOKENS / (MODEL_WINDOW * 0.8)) < 0.01,
    `дуга залита на ${Math.round(filled * 100)}% — она обязана идти по 80% окна`,
  );
  assert.ok(filled < CONTEXT_TOKENS / LEGACY_COST_CLIFF / 2, 'старая отсечка снова управляет кольцом');

  session.contextTokens = MODEL_WINDOW * 0.8;
  await nextTick();
  assert.match(ring.attributes('aria-label'), /порог достигнут — пора сжать/);
  assert.doesNotMatch(contextTip.text(), /подорож/);
  assert.equal(ring.classes().includes('hi'), true);
});

test('ChatSession показывает provider-нейтральный статус кэша без тарифа', async (t) => {
  const browser = await browserHarness(t);
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const session = {
    id: 'ctx-ring-fake',
    taskId: null,
    title: 'Локальная модель',
    model: 'fake/qwen',
    effort: '',
    mode: '',
    messages: [],
    steps: [],
    draft: '',
    sessionId: 'fake-session',
    contextTokens: 200_000,
    contextCache: { scope: 'request', status: 'not-applicable' },
    sending: false,
  };
  globalThis.__chatTaskTooltipApi = { async get() { return { tasks: [] }; } };
  globalThis.__chatTaskTooltipChatStore = () => ({
    sessions: [session],
    compactWindow: 200_000,
    loadConveyor() {},
    markRead() {},
    setDraft() {},
    permFor() { return null; },
    questionFor() { return null; },
    isOnConveyor() { return false; },
    tabLabel() { return session.title; },
  });
  globalThis.__chatTaskTooltipRouter = { async push() {} };
  globalThis.__chatTaskTooltipTasksStore = () => ({ async load() { return null; } });
  globalThis.__chatTaskTooltipUiStore = () => ({ openTaskLaunch() {} });
  globalThis.__chatTaskTooltipProvidersStore = () => ({
    providers: [],
    load() {},
    modelOf() {
      return {
        id: 'fake/qwen',
        model: { name: 'Qwen', context: 1_000_000, efforts: [] },
        provider: { id: 'fake' },
      };
    },
    visibleModels() { return []; },
    modesOf() { return []; },
  });
  const ChatSession = await compileChatSession();
  t.after(() => {
    delete globalThis.__chatTaskTooltipApi;
    delete globalThis.__chatTaskTooltipChatStore;
    delete globalThis.__chatTaskTooltipTasksStore;
    delete globalThis.__chatTaskTooltipUiStore;
    delete globalThis.__chatTaskTooltipProvidersStore;
    delete globalThis.__chatTaskTooltipRouter;
  });

  const wrapper = mount(ChatSession, {
    attachTo: browser.document.querySelector('#mount'),
    props: { sid: session.id },
  });
  t.after(() => wrapper.unmount());
  await flushPromises();

  const ring = wrapper.find('.ctx-meter');
  assert.equal(ring.attributes('title'), undefined);
  assert.match(ring.attributes('aria-label'), /Контекст: 200[\s ]000 из 800[\s ]000 до потолка окна \(25%\)/);
  assert.doesNotMatch(ring.attributes('aria-label'), /подорож/);
  assert.equal(contextTooltipRows(await openContextTooltip(wrapper)).Кэш, 'без тарифа');
  assert.equal(ring.classes().includes('mid'), false);
  assert.equal(ring.classes().includes('hi'), false);
});

test('ChatSession показывает неподтверждённое окно до первого хода и в picker модели', async (t) => {
  const browser = await browserHarness(t);
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const model = {
    id: 'claude-fable-5',
    name: 'Fable 5',
    context: 200_000,
    contextUnverified: true,
    efforts: [],
  };
  const provider = {
    id: 'claude',
    name: 'Claude',
    available: true,
    models: [model],
  };
  const session = {
    id: 'ctx-unverified-empty',
    taskId: null,
    title: 'Новый чат',
    model: model.id,
    modelRef: { provider: provider.id, model: model.id },
    effort: '',
    mode: '',
    messages: [],
    steps: [],
    draft: '',
    sessionId: null,
    contextTokens: 0,
    sending: false,
  };
  globalThis.__chatTaskTooltipApi = { async get() { return { tasks: [] }; } };
  globalThis.__chatTaskTooltipChatStore = () => ({
    sessions: [session],
    compactWindow: 0,
    loadConveyor() {},
    markRead() {},
    setDraft() {},
    permFor() { return null; },
    questionFor() { return null; },
    isOnConveyor() { return false; },
    tabLabel() { return session.title; },
  });
  globalThis.__chatTaskTooltipRouter = { async push() {} };
  globalThis.__chatTaskTooltipTasksStore = () => ({ async load() { return null; } });
  globalThis.__chatTaskTooltipUiStore = () => ({ openTaskLaunch() {} });
  globalThis.__chatTaskTooltipProvidersStore = () => ({
    providers: [provider],
    load() {},
    modelOf() { return { id: model.id, model, provider }; },
    visibleModels(value) { return value.models; },
    modesOf() { return []; },
  });
  const ChatSession = await compileChatSession();
  t.after(() => {
    delete globalThis.__chatTaskTooltipApi;
    delete globalThis.__chatTaskTooltipChatStore;
    delete globalThis.__chatTaskTooltipTasksStore;
    delete globalThis.__chatTaskTooltipUiStore;
    delete globalThis.__chatTaskTooltipProvidersStore;
    delete globalThis.__chatTaskTooltipRouter;
  });

  const wrapper = mount(ChatSession, {
    attachTo: browser.document.querySelector('#mount'),
    props: { sid: session.id },
  });
  t.after(() => wrapper.unmount());
  await flushPromises();

  const ring = wrapper.find('.ctx-meter');
  const ringLabel = ring.attributes('aria-label');
  assert.equal(ring.attributes('title'), undefined);
  assert.match(ringLabel, /Контекст: пусто/);
  assert.match(ringLabel, /окно модели 200[\s ]000 \(не подтверждено\)/);
  const contextTip = await openContextTooltip(wrapper);
  assert.match(contextTip.text(), /Контекст пуст/);
  assert.match(contextTooltipRows(contextTip).Окно, /200[\s\u00a0]000 · неточно/);

  const select = wrapper.find('.sel.model .ui-select-wrap');

  assert.match(select.attributes('data-ui-tooltip'), /окно не подтверждено/);
  const option = wrapper.find('.sel.model option[value="claude-fable-5"]');
  assert.match(option.text(), /Fable 5 · окно не подтверждено/);
  assert.match(option.attributes('title'), /окно не подтверждено/);
});

test('ChatSession показывает рабочее окно Codex из живой сессии вместо заглушки каталога', async (t) => {
  const browser = await browserHarness(t);
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const model = {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6-Sol',
    context: 0,
    contextUnverified: true,
    contextRuntimeOnly: true,
    efforts: [],
  };
  const provider = {
    id: 'codex',
    name: 'GPT (Codex)',
    available: true,
    models: [model],
  };
  const session = {
    id: 'codex-runtime-context',
    taskId: null,
    title: 'Рабочее окно Codex',
    model: model.id,
    modelRef: { provider: provider.id, model: model.id },
    effort: '',
    mode: '',
    messages: [],
    steps: [],
    draft: '',
    sessionId: 'codex-thread',
    contextTokens: 110_512,
    contextWindow: 258_400,
    contextMetric: 'active-input-v1',
    contextCache: { scope: 'request', status: 'unavailable' },
    sending: false,
  };
  globalThis.__chatTaskTooltipApi = { async get() { return { tasks: [] }; } };
  globalThis.__chatTaskTooltipChatStore = () => ({
    sessions: [session],
    compactWindow: 0,
    loadConveyor() {},
    markRead() {},
    setDraft() {},
    permFor() { return null; },
    questionFor() { return null; },
    isOnConveyor() { return false; },
    tabLabel() { return session.title; },
  });
  globalThis.__chatTaskTooltipRouter = { async push() {} };
  globalThis.__chatTaskTooltipTasksStore = () => ({ async load() { return null; } });
  globalThis.__chatTaskTooltipUiStore = () => ({ openTaskLaunch() {} });
  globalThis.__chatTaskTooltipProvidersStore = () => ({
    providers: [provider],
    load() {},
    modelOf() { return { id: model.id, model, provider }; },
    visibleModels(value) { return value.models; },
    modesOf() { return []; },
  });
  const ChatSession = await compileChatSession();
  t.after(() => {
    delete globalThis.__chatTaskTooltipApi;
    delete globalThis.__chatTaskTooltipChatStore;
    delete globalThis.__chatTaskTooltipTasksStore;
    delete globalThis.__chatTaskTooltipUiStore;
    delete globalThis.__chatTaskTooltipProvidersStore;
    delete globalThis.__chatTaskTooltipRouter;
  });

  const wrapper = mount(ChatSession, {
    attachTo: browser.document.querySelector('#mount'),
    props: { sid: session.id },
  });
  t.after(() => wrapper.unmount());
  await flushPromises();

  const select = wrapper.get('.sel.model .ui-select-wrap');

  assert.match(select.attributes('data-ui-tooltip'), /рабочее окно 258[\s\u00a0]400 токенов/);
  assert.doesNotMatch(select.attributes('data-ui-tooltip'), /400[\s\u00a0]?000|400K/i);

  const option = wrapper.get('.sel.model option[value="gpt-5.6-sol"]');
  assert.equal(option.text(), 'GPT-5.6-Sol');
  assert.match(option.attributes('title'), /рабочее окно 258[\s\u00a0]400 токенов/);

  const ring = wrapper.get('.ctx-meter');
  assert.match(ring.attributes('aria-label'), /110[\s\u00a0]512 из 206[\s\u00a0]720/);
  assert.match(ring.attributes('aria-label'), /окно модели 258[\s\u00a0]400/);
  assert.equal(contextTooltipRows(await openContextTooltip(wrapper)).Окно, '258 400');
});
