// Меню слэш-команд чата: секция Cockpit + секция выбранного исполнителя.
// Merge с дедупликацией (кокпит глушит дубль), фильтр по префиксу, клавиатурная
// навигация мимо пунктов run:'none', dispatch провайдерской команды с признаком
// slashCommand. Компонентный монтаж ChatSession.vue (test-first, план §3.5).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';

const CHAT_SESSION_PATH = fileURLToPath(
  new URL('../../web/src/views/chat/ChatSession.vue', import.meta.url),
);
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;

async function compileChatSession() {
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const source = await readFile(CHAT_SESSION_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: CHAT_SESSION_PATH });
  assert.deepEqual(errors, []);
  let code = compileScript(descriptor, { id: 'data-v-slash-menu-test', inlineTemplate: true }).content
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`);
  code = code
    .replace(
      "import { useRouter } from 'vue-router';",
      'const useRouter = () => globalThis.__slashMenuRouter || ({ push() {} });',
    )
    .replace(
      "import { api } from '../../shared/api-client.js';",
      'const api = globalThis.__slashMenuApi;',
    )
    .replace(
      "import { useChatStore, CONTEXT_WINDOW } from '../../stores/chat.js';",
      'const CONTEXT_WINDOW = 200000; const useChatStore = globalThis.__slashMenuChatStore;',
    )
    .replace(
      "import { useTasksStore } from '../../stores/tasks.js';",
      'const useTasksStore = globalThis.__slashMenuTasksStore;',
    )
    .replace(
      "import { useUiStore } from '../../stores/ui.js';",
      'const useUiStore = globalThis.__slashMenuUiStore;',
    )
    .replace(
      "import { useProvidersStore } from '../../stores/providers.js';",
      'const useProvidersStore = globalThis.__slashMenuProvidersStore;',
    )
    .replace("import EffortSlider from './EffortSlider.vue';", 'const EffortSlider = { template: "<span></span>" };')
    .replace("import StepList from './StepList.vue';", 'const StepList = { template: "<span></span>" };')
    .replace("import ChatQuestion from './ChatQuestion.vue';", 'const ChatQuestion = { template: "<span></span>" };')
    .replace("import ChatPermission from './ChatPermission.vue';", 'const ChatPermission = { template: "<span></span>" };')
    .replace(
      "import HelpTip from '../../shared/ui/HelpTip.vue';",
      `const HelpTip = {
        props: ['text', 'align', 'triggerFocusable', 'tipStyle'],
        template: '<span class="help-tip-stub" :data-text="text"><slot /></span>',
      };`,
    )
    .replace(
      "import { confirmDialog } from '../../shared/ui/confirm.js';",
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
      'const useDocumentPreviewStore = () => ({ show() {}, showImage() {} });',
    )
    .replace(
      "import { lastModelRun, modelRunView } from '../../shared/chat-model-run.js';",
      "const lastModelRun = () => null; const modelRunView = () => ({ model: '' });",
    );
  return (await import(
    `data:text/javascript;base64,${Buffer.from(`${code}\n// slash-menu ${Date.now()}`).toString('base64')}`
  )).default;
}

let shared = null;

async function browserHarness() {
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
    Document: browser.Document,
    ShadowRoot: browser.ShadowRoot,
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

const PROVIDER_COMMANDS = [
  { cmd: '/compact', desc: 'Kimi-версия компакта (дубль — скрывается)', run: 'prompt' },
  { cmd: '/status', desc: 'Состояние сессии Kimi', run: 'prompt' },
  { cmd: '/goal', desc: 'Автономная цель', run: 'none', hint: 'только в TUI' },
];

const KIMI_PROVIDER = {
  id: 'kimi',
  name: 'Kimi Code',
  color: '#6657d9',
  available: true,
  models: [{ id: 'kimi-code/k3', name: 'K3', context: 131072, efforts: [] }],
  commands: PROVIDER_COMMANDS,
};

function makeSession(overrides = {}) {
  return {
    id: 'slash-chat',
    taskId: null,
    title: 'Чат',
    model: 'kimi-code/k3',
    modelRef: { provider: 'kimi', model: 'kimi-code/k3' },
    effort: '',
    mode: '',
    messages: [{ role: 'user', text: 'уже общаемся' }],
    steps: [],
    draft: '',
    sessionId: 'kimi-session',
    contextTokens: 100,
    sending: false,
    compacting: false,
    sessionResetting: false,
    ...overrides,
  };
}

async function mountChat(t, { session = makeSession(), provider = KIMI_PROVIDER, sendResult = true } = {}) {
  const browser = await browserHarness();
  const sendCalls = [];
  const calls = { newSession: 0, clearChat: 0, resetContext: 0 };
  globalThis.__slashMenuApi = { url: (p) => p, async get() { return { tasks: [] }; } };
  globalThis.__slashMenuChatStore = () => ({
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
    async send(...args) { sendCalls.push(args); return sendResult; },
    newSession() { calls.newSession += 1; },
    clearChat() { calls.clearChat += 1; },
    async resetContext() { calls.resetContext += 1; return true; },
    async openDebugFor() {},
    async stop() {},
  });
  globalThis.__slashMenuRouter = { async push() {} };
  globalThis.__slashMenuTasksStore = () => ({ async load() { return null; } });
  globalThis.__slashMenuUiStore = () => ({ openTaskLaunch() {} });
  globalThis.__slashMenuProvidersStore = () => ({
    providers: provider ? [provider] : [],
    load() {},
    modelOf(value) {
      const ref = value && typeof value === 'object' ? value : null;
      if (!ref || !provider || ref.provider !== provider.id) return { id: ref?.model || '', model: null, provider: null };
      return { id: ref.model, model: provider.models[0], provider };
    },
    visibleModels(p) { return p.models; },
    modesOf() { return []; },
  });
  t.after(() => {
    delete globalThis.__slashMenuApi;
    delete globalThis.__slashMenuChatStore;
    delete globalThis.__slashMenuTasksStore;
    delete globalThis.__slashMenuUiStore;
    delete globalThis.__slashMenuProvidersStore;
    delete globalThis.__slashMenuRouter;
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
  return { wrapper, sendCalls, calls, flushPromises };
}

function menuState(wrapper) {
  const heads = wrapper.findAll('.cmd-menu .cmd-head').map((el) => el.text());
  const items = wrapper.findAll('.cmd-menu button.cmd').map((el) => ({
    cmd: el.find('.c-cmd').text(),
    desc: el.find('.c-desc').text(),
    on: el.classes('on'),
    disabled: el.attributes('disabled') !== undefined,
  }));
  return { heads, items };
}

test('меню объединяет секции Cockpit и исполнителя, дедуп по имени (кокпит сильнее)', async (t) => {
  const { wrapper } = await mountChat(t);
  await wrapper.find('textarea').setValue('/');
  const { heads, items } = menuState(wrapper);

  assert.deepEqual(heads, ['Cockpit', 'Kimi Code']);
  const cmds = items.map((i) => i.cmd);
  assert.deepEqual(cmds, ['/compact', '/clear', '/reset', '/new', '/status', '/goal']);
  const compact = items.filter((i) => i.cmd === '/compact');
  assert.equal(compact.length, 1, 'провайдерский дубль /compact скрыт');
  assert.match(compact[0].desc, /Сжать контекст/);
  const goal = items.find((i) => i.cmd === '/goal');
  assert.equal(goal.disabled, true, 'run:none пункт не выбирается');
});

test('фильтр по префиксу работает по обеим секциям', async (t) => {
  const { wrapper } = await mountChat(t);
  await wrapper.find('textarea').setValue('/st');
  const { heads, items } = menuState(wrapper);
  assert.deepEqual(items.map((i) => i.cmd), ['/status']);
  assert.deepEqual(heads, ['Kimi Code'], 'пустая секция кокпита не рисуется');
});

test('клавиатура: стрелки пропускают none-пункты, Enter выбирает подсвеченное', async (t) => {
  const { wrapper, sendCalls } = await mountChat(t);
  const input = wrapper.find('textarea');
  await input.setValue('/');
  // Выбираемых пять: 4 кокпит + /status. /goal (run:none) пропускается.
  for (let i = 0; i < 5; i += 1) await input.trigger('keydown', { key: 'ArrowDown' });
  let { items } = menuState(wrapper);
  assert.equal(items.find((i) => i.on)?.cmd, '/compact', 'после полного круга — снова первый');
  assert.equal(items.find((i) => i.cmd === '/goal').on, false);
  for (let i = 0; i < 4; i += 1) await input.trigger('keydown', { key: 'ArrowDown' });
  ({ items } = menuState(wrapper));
  assert.equal(items.find((i) => i.on)?.cmd, '/status');
  await input.trigger('keydown', { key: 'Enter' });
  assert.equal(sendCalls.length, 1);
  assert.deepEqual(sendCalls[0], ['slash-chat', '/status', [], { slashCommand: '/status' }]);
});

test('none-команда не отправляется: точный ввод уходит обычным сообщением', async (t) => {
  const { wrapper, sendCalls } = await mountChat(t);
  const input = wrapper.find('textarea');
  await input.setValue('/goal');
  await input.trigger('keydown', { key: 'Enter' });
  assert.equal(sendCalls.length, 1);
  assert.deepEqual(sendCalls[0].slice(0, 3), ['slash-chat', '/goal', []]);
  assert.equal(sendCalls[0][3]?.slashCommand, undefined, 'признак служебного хода не ставится');
});

test('клик по провайдерской команде: send с slashCommand, ввод очищается', async (t) => {
  const { wrapper, sendCalls } = await mountChat(t);
  await wrapper.find('textarea').setValue('/');
  const statusBtn = wrapper.findAll('.cmd-menu button.cmd')
    .find((el) => el.find('.c-cmd').text() === '/status');
  await statusBtn.trigger('click');
  assert.deepEqual(sendCalls, [['slash-chat', '/status', [], { slashCommand: '/status' }]]);
  assert.equal(wrapper.find('textarea').element.value, '');
});

test('accepted === false возвращает команду в поле ввода', async (t) => {
  const { wrapper } = await mountChat(t, { sendResult: false });
  await wrapper.find('textarea').setValue('/');
  const statusBtn = wrapper.findAll('.cmd-menu button.cmd')
    .find((el) => el.find('.c-cmd').text() === '/status');
  await statusBtn.trigger('click');
  assert.equal(wrapper.find('textarea').element.value, '/status');
});

test('frozen (сжатие/reset): провайдерская команда не выполняется', async (t) => {
  const { wrapper, sendCalls } = await mountChat(t, { session: makeSession({ compacting: true }) });
  await wrapper.find('textarea').setValue('/');
  const statusBtn = wrapper.findAll('.cmd-menu button.cmd')
    .find((el) => el.find('.c-cmd').text() === '/status');
  await statusBtn.trigger('click');
  assert.equal(sendCalls.length, 0);
});

test('провайдер не резолвлен — только секция Cockpit', async (t) => {
  const { wrapper } = await mountChat(t, { session: makeSession({ modelRef: null, model: 'legacy-x' }) });
  await wrapper.find('textarea').setValue('/');
  const { heads, items } = menuState(wrapper);
  assert.deepEqual(heads, ['Cockpit']);
  assert.deepEqual(items.map((i) => i.cmd), ['/compact', '/clear', '/reset', '/new']);
});

test('команды кокпита работают как раньше (/new, /clear)', async (t) => {
  const { wrapper, calls, sendCalls } = await mountChat(t);
  await wrapper.find('textarea').setValue('/new');
  await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
  assert.equal(calls.newSession, 1);
  assert.equal(sendCalls.length, 0, 'клиентская команда на сервер не уходит');
});
