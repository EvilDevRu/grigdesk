// Проверяет интеграцию корневого хоста компаньона с UI и внешними зависимостями.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileCompanionSfc,
  installCompanionBrowser,
} from './helpers/companion-component.js';
import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';

const HOST_PATH = webFile('src/features/companion/CompanionHost.vue');
let compileNonce = 0;

async function compileHost(deps, t) {
  const key = `__companionHostDeps${compileNonce++}`;
  globalThis[key] = deps;
  t.after(() => { delete globalThis[key]; });
  const fromDeps = `globalThis[${JSON.stringify(key)}]`;

  return compileVue(HOST_PATH, {
    stubs: {
      'vue-router': `
        export const useRoute = () => ${fromDeps}.useRoute();
        export const useRouter = () => ${fromDeps}.useRouter();
      `,
      '../../ui': `
        export const UiFloatingDialog = ${fromDeps}.UiFloatingDialog;
      `,
      '../../stores/chat.js': `
        export const CONTEXT_WINDOW = ${fromDeps}.CONTEXT_WINDOW;
        export const useChatStore = (...args) => ${fromDeps}.useChatStore(...args);
      `,
      '../../stores/companion.js': `
        export const useCompanionStore = (...args) => ${fromDeps}.useCompanionStore(...args);
      `,
      '../../stores/providers.js': `
        export const useProvidersStore = (...args) => ${fromDeps}.useProvidersStore(...args);
      `,
      '../../../../shared/chatContext.ts': `
        export const contextFill = (...args) => ${fromDeps}.contextFill(...args);
      `,
      '../../stores/notify-watch.js': `
        export const useNotifyWatchStore = (...args) => ${fromDeps}.useNotifyWatchStore(...args);
      `,
      '../../stores/ui-context.js': `
        export const useUiContextStore = (...args) => ${fromDeps}.useUiContextStore(...args);
      `,
      '../speech/provider.js': `
        export const useDictationController = (...args) =>
          ${fromDeps}.useDictationController(...args);
      `,
      './chat-bridge.js': `
        export const createCompanionChatBridge = (...args) =>
          ${fromDeps}.createCompanionChatBridge(...args);
      `,
      './speech-output.js': `
        export const createSpeechOutput = (...args) => ${fromDeps}.createSpeechOutput(...args);
      `,
      './CompanionAvatar.vue': `export default ${fromDeps}.CompanionAvatar;`,
      './CompanionBubble.vue': `export default ${fromDeps}.CompanionBubble;`,
    },
  });
}

test('COMP-A11Y-HOST-01: runtime focus, layer Escape, /chats и cleanup lifecycle', async (t) => {
  const browser = await installCompanionBrowser(t);
  const [
    {
      defineComponent,
      h,
      cloneVNode,
      nextTick,
      onScopeDispose,
      reactive,
      toValue,
      watch,
    },
    { mount, flushPromises },
    { activeLayerId, registerUiLayer },
    CompanionAvatar,
    CompanionBubble,
  ] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileModule(webFile('src/services/layers/stack.ts')),
    compileCompanionSfc('CompanionAvatar'),
    compileCompanionSfc('CompanionBubble'),
  ]);

  const route = reactive({ path: '/pipeline' });
  const lifecycle = {
    closes: 0,
    disconnects: 0,
    surfaces: [],
    scopeSyncs: [],
    routerPushes: [],
  };
  const companion = reactive({
    bubbleOpen: false,
    deviceEnabled: true,
    contextPinned: false,
    pinnedTaskId: null,
    currentChatId: null,
    draft: '',
    dictationState: { interim: '', prompt: '' },
    interaction: 'idle',
    attention: { kind: 'none', count: 0, taskIds: [], chatId: null },
    attentionDestination: '',
    statusLabel: 'Готов к сообщению',
    lastReply: '',
    speechBusy: false,
    transcribing: false,
    thinking: false,
    stopping: false,
    canSend: false,
    muted: true,
    outputState: { available: false },
    ttsConsentPrompt: false,
    speechError: '',
    chatError: '',
    chatErrorCode: '',
    outputError: '',
  });
  Object.assign(companion, {
    connect() {
      return () => { lifecycle.disconnects += 1; };
    },
    openBubble() { companion.bubbleOpen = true; },
    async closeBubble() {
      lifecycle.closes += 1;
      companion.bubbleOpen = false;
      return true;
    },
    syncPageScope(taskId) { lifecycle.scopeSyncs.push(taskId); },
    setSurfaceVisible(value) { lifecycle.surfaces.push(value); },
    setAttentionSnapshot() {},
    syncReply() {},
    handleTarget() {},
    updateOutput() {},
    setDraft(value) { companion.draft = value; },
    sendText() {},
    toggleVoice() {},
    cancelVoice() {},
    stopTurn() {},
    toggleMute() {},
    confirmTtsConsent() {},
    dismissTtsConsent() {},
    openConversation() {},
    confirmBrowserConsent() {},
    useWhisper() {},
    installBrowserLanguage() {},
  });
  const chat = reactive({
    sessions: [], archived: [], pending: {}, speech: { language: 'ru' },
    session: () => null,
  });
  const notifyWatch = reactive({ waiting: [], stalled: [], silent: [], running: [] });
  const uiContext = {
    capture: () => ({
      routingScope: { kind: 'task', taskId: '42' },
      promptContext: { page: 'Конвейер', path: route.path },
    }),
  };
  const router = {
    async push(path) {
      lifecycle.routerPushes.push(path);
      route.path = path;
    },
  };
  let layerSequence = 0;
  function useUiLayer(name, options = {}) {
    let handle = null;
    const stop = watch(
      () => options.enabled === undefined || Boolean(toValue(options.enabled)),
      (enabled) => {
        handle?.unregister();
        handle = enabled
          ? registerUiLayer(options.id || `host-layer-${++layerSequence}`, {
              name: toValue(name),
              close: (event) => options.onEscape?.(event),
              element: options.element === undefined
                ? undefined
                : () => toValue(options.element),
            })
          : null;
      },
      { immediate: true, flush: 'sync' },
    );

    onScopeDispose(() => {
      stop();
      handle?.unregister();
    });
  }
  const UiFloatingDialog = defineComponent({
    props: {
      open: Boolean,
    },
    emits: ['update:open'],
    setup(props, { emit, slots }) {
      useUiLayer('companion', {
        id: 'companion-bubble',
        enabled: () => props.open,
        onEscape: () => {
          emit('update:open', false);
        },
      });

      async function setOpen(value, returnFocus = false) {
        emit('update:open', value);

        if (returnFocus) {
          await nextTick();
          browser.document.querySelector('.companion-avatar')?.focus();
        }
      }

      return () => {
        const trigger = slots.trigger?.()[0];
        const triggerWithClick = trigger
          ? cloneVNode(trigger, { onClick: () => setOpen(!props.open) })
          : null;
        const content = props.open
          ? slots.default?.({ close: () => setOpen(false, true) })
          : null;

        return h('div', { class: 'floating-dialog-stub' }, [triggerWithClick, content]);
      };
    },
  });
  const Host = await compileHost({
    useRoute: () => route,
    useRouter: () => router,
    UiFloatingDialog,
    useChatStore: () => chat,
    useCompanionStore: () => companion,
    useNotifyWatchStore: () => notifyWatch,
    useProvidersStore: () => ({ modelOf: () => ({ provider: null, model: null }) }),
    contextFill: () => ({ limit: 200000, pct: 0, tone: '', limitWhat: 'до сжатия', limitShort: 'автосжатие' }),
    CONTEXT_WINDOW: 200000,
    useUiContextStore: () => uiContext,
    useDictationController: () => ({}),
    createCompanionChatBridge: () => ({}),
    createSpeechOutput: () => ({}),
    TransitionStub: {
      setup: (_props, { slots }) => () => slots.default?.(),
    },
    CompanionAvatar,
    CompanionBubble,
  }, t);
  const PageHarness = defineComponent({
    setup: () => () => h('main', [
      route.path === '/chats'
        ? h('textarea', { 'data-testid': 'page-chat-composer' })
        : null,
      h(Host),
    ]),
  });
  const wrapper = mount(PageHarness, {
    attachTo: browser.document.querySelector('#mount'),
  });

  assert.equal(wrapper.find('.companion-host').exists(), true);
  assert.equal(wrapper.find('[data-testid="companion-composer"]').exists(), false);
  await wrapper.find('.companion-avatar').trigger('click');
  await flushPromises();
  const composer = wrapper.find('[data-testid="companion-composer"]');
  assert.equal(composer.exists(), true);
  assert.equal(browser.document.activeElement === composer.element, true,
    'avatar open transfers focus to the compact composer');

  await wrapper.find('.icon-control.close').trigger('click');
  await flushPromises();
  const avatar = wrapper.find('.companion-avatar');
  assert.equal(wrapper.find('[data-testid="companion-composer"]').exists(), false);
  assert.equal(browser.document.activeElement === avatar.element, true,
    'explicit close returns focus to the avatar');

  let lowerCloses = 0;
  const lowerLayer = registerUiLayer('host-test-lower', {
    name: 'dock',
    close: () => { lowerCloses += 1; },
  });
  await avatar.trigger('click');
  await flushPromises();
  assert.equal(activeLayerId(), 'companion-bubble');

  let upperCloses = 0;
  let upperLayer = null;
  upperLayer = registerUiLayer('host-test-upper', {
    name: 'dialog',
    close: () => {
      upperCloses += 1;
      upperLayer?.unregister();
    },
  });
  const firstEscape = new browser.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  });
  browser.document.body.dispatchEvent(firstEscape);
  await flushPromises();
  assert.equal(upperCloses, 1);
  assert.equal(lowerCloses, 0);
  assert.equal(companion.bubbleOpen, true, 'higher layer consumes one Escape without closing Host');

  const secondEscape = new browser.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  });
  browser.document.body.dispatchEvent(secondEscape);
  await flushPromises();
  assert.equal(secondEscape.defaultPrevented, true);
  assert.equal(companion.bubbleOpen, false);
  assert.equal(lowerCloses, 0, 'the same Escape closes only the top companion layer');
  assert.equal(activeLayerId(), 'host-test-lower');

  await wrapper.find('.companion-avatar').trigger('click');
  await flushPromises();
  Object.defineProperty(browser.document, 'hidden', { value: true, configurable: true });
  browser.document.dispatchEvent(new browser.Event('visibilitychange'));
  assert.equal(lifecycle.surfaces.at(-1), false);
  Object.defineProperty(browser.document, 'hidden', { value: false, configurable: true });
  browser.document.dispatchEvent(new browser.Event('visibilitychange'));
  assert.equal(lifecycle.surfaces.at(-1), true);

  route.path = '/chats';
  await nextTick();
  await flushPromises();
  assert.equal(wrapper.find('.companion-host').exists(), false);
  assert.equal(wrapper.find('[data-testid="companion-composer"]').exists(), false);
  assert.equal(wrapper.findAll('textarea').length, 1,
    '/chats renders only the page composer, never a second compact composer');
  assert.equal(wrapper.find('[data-testid="page-chat-composer"]').exists(), true);

  route.path = '/pipeline';
  await nextTick();
  await wrapper.find('.companion-avatar').trigger('click');
  await flushPromises();
  assert.equal(activeLayerId(), 'companion-bubble');
  const surfaceCallsBeforeUnmount = lifecycle.surfaces.length;
  const closesBeforeUnmount = lifecycle.closes;
  wrapper.unmount();
  assert.equal(lifecycle.disconnects, 1);
  assert.equal(activeLayerId(), 'host-test-lower', 'unmount unregisters the Host layer');

  browser.document.dispatchEvent(new browser.Event('visibilitychange'));
  companion.bubbleOpen = true;
  browser.document.body.dispatchEvent(new browser.Event('pointerdown', { bubbles: true }));
  await flushPromises();
  assert.equal(lifecycle.surfaces.length, surfaceCallsBeforeUnmount,
    'unmount removes visibilitychange listener');
  assert.equal(lifecycle.closes, closesBeforeUnmount,
    'unmount removes outside-pointer listener');
  lowerLayer.unregister();
  assert.equal(activeLayerId(), null);
});
