import { compileVue, webFile } from './compile-vue.js';

export const CHAT_SESSION_PATH = webFile('src/views/chat/ChatSession.vue');

/**
 * Сценарии композера используют настоящие кнопки и раскрытия общего UI-kit.
 * Подменяется только подтверждение, требующее ответа человека.
 */
function uiFacadeStub(prefix) {
  const components = [
    ['UiButton', 'src/components/primitives/UiButton.vue'],
    ['UiDisclosureButton', 'src/components/composites/UiDisclosureButton.vue'],
    ['UiFilePicker', 'src/components/composites/UiFilePicker.vue'],
    ['UiIconButton', 'src/components/primitives/UiIconButton.vue'],
    ['UiInput', 'src/components/primitives/UiInput.vue'],
    ['UiPressable', 'src/components/primitives/UiPressable.vue'],
    ['UiSelect', 'src/components/primitives/UiSelect.vue'],
    ['UiSpinner', 'src/components/primitives/UiSpinner.vue'],
    ['UiTextarea', 'src/components/primitives/UiTextarea.vue'],
    ['UiTooltip', 'src/components/overlays/UiTooltip.vue'],
    ['UiPopover', 'src/components/overlays/UiPopover.vue'],
  ];
  const imports = components.map(([name, file]) => (
    `import ${name} from ${JSON.stringify(webFile(file))};`
  ));
  const names = components.map(([name]) => name).join(', ');

  return [
    ...imports,
    'export { vTooltip } from "./src/services/tooltipDirective.ts";',
    `export { ${names} };`,
    'export const confirmDialog = (...args) => {',
    `  const handler = globalThis.${prefix}ConfirmDialog;`,
    '  return handler ? handler(...args) : Promise.resolve(true);',
    '};',
  ].join('\n');
}

function speechProviderStub(prefix) {
  return [
    'const idleLease = {',
    "  state: { phase: 'idle', busy: false, prompt: null, interim: '', notice: '' },",
    '  async start() {},',
    '  async stop() {},',
    '  async cancel() {},',
    '  async confirmBrowserConsent() {},',
    '  async useWhisper() {},',
    '  async installBrowserLanguage() {},',
    '  async release() {},',
    '};',
    'export function useDictationController() {',
    `  const helper = globalThis.${prefix}UseController;`,
    '  return helper ? helper() : { acquire: () => idleLease };',
    '}',
  ].join('\n');
}

function effortSliderStub() {
  return [
    'export default {',
    '  name: "EffortSlider",',
    '  props: ["modelValue", "levels", "hints", "disabled", "hint"],',
    '  emits: ["update:modelValue"],',
    '  template: `<span class="eff eff-stub"></span>`,',
    '};',
  ].join('\n');
}

function inertComponentStub(className) {
  return [
    'export default {',
    '  inheritAttrs: false,',
    `  template: '<span class="${className}"></span>',`,
    '};',
  ].join('\n');
}

/**
 * ChatSession бандлится единым TS-aware compiler-ом с настоящими UI primitives.
 * Stores, сеть, speech-controller и product children остаются границами сценария.
 */
export function compileChatSession(prefix, { realSteps = false, expose = [], stubs = {} } = {}) {
  return compileVue(CHAT_SESSION_PATH, {
    expose,
    stubs: {
      'vue-router': [
        'export const useRouter = () =>',
        `  globalThis.${prefix}Router || { push() {} };`,
      ].join('\n'),
      '../../shared/apiClient.ts': `export const api = globalThis.${prefix}Api;`,
      '../../features/speech/provider.ts': speechProviderStub(prefix),
      '../../stores/chat.ts': [
        `export const CONTEXT_WINDOW = globalThis.${prefix}ContextWindow || 200000;`,
        `export const useChatStore = globalThis.${prefix}ChatStore;`,
      ].join('\n'),
      '../../../../shared/chat/chatContext.ts': [
        'export const contextFill = (...args) =>',
        '  globalThis.__sharedChatContextFill(...args);',
      ].join('\n'),
      '../../shared/clipboard.ts': [
        'export async function writeClipboardText(...args) {',
        `  const helper = globalThis.${prefix}WriteClipboardText;`,
        '  return helper ? helper(...args) : true;',
        '}',
      ].join('\n'),
      '../../stores/tasks.ts': `export const useTasksStore = globalThis.${prefix}TasksStore;`,
      '../../stores/ui.ts': `export const useUiStore = globalThis.${prefix}UiStore;`,
      '../../stores/providers.ts': (
        `export const useProvidersStore = globalThis.${prefix}ProvidersStore;`
      ),
      './EffortSlider.vue': effortSliderStub(),
      ...(realSteps ? {} : { './StepList.vue': inertComponentStub('step-list-stub') }),
      './ChatQuestion.vue': inertComponentStub('chat-question-stub'),
      './ChatPermission.vue': inertComponentStub('chat-permission-stub'),
      './ChatWorkdir.vue': inertComponentStub('chat-workdir-stub'),
      '../../ui': uiFacadeStub(prefix),
      './codeHighlight.ts': 'export const highlightCode = async () => null;',
      './mermaidRender.ts': 'export const renderMermaid = async () => null;',
      '../clipboard.ts': 'export const writeClipboardText = async () => false;',
      '../md.ts': [
        "export * from './src/shared/md.ts';",
        "import { mdTokensToHtml as realTokensToHtml } from './src/shared/md.ts';",
        'export const mdTokensToHtml = (tokens, ...rest) => {',
        `  const renderer = globalThis.${prefix}MarkdownRenderer;`,
        '  if (!renderer) return realTokensToHtml(tokens, ...rest);',
        "  return renderer(tokens.map((token) => token.raw).join(''), ...rest);",
        '};',
      ].join('\n'),
      '../../shared/md.ts': [
        'export const mdToHtml = (...args) => {',
        `  const renderer = globalThis.${prefix}MarkdownRenderer;`,
        '  return renderer ? renderer(...args) : String(args[0] || "");',
        '};',
      ].join('\n'),
      '../../features/documents/links.ts': 'export const documentLinkFromClick = () => "";',
      '../../features/code/links.ts': [
        'export const chatFileLinkHref = () => "";',
        'export const codeLinkFromClick = () => null;',
        'export const loadCodeRoots = () => Promise.resolve([]);',
      ].join('\n'),
      '../../shared/tools/launcher.ts': [
        'export function useToolLauncher() {',
        `  return globalThis.${prefix}ToolLauncher || { openTool() {} };`,
        '}',
      ].join('\n'),
      '../../stores/documentPreview.ts': [
        'export function useDocumentPreviewStore() {',
        `  return globalThis.${prefix}DocumentPreview || { show() {}, showImage() {} };`,
        '}',
      ].join('\n'),
      '../../shared/chatModelRun.ts': [
        'export const lastModelRun = () => null;',
        'export const modelRunView = () => ({ model: "" });',
      ].join('\n'),
      ...stubs,
    },
  });
}


/**
 * У загрузки вложений настоящий ChatSession, а результат API задаётся тестом.
 * Два чата позволяют проверить, что поздний ответ остаётся у инициатора загрузки.
 */
export async function chatUploadBoundaryFixture(t, { stubs = {} } = {}) {
  const { reactive } = await import('../../../web/node_modules/vue/index.mjs');
  const { mount, flushPromises } = await import(
    '../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const { contextFill } = await import('../../../shared/chat/chatContext.ts');

  globalThis.__sharedChatContextFill = contextFill;

  const sessions = reactive(['a', 'b'].map((id) => ({
    id,
    title: 'Чат',
    model: 'test-model',
    modelRef: {provider: 'test-provider', model: 'test-model'},
    messages: [],
    steps: [],
    draft: '',
    draftAttachments: [],
    sending: false,
  })));
  const store = {
    sessions,
    archived: [],
    compactWindow: 0,
    loadConveyor() {},
    markRead() {},
    permFor: () => null,
    questionFor: () => null,
    isOnConveyor: () => false,
    tabLabel: () => 'Чат',
    setDraft(id, text) {
      const session = sessions.find((session) => session.id === id);

      if (session) {
        session.draft = text;
      }
    },
    addDraftAttachment(id, attachment) {
      sessions.find((session) => session.id === id).draftAttachments.push(attachment);
    },
  };
  const reply = { value: /** @type {unknown} */ (null) };
  const calls = [];
  const model = {
    id: 'test-model',
    name: 'Модель',
    efforts: []
  };
  const provider = {
    id: 'test-provider',
    name: 'Исполнитель',
    models: [model],
    commands: []
  };

  globalThis.__uploadBoundaryApi = {
    url: (value) => value,
    get: async () => ({tasks: []}),
    upload: async (url) => {
      calls.push(url);

      return reply.value;
    },
  };
  globalThis.__uploadBoundaryChatStore = () => store;
  globalThis.__uploadBoundaryTasksStore = () => ({load: async () => null});
  globalThis.__uploadBoundaryUiStore = () => ({openTaskLaunch() {}});
  globalThis.__uploadBoundaryProvidersStore = () => ({
    providers: [provider],
    load() {},
    modelOf: () => ({
      id: model.id,
      model,
      provider
    }),
    visibleModels: () => [model],
    modesOf: () => [],
  });

  const Component = await compileChatSession('__uploadBoundary', { expose: ['addFiles', 'inputErr'], stubs });
  const wrapper = mount(Component, {props: {sid: 'a'}});

  t.after(() => wrapper.unmount());
  await flushPromises();

  return {
    wrapper,
    sessions,
    reply,
    calls
  };
}
