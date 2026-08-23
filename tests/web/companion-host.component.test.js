// Проверяет интеграцию корневого хоста компаньона с UI и внешними зависимостями.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  compileCompanionSfc,
  installCompanionBrowser,
} from './helpers/companion-component.js';

const HOST_PATH = fileURLToPath(new URL('../../web/src/features/companion/CompanionHost.vue', import.meta.url));
const VUE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/node_modules/vue/index.mjs', import.meta.url),
)).href;
let compileNonce = 0;

async function compileHost(deps, t) {
  const { parse, compileScript } = await import(
    '../../web/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js'
  );
  const source = await readFile(HOST_PATH, 'utf8');
  const { descriptor, errors } = parse(source, { filename: HOST_PATH });
  assert.deepEqual(errors, []);
  const key = `__companionHostDeps${compileNonce++}`;
  globalThis[key] = deps;
  t.after(() => { delete globalThis[key]; });
  const fromDeps = `globalThis[${JSON.stringify(key)}]`;
  let code = compileScript(descriptor, {
    id: `data-v-companion-host-runtime-${compileNonce}`,
    inlineTemplate: true,
  }).content
    .replace('Transition as _Transition', 'Transition as _UnusedTransition')
    .replaceAll('from "vue"', `from "${VUE_URL}"`)
    .replaceAll("from 'vue'", `from "${VUE_URL}"`)
    .replace(
      "import { useRoute, useRouter } from 'vue-router';",
      `const { useRoute, useRouter } = ${fromDeps};`,
    )
    .replace(
      "import { registerLayer } from '../../shared/ui/layer-stack.js';",
      `const { registerLayer } = ${fromDeps};`,
    )
    .replace(
      "import { useChatStore, CONTEXT_WINDOW } from '../../stores/chat.js';",
      `const { useChatStore, CONTEXT_WINDOW } = ${fromDeps};`,
    )
    .replace(
      "import { useCompanionStore } from '../../stores/companion.js';",
      `const { useCompanionStore } = ${fromDeps};`,
    )
    .replace(
      "import { useProvidersStore } from '../../stores/providers.js';",
      `const { useProvidersStore } = ${fromDeps};`,
    )
    .replace(
      "import { contextFill } from '../../shared/chat-context.js';",
      `const { contextFill } = ${fromDeps};`,
    )
    .replace(
      "import { useNotifyWatchStore } from '../../stores/notify-watch.js';",
      `const { useNotifyWatchStore } = ${fromDeps};`,
    )
    .replace(
      "import { useUiContextStore } from '../../stores/ui-context.js';",
      `const { useUiContextStore } = ${fromDeps};`,
    )
    .replace(
      "import { useDictationController } from '../speech/provider.js';",
      `const { useDictationController } = ${fromDeps};`,
    )
    .replace(
      "import { createCompanionChatBridge } from './chat-bridge.js';",
      `const { createCompanionChatBridge } = ${fromDeps};`,
    )
    .replace(
      "import { createSpeechOutput } from './speech-output.js';",
      `const { createSpeechOutput } = ${fromDeps};`,
    )
    .replace(
      "import CompanionAvatar from './CompanionAvatar.vue';",
      `const { CompanionAvatar } = ${fromDeps};`,
    )
    .replace(
      "import CompanionBubble from './CompanionBubble.vue';",
      `const { CompanionBubble } = ${fromDeps};`,
    )
    .replace(
      "const BUBBLE_ID = 'cockpit-companion-bubble';",
      `const { TransitionStub: _Transition } = ${fromDeps};\nconst BUBBLE_ID = 'cockpit-companion-bubble';`,
    );
  assert.doesNotMatch(code, /from ['"]\.\.?\//, 'all Host dependencies are explicit runtime stubs');
  return (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}#host-${compileNonce}`
  )).default;
}

test('COMP-A11Y-HOST-01: runtime focus, layer Escape, /chats и cleanup lifecycle', async (t) => {
  const browser = await installCompanionBrowser(t);
  const [
    { defineComponent, h, nextTick, reactive },
    { mount, flushPromises },
    { activeLayerId, registerLayer },
    CompanionAvatar,
    CompanionBubble,
  ] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/src/shared/ui/layer-stack.js'),
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
  const Host = await compileHost({
    useRoute: () => route,
    useRouter: () => router,
    registerLayer,
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
  const unregisterLower = registerLayer('host-test-lower', {
    priority: 80,
    close: () => { lowerCloses += 1; },
  });
  await avatar.trigger('click');
  await flushPromises();
  assert.equal(activeLayerId(), 'companion-bubble');

  let upperCloses = 0;
  let unregisterUpper = null;
  unregisterUpper = registerLayer('host-test-upper', {
    priority: 100,
    close: () => {
      upperCloses += 1;
      unregisterUpper?.();
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
  unregisterLower();
  assert.equal(activeLayerId(), null);
});
