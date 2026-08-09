import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';

const CHAT_SESSION_PATH = fileURLToPath(
  new URL('../../web/src/views/chat/ChatSession.vue', import.meta.url),
);
const HELP_TIP_PATH = fileURLToPath(
  new URL('../../web/src/shared/ui/HelpTip.vue', import.meta.url),
);
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;
const LAYER_STACK_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/src/shared/ui/layer-stack.js', import.meta.url),
)).href;

async function compileSfc(path, id) {
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const source = await readFile(path, 'utf8');
  const { descriptor, errors } = parse(source, { filename: path });
  assert.deepEqual(errors, []);
  return compileScript(descriptor, { id, inlineTemplate: true }).content
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`)
    .replace("from './layer-stack.js'", `from "${LAYER_STACK_URL}"`);
}

async function compileHelpTip() {
  const code = await compileSfc(HELP_TIP_PATH, 'data-v-help-tip-test');
  return (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  )).default;
}

let chatSessionInstance = 0;
async function compileChatSession() {
  let code = await compileSfc(CHAT_SESSION_PATH, 'data-v-chat-task-tip-test');
  code = code
    .replace(
      "import { useRouter } from 'vue-router';",
      'const useRouter = () => globalThis.__chatTaskTooltipRouter || ({ push() {} });',
    )
    .replace(
      "import { api } from '../../shared/api-client.js';",
      'const api = globalThis.__chatTaskTooltipApi;',
    )
    .replace(
      "import { createSpeechStream } from '../../shared/speech-stream.js';",
      'const createSpeechStream = async () => null;',
    )
    .replace(
      "import { useChatStore, CONTEXT_WINDOW } from '../../stores/chat.js';",
      'const CONTEXT_WINDOW = 200000; const useChatStore = globalThis.__chatTaskTooltipChatStore;',
    )
    .replace(
      "import { useTasksStore } from '../../stores/tasks.js';",
      'const useTasksStore = globalThis.__chatTaskTooltipTasksStore;',
    )
    .replace(
      "import { useUiStore } from '../../stores/ui.js';",
      'const useUiStore = globalThis.__chatTaskTooltipUiStore;',
    )
    .replace(
      "import { useProvidersStore } from '../../stores/providers.js';",
      'const useProvidersStore = globalThis.__chatTaskTooltipProvidersStore;',
    )
    .replace(
      "import EffortSlider from './EffortSlider.vue';",
      'const EffortSlider = { template: "<span></span>" };',
    )
    .replace(
      "import StepList from './StepList.vue';",
      'const StepList = { template: "<span></span>" };',
    )
    .replace(
      "import ChatQuestion from './ChatQuestion.vue';",
      'const ChatQuestion = { template: "<span></span>" };',
    )
    .replace(
      "import ChatPermission from './ChatPermission.vue';",
      'const ChatPermission = { template: "<span></span>" };',
    )
    .replace(
      "import HelpTip from '../../shared/ui/HelpTip.vue';",
      `const HelpTip = {
        props: ['text', 'align', 'triggerFocusable', 'tipStyle'],
        template: '<span class="help-tip-stub" :data-text="text" :data-focusable="triggerFocusable"><slot /></span>',
      };`,
    )
    .replace(
      "import { confirmDialog } from '../../shared/ui/confirm.js';",
      // Модалка подтверждения лезет в document.head/body; тултипу задачи она не нужна,
      // а «согласие» по умолчанию делает заглушку безопасной для будущих проверок кольца.
      'const confirmDialog = async () => true;',
    )
    .replace(
      "import { mdToHtml } from '../../shared/md.js';",
      'const mdToHtml = (text) => text;',
    )
    .replace(
      "import { documentLinkFromClick, documentRouteHref } from '../../features/documents/links.js';",
      'const documentLinkFromClick = () => ""; const documentRouteHref = () => "";',
    )
    .replace(
      "import { useDocumentPreviewStore } from '../../stores/document-preview.js';",
      'const useDocumentPreviewStore = () => globalThis.__chatTaskTooltipDocumentPreview || ({ show() {}, showImage() {} });',
    )
    .replace(
      "import { lastModelRun, modelRunView } from '../../shared/chat-model-run.js';",
      "const lastModelRun = () => null; const modelRunView = () => ({ model: '' });",
    );
  return (await import(
    `data:text/javascript;base64,${Buffer.from(`${code}\n// экземпляр ${++chatSessionInstance}`).toString('base64')}`
  )).default;
}

// Окно на весь файл, а не на тест: Vue захватывает `document` один раз при импорте
// runtime-dom, поэтому Teleport подсказки из второго окна ушёл бы в body первого.
let shared = null;

async function browserHarness(t) {
  if (shared) {
    shared.document.body.innerHTML = '<div id="mount"></div>';
    return shared;
  }
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://cockpit.test/#/chats' });
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
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';
  shared = browser;
  return browser;
}

test('HelpTip не добавляет второй Tab-stop составному триггеру и открывается по наведению', async (t) => {
  const browser = await browserHarness(t);
  const [{ h }, { mount }, HelpTip] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileHelpTip(),
  ]);
  const wrapper = mount(HelpTip, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      text: 'Полное название задачи',
      triggerFocusable: false,
    },
    slots: {
      default: () => h('select', [h('option', 'Задача')]),
    },
  });
  t.after(() => wrapper.unmount());

  assert.equal(wrapper.find('.ht-tr').attributes('tabindex'), undefined);
  // Подсказка телепортирована в <body>: искать её в поддереве компонента нельзя,
  // зато её не обрежет ни один скролл-контейнер страницы.
  const tip = browser.document.querySelector('[role="tooltip"]');
  assert.equal(tip.parentElement, browser.document.body);
  assert.equal(tip.textContent.trim(), 'Полное название задачи');
  await wrapper.find('.ht').trigger('mouseenter');
  assert.equal(tip.classList.contains('on'), true);

  // У составного триггера своего Tab-stop нет, но фокус внутрь (в <select>) обязан
  // показать подсказку — иначе с клавиатуры её не прочитать.
  await wrapper.find('.ht').trigger('mouseleave');
  await new Promise((r) => setTimeout(r, 260)); // гашение отложено — ждём его
  await wrapper.vm.$nextTick();
  assert.equal(tip.classList.contains('on'), false);
  await wrapper.find('select').trigger('focusin');
  assert.equal(tip.classList.contains('on'), true);
});

test('ChatSession передаёт в тултип полное загруженное название выбранной задачи', async (t) => {
  const browser = await browserHarness(t);
  const title = 'Ключевые фразы | Сохранить полный заголовок без обрезания';
  const debugCalls = [];
  const routes = [];
  const openedTasks = [];
  const previewedImages = [];
  const sentAt = new Date(2026, 7, 5, 14, 7).getTime();
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
    contextTokens: 83_286,
    contextWindow: 258_400,
    contextMetric: 'active-input-v1',
    totalInputTokens: 25_626_388,
    cachedInputTokens: 25_025_792,
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
    loadConveyor() {},
    markRead() {},
    setDraft() {},
    permFor() { return null; },
    questionFor() { return null; },
    isOnConveyor() { return false; },
    tabLabel() { return session.title; },
    async openDebugFor(payload) { debugCalls.push(payload); },
  });
  globalThis.__chatTaskTooltipRouter = { async push(path) { routes.push(path); } };
  globalThis.__chatTaskTooltipTasksStore = () => ({
    async load(id) {
      assert.equal(String(id), '42');
      return { title };
    },
  });
  globalThis.__chatTaskTooltipUiStore = () => ({
    openTaskLaunch(id) { openedTasks.push(String(id)); },
  });
  globalThis.__chatTaskTooltipProvidersStore = () => ({
    providers: [],
    load() {},
    modelOf() {
      return {
        id: 'gpt-test',
        model: { name: 'GPT Test', context: 200000, efforts: [] },
        provider: { id: 'codex' },
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
    props: { sid: session.id, variant: 'page' },
  });
  t.after(() => wrapper.unmount());
  await flushPromises();
  await flushPromises();

  const tip = wrapper.find('.help-tip-stub');
  assert.equal(tip.attributes('data-text'), `#42 · ${title}`);
  assert.equal(tip.attributes('data-focusable'), 'false');
  assert.equal(wrapper.find('.sel.task option[value="42"]').text(), `#42 · ${title}`);
  const ringTitle = wrapper.find('.ctx-ring').attributes('title');
  assert.match(ringTitle, /Контекст: 83[\s\u00a0]286 из 258[\s\u00a0]400 токенов \(32%\)/);
  assert.match(ringTitle, /за сессию обработано 25[\s\u00a0]626[\s\u00a0]388 входных токенов/);
  assert.match(ringTitle, /25[\s\u00a0]025[\s\u00a0]792 из кэша/);
  const messageTime = wrapper.find('.msg.user .m-time');
  assert.equal(messageTime.text(), new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(sentAt)));
  assert.equal(messageTime.attributes('datetime'), new Date(sentAt).toISOString());
  assert.match(messageTime.attributes('title'), /^Отправлено /);

  await wrapper.find('.m-atts a').trigger('click');
  assert.deepEqual(previewedImages, [{
    src: '/api/chat/files/shot.png',
    name: 'Скриншот.png',
    mime: 'image/png',
  }]);

  const debugTip = wrapper.find('.debug-tip');
  assert.match(debugTip.attributes('data-text'), /отдельный Debug-чат в той же песочнице/);
  assert.match(debugTip.attributes('data-text'), /Новый конвейер не создаётся, черновик останется неотправленным/);
  await wrapper.find('.cs-act .act:not(.debug-act)').trigger('click');
  assert.deepEqual(openedTasks, ['42']);
  assert.match(wrapper.find('.lm').text(), /проверь параметры запуска в карточке задачи/);
  await wrapper.find('.debug-act').trigger('click');
  await flushPromises();
  assert.deepEqual(debugCalls, [{
    taskId: '42',
    taskTitle: title,
    sourceChatId: 'chat-42',
    context: 'Пользователь: Ошибка в форме\n\nАгент: Воспроизвел проблему',
  }]);
  assert.deepEqual(routes, ['/chats']);
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
    props: { sid: session.id, variant: 'page' },
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
