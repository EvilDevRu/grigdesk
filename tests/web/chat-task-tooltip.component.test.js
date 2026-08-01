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

async function compileSfc(path, id) {
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const source = await readFile(path, 'utf8');
  const { descriptor, errors } = parse(source, { filename: path });
  assert.deepEqual(errors, []);
  return compileScript(descriptor, { id, inlineTemplate: true }).content
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`);
}

async function compileHelpTip() {
  const code = await compileSfc(HELP_TIP_PATH, 'data-v-help-tip-test');
  return (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  )).default;
}

async function compileChatSession() {
  let code = await compileSfc(CHAT_SESSION_PATH, 'data-v-chat-task-tip-test');
  code = code
    .replace(
      "import { useRouter } from 'vue-router';",
      'const useRouter = () => ({ push() {} });',
    )
    .replace(
      "import { api } from '../../shared/api-client.js';",
      'const api = globalThis.__chatTaskTooltipApi;',
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
        props: ['text', 'align', 'fixed', 'triggerFocusable'],
        template: '<span class="help-tip-stub" :data-text="text" :data-fixed="fixed" :data-focusable="triggerFocusable"><slot /></span>',
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
      "import { documentRouteHref } from '../../features/documents/links.js';",
      'const documentRouteHref = () => "";',
    )
    .replace(
      "import { lastModelRun, modelRunView } from '../../shared/chat-model-run.js';",
      "const lastModelRun = () => null; const modelRunView = () => ({ model: '' });",
    );
  return (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  )).default;
}

async function browserHarness(t) {
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
  t.after(() => browser.close());
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
  assert.equal(wrapper.find('[role="tooltip"]').text(), 'Полное название задачи');
  await wrapper.find('.ht').trigger('mouseenter');
  assert.equal(wrapper.find('.ht').classes().includes('on'), true);
});

test('ChatSession передаёт в тултип полное загруженное название выбранной задачи', async (t) => {
  const browser = await browserHarness(t);
  const title = 'Ключевые фразы | Сохранить полный заголовок без обрезания';
  const session = {
    id: 'chat-42',
    taskId: '42',
    title: 'Широкий селект задачи',
    model: '',
    effort: '',
    mode: '',
    messages: [],
    steps: [],
    draft: '',
    sessionId: null,
    contextTokens: 0,
    sending: false,
  };
  globalThis.__chatTaskTooltipApi = {
    async get(path) {
      assert.equal(path, '/api/tasks');
      return { tasks: [{ task: '42', route: 'demo-profile' }] };
    },
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
  });
  globalThis.__chatTaskTooltipTasksStore = () => ({
    async load(id) {
      assert.equal(String(id), '42');
      return { title };
    },
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
    delete globalThis.__chatTaskTooltipProvidersStore;
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
  assert.equal(Object.hasOwn(tip.attributes(), 'data-fixed'), true);
  assert.equal(tip.attributes('data-focusable'), 'false');
  assert.equal(wrapper.find('.sel.task option[value="42"]').text(), `#42 · ${title}`);
});
