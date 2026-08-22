// Проверяет голосовой путь компаньона: диктовку, один ход и безопасное подавление озвучивания.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  bubbleProps,
  compileCompanionSfc,
  installCompanionBrowser,
} from './helpers/companion-component.js';

const root = new URL('../../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');

test('COMP-VOICE-01..10: stage-5 surface связывает один voice-turn без второго chat UI', async () => {
  const [host, bubble, store] = await Promise.all([
    source('web/src/features/companion/CompanionHost.vue'),
    source('web/src/features/companion/CompanionBubble.vue'),
    source('web/src/stores/companion.js'),
  ]);

  assert.match(host, /useDictationController\(\)/);
  assert.match(host, /createCompanionChatBridge/);
  assert.match(store, /sendVoice/);
  assert.match(store, /micStart\?\.\(\)/);
  assert.match(host, /watch\(exactAssistantReply,[\s\S]*immediate:\s*true/,
    'F5 adoption сразу проецирует уже загруженный exact assistant reply');
  assert.match(host, /return \{ chatId: id, messageId: '', text: '' \}/,
    'authoritative remote clear снимает stale last reply');
  assert.match(host, /bubbleVisible\.value\s*&&\s*!document\.hidden/);
  assert.match(bubble, /data-testid="companion-mic"/);
  assert.match(bubble, /data-testid="companion-stop"/);
  assert.doesNotMatch(host + bubble, /ChatSession|ChatTabs/);
});

test('COMP-VOICE-01/02/03/06/08/09/10: component + store дают один terminal send и гасят TTS до start', async (t) => {
  const browser = await installCompanionBrowser(t);
  const [
    { createPinia, setActivePinia },
    { defineComponent, h, reactive },
    { mount, flushPromises },
    { useCompanionStore },
    Bubble,
    Avatar,
  ] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/src/stores/companion.js'),
    compileCompanionSfc('CompanionBubble'),
    compileCompanionSfc('CompanionAvatar'),
  ]);
  setActivePinia(createPinia());
  const store = useCompanionStore();
  const order = [];
  const voiceCalls = [];
  let handlers = null;
  const leaseState = reactive({
    phase: 'idle', busy: false, prompt: null, interim: '', notice: '', error: null,
    blockedByOther: false,
  });
  const publish = (patch) => {
    Object.assign(leaseState, patch);
    handlers?.onState?.({ ...leaseState });
  };
  const dictation = {
    acquire(_owner, nextHandlers) {
      handlers = nextHandlers;
      return {
        state: leaseState,
        start() {
          order.push('start');
          publish({ phase: 'recording', busy: true });
          return Promise.resolve(true);
        },
        stop() {
          order.push('stop');
          publish({ phase: 'draining', busy: true });
          handlers.onFinal('проверь текущую задачу', { generation: 7 });
          publish({ phase: 'idle', busy: false });
          return Promise.resolve(true);
        },
        cancel() { publish({ phase: 'idle', busy: false }); return Promise.resolve(true); },
        release() { return Promise.resolve(true); },
      };
    },
  };
  const bridge = {
    async sendText() { throw new Error('typed send не ожидался'); },
    async sendVoice(text, { voiceTurnId }) {
      voiceCalls.push({ text, voiceTurnId });
      return {
        accepted: true,
        directReply: 'В задаче всё спокойно.',
        messageId: 'assistant-7',
        steps: [],
        speechSafe: true,
        chatId: 'companion-42',
        taskId: '42',
        voiceTurnId,
      };
    },
    current: () => ({ chatId: 'companion-42', taskId: '42' }),
    stop: async () => true,
    openForTask: async () => 'companion-42',
    openGlobal: async () => 'companion-global',
    openConversation: async () => true,
  };
  const output = {
    snapshot: () => ({ available: true, status: 'idle', enabled: true, prefs: { ttsEnabled: true, ttsConsent: true }, voices: [] }),
    micStart() { order.push('tts-cancel'); },
    setChat() {},
    speak() { throw new Error('synthetic output failure'); },
    cancel() {},
    dispose() {},
  };
  const chat = {
    registerSurface: () => ({ update() {}, dispose() {} }),
    markRead() {},
  };
  const disconnect = store.connect({ bridge, dictation, output, chat });
  t.after(disconnect);

  const Harness = defineComponent({
    setup: () => () => h('div', [
      h(Avatar, {
        expanded: store.bubbleOpen,
        interaction: store.interaction,
        attention: store.attention,
        onToggle: store.openBubble,
      }),
      store.bubbleOpen ? h(Bubble, bubbleProps(store)) : null,
    ]),
  });
  let wrapper = mount(Harness, { attachTo: browser.document.querySelector('#mount') });

  await wrapper.find('.companion-avatar').trigger('click');
  store.setSurfaceVisible(true);
  store.setAttentionSnapshot({ pipeline: { stalled: [{ task: '42' }] } });
  await flushPromises();
  assert.equal(store.bubbleOpen, true);
  assert.match(wrapper.find('.companion-avatar').attributes('aria-label'), /Закрыть/);
  assert.match(wrapper.find('.companion-avatar').attributes('aria-label'), /Остановившихся задач: 1/);
  assert.deepEqual(order, [], 'open не трогает TTS/microphone');
  assert.equal(voiceCalls.length, 0, 'open не запускает model turn');

  await wrapper.find('[data-testid="companion-mic"]').trigger('click');
  assert.deepEqual(order.slice(0, 2), ['tts-cancel', 'start']);
  assert.equal(store.statusLabel, 'Слушаю…', 'live interaction виден поверх attention');
  assert.match(wrapper.find('.companion-avatar').attributes('aria-label'), /Слушаю/);
  assert.match(wrapper.find('.companion-avatar').attributes('aria-label'), /Остановившихся задач: 1/);
  assert.equal(wrapper.find('[data-testid="companion-cancel"]').exists(), true);
  assert.equal(wrapper.find('[data-testid="companion-send"]').attributes('disabled'), '');

  await wrapper.find('[data-testid="companion-mic"]').trigger('click');
  await flushPromises();
  assert.equal(voiceCalls.length, 1);
  assert.equal(voiceCalls[0].text, 'проверь текущую задачу');
  assert.ok(voiceCalls[0].voiceTurnId);
  assert.equal(wrapper.find('[data-testid="companion-reply"]').text().includes('В задаче всё спокойно.'), true);
  assert.equal(store.outputError.includes('synthetic output failure'), true);
  assert.equal(store.chatError, '', 'ошибка TTS не становится chat error');

  handlers.onFinal('проверь текущую задачу', { generation: 7 });
  await flushPromises();
  assert.equal(voiceCalls.length, 1, 'late/duplicate final не пересылается');

  wrapper.unmount();
  browser.document.body.innerHTML = '<div id="mount-2"></div>';
  wrapper = mount(Harness, { attachTo: browser.document.querySelector('#mount-2') });
  await flushPromises();
  assert.equal(voiceCalls.length, 1, 'remount не переигрывает terminal transcript');
  wrapper.unmount();
});

test('COMP-VOICE-13: remote clear очищает reply только у exact текущего чата', async () => {
  const [{ createPinia, setActivePinia }, { useCompanionStore }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/src/stores/companion.js'),
  ]);
  setActivePinia(createPinia());
  const store = useCompanionStore();
  store.setCurrentChat('companion-current');
  assert.equal(store.syncReply({
    chatId: 'companion-current', messageId: 'answer-1', text: 'Старый ответ',
  }), true);
  assert.equal(store.syncReply({ chatId: 'companion-other', text: '' }), false);
  assert.equal(store.lastReply, 'Старый ответ', 'clear чужого чата не трогает current bubble');
  assert.equal(store.syncReply({ chatId: 'companion-current', text: '' }), true);
  assert.equal(store.lastReply, '');
  assert.equal(store.lastReplyId, '');
});

test('COMP-VOICE-11: close-before-reply сохраняет text/history, но не запускает поздний TTS', async () => {
  const [{ createPinia, setActivePinia }, { reactive }, { useCompanionStore }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/src/stores/companion.js'),
  ]);
  setActivePinia(createPinia());
  const store = useCompanionStore();
  let handlers;
  let resolveReply;
  const sent = [];
  const spoken = [];
  const leaseState = reactive({ phase: 'idle', busy: false, prompt: null });
  const publish = (patch) => {
    Object.assign(leaseState, patch);
    handlers?.onState?.({ ...leaseState });
  };
  const dictation = {
    acquire(_owner, nextHandlers) {
      handlers = nextHandlers;
      return {
        state: leaseState,
        start() { publish({ phase: 'recording', busy: true }); return Promise.resolve(true); },
        cancel() { publish({ phase: 'idle', busy: false }); return Promise.resolve(true); },
        release() {},
      };
    },
  };
  const bridge = {
    sendText: async () => false,
    sendVoice(text, { voiceTurnId }) {
      sent.push(text);
      return new Promise((resolve) => {
        resolveReply = () => resolve({
          accepted: true, directReply: 'Ответ пришёл позже.', messageId: 'late-1', steps: [],
          chatId: 'companion-global', taskId: null, voiceTurnId,
        });
      });
    },
    current: () => ({ chatId: 'companion-global', taskId: null }),
    stop: async () => true,
  };
  const output = {
    snapshot: () => ({ available: true, status: 'idle', prefs: { enabled: true, ttsEnabled: true, ttsConsent: true }, voices: [] }),
    micStart() {}, setChat() {}, cancel() {}, dispose() {}, speak(message) { spoken.push(message); return true; },
  };
  const chat = { sessions: [], archived: [], session: () => null, registerSurface: () => ({ update() {}, dispose() {} }), markRead() {} };
  const disconnect = store.connect({ bridge, dictation, output, chat });
  store.openBubble();
  store.setSurfaceVisible(true);
  await store.startVoice();
  handlers.onFinal('проверь', { generation: 1 });
  publish({ phase: 'idle', busy: false });
  await Promise.resolve();
  assert.deepEqual(sent, ['проверь']);
  await store.closeBubble();
  resolveReply();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(spoken.length, 0);
  assert.equal(store.lastReply, 'Ответ пришёл позже.');
  assert.equal(store.lastReplyId, 'late-1');
  disconnect();
});

test('COMP-VOICE-12: terminal transcript не стирает исходный draft, commits и ручную правку', async () => {
  const [{ createPinia, setActivePinia }, { reactive }, { useCompanionStore }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/src/stores/companion.js'),
  ]);
  setActivePinia(createPinia());
  const store = useCompanionStore();
  let handlers;
  const sent = [];
  const state = reactive({ phase: 'idle', busy: false, prompt: null });
  const dictation = {
    acquire(_owner, nextHandlers) {
      handlers = nextHandlers;
      return {
        state,
        start() { return Promise.resolve(true); },
        release() {},
      };
    },
  };
  const bridge = {
    sendText: async () => false,
    async sendVoice(text, { voiceTurnId }) {
      sent.push({ text, voiceTurnId });
      return { accepted: true, chatId: 'companion-global', taskId: null, voiceTurnId };
    },
  };
  const output = { snapshot: () => ({ prefs: { enabled: true }, voices: [] }), micStart() {}, cancel() {}, dispose() {} };
  const chat = { sessions: [], archived: [], session: () => null, registerSurface: () => ({ update() {}, dispose() {} }), markRead() {} };
  const disconnect = store.connect({ bridge, dictation, output, chat });

  store.setDraft('исходный черновик');
  assert.equal(await store.startVoice(), true);
  handlers.onCommit('голосовой фрагмент');
  store.setDraft(`${store.draft} ручная правка`);
  handlers.onFinal('голосовой фрагмент', { generation: 22 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'исходный черновик голосовой фрагмент ручная правка');
  assert.ok(sent[0].voiceTurnId);
  disconnect();
});

test('COMP-STT-RETRY-01: browser-consent 409 сохраняет exact voice identity до одного final', async () => {
  const [{ createPinia, setActivePinia }, { reactive }, { useCompanionStore }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/src/stores/companion.js'),
  ]);
  setActivePinia(createPinia());
  const store = useCompanionStore();
  let handlers;
  let consentCalls = 0;
  const sends = [];
  const state = reactive({ phase: 'idle', busy: false, prompt: null });
  const publish = (patch) => { Object.assign(state, patch); handlers?.onState?.({ ...state }); };
  const dictation = {
    acquire(_owner, nextHandlers) {
      handlers = nextHandlers;
      return {
        state,
        start() { publish({ phase: 'prompt', busy: true, prompt: 'browser-consent' }); return Promise.resolve(true); },
        confirmBrowserConsent() {
          consentCalls += 1;
          publish({ phase: 'recording', busy: true, prompt: null });
          return Promise.resolve(true);
        },
        cancel() { publish({ phase: 'idle', busy: false, prompt: null }); },
        release() {},
      };
    },
  };
  const bridge = {
    sendText: async () => false,
    async sendVoice(text, { voiceTurnId }) {
      sends.push({ text, voiceTurnId });
      return { accepted: true, chatId: 'companion-global', taskId: null, voiceTurnId };
    },
  };
  const output = { snapshot: () => ({ prefs: { enabled: true }, voices: [] }), micStart() {}, cancel() {}, dispose() {} };
  const chat = { sessions: [], archived: [], session: () => null, registerSurface: () => ({ update() {}, dispose() {} }), markRead() {} };
  const disconnect = store.connect({ bridge, dictation, output, chat });

  await store.startVoice();
  handlers.onError(Object.assign(new Error('Согласие уже изменено'), { status: 409 }));
  await store.confirmBrowserConsent();
  handlers.onFinal('один ход', { generation: 14 });
  publish({ phase: 'idle', busy: false, prompt: null });
  await new Promise((resolve) => setImmediate(resolve));
  handlers.onFinal('дубль', { generation: 14 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(consentCalls, 1);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, 'один ход');
  disconnect();
});

test('COMP-F5-01: store строго принимает one exact identity и восстанавливает thinking/Stop', async () => {
  const [{ createPinia, setActivePinia }, { reactive, nextTick }, { useCompanionStore }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/src/stores/companion.js'),
  ]);
  setActivePinia(createPinia());
  const store = useCompanionStore();
  const exact = reactive({
    id: 'companion-31', purpose: 'companion', taskId: '31',
    logicalIdentity: 'companion:task:31', sending: true, compacting: false,
  });
  const sessions = reactive([exact]);
  const archived = reactive([]);
  const stops = [];
  const reads = [];
  const bridge = {
    sendText: async () => { throw new Error('send не ожидался'); },
    sendVoice: async () => { throw new Error('send не ожидался'); },
    async stop(id) { stops.push(id); return true; },
    current: () => ({ chatId: null, taskId: null }),
  };
  const chat = {
    sessions, archived,
    session: (id) => [...sessions, ...archived].find((item) => item.id === id) || null,
    registerSurface: () => ({ update() {}, dispose() {} }),
    markRead(id) { reads.push(id); },
  };
  const dictation = { acquire: () => ({ state: {}, start: async () => true, release() {} }) };
  const output = { snapshot: () => ({ prefs: { enabled: true }, voices: [] }), setChat() {}, cancel() {}, dispose() {} };
  const disconnect = store.connect({ bridge, dictation, output, chat });

  assert.equal(store.syncPageScope('31'), 'companion-31');
  store.setSurfaceVisible(true);
  assert.equal(store.currentChatId, 'companion-31');
  assert.equal(store.thinking, true);
  assert.equal(await store.startVoice(), false, 'F5 sending не пускает второй voice turn');
  assert.equal(await store.stopTurn(), true);
  assert.deepEqual(stops, ['companion-31']);
  assert.equal(reads.includes('companion-31'), true);

  exact.sending = false;
  await nextTick();
  assert.equal(store.thinking, false);
  sessions.push(reactive({ ...exact, id: 'companion-31-duplicate' }));
  store.syncPageScope('31');
  assert.equal(store.currentChatId, null, 'дубль не выбирается автоматически');
  sessions.pop();
  assert.equal(store.syncPageScope('31'), 'companion-31');
  exact.logicalIdentity = 'broken';
  store.syncPageScope('31');
  assert.equal(store.currentChatId, null, 'несовпадающая server identity fail-closed');

  sessions.splice(0, sessions.length, reactive({
    id: 'bad-global', purpose: 'companion', taskId: 'bad', logicalIdentity: 'companion:global',
  }));
  store.syncPageScope(null);
  assert.equal(store.currentChatId, null, 'malformed global taskId не принимается');
  disconnect();
});

test('COMP-TTS-CONSENT-01: первый unmute ждёт consent, device switch можно включить обратно', async () => {
  const [{ createPinia, setActivePinia }, { useCompanionStore }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/src/stores/companion.js'),
  ]);
  setActivePinia(createPinia());
  const store = useCompanionStore();
  let prefs = { enabled: true, ttsEnabled: false, ttsConsent: false };
  let enableCalls = 0;
  let windowMuted = false;
  const snapshot = () => ({
    available: true,
    status: prefs.ttsEnabled && !windowMuted ? 'idle' : 'off',
    enabled: prefs.ttsEnabled && prefs.ttsConsent && !windowMuted,
    muted: windowMuted || !prefs.ttsEnabled || !prefs.ttsConsent,
    prefs: { ...prefs },
    voices: [],
  });
  const output = {
    snapshot,
    enable() { enableCalls += 1; windowMuted = false; prefs = { ...prefs, ttsEnabled: true, ttsConsent: true }; return snapshot(); },
    disable() { windowMuted = false; prefs = { ...prefs, ttsEnabled: false }; return snapshot(); },
    mute() { windowMuted = true; return snapshot(); },
    unmute() { windowMuted = false; return snapshot(); },
    updatePrefs(patch) { prefs = { ...prefs, ...patch }; return snapshot(); },
    cancel() {}, dispose() {},
  };
  const bridge = { sendText: async () => false, sendVoice: async () => false };
  const dictation = { acquire: () => ({ state: {}, release() {} }) };
  const chat = { sessions: [], archived: [], session: () => null, registerSurface: () => ({ update() {}, dispose() {} }), markRead() {} };
  const disconnect = store.connect({ bridge, dictation, output, chat });

  assert.equal(store.toggleMute(), true);
  assert.equal(store.ttsConsentPrompt, true);
  assert.equal(enableCalls, 0, 'клик mute сам не даёт consent');
  assert.equal(store.confirmTtsConsent(), true);
  assert.equal(enableCalls, 1);
  assert.equal(store.muted, false);
  assert.equal(store.toggleMute(), true);
  assert.equal(store.muted, true);
  assert.equal(prefs.ttsEnabled, true, 'bubble mute не перезаписывает device preference');
  assert.equal(store.toggleMute(), true);
  assert.equal(store.muted, false);
  store.openBubble();
  assert.equal(store.setDeviceEnabled(false), true);
  await Promise.resolve();
  assert.equal(store.deviceEnabled, false);
  assert.equal(store.bubbleOpen, false);
  assert.equal(store.setDeviceEnabled(true), true);
  assert.equal(store.deviceEnabled, true, 'восстановление не требует видимого avatar');
  disconnect();
});

test('COMP-TTS-CONSENT-02: unavailable browser сохраняет подтверждённый device choice без ложного effective state', async () => {
  const [{ createPinia, setActivePinia }, { useCompanionStore }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/src/stores/companion.js'),
  ]);
  setActivePinia(createPinia());
  const store = useCompanionStore();
  let prefs = { enabled: true, ttsEnabled: false, ttsConsent: false };
  const snapshot = () => ({
    available: false,
    status: 'unavailable',
    enabled: false,
    muted: true,
    prefs: { ...prefs },
    voices: [],
  });
  const output = {
    snapshot,
    enable() { prefs = { ...prefs, ttsEnabled: true, ttsConsent: true }; return snapshot(); },
    disable() { prefs = { ...prefs, ttsEnabled: false }; return snapshot(); },
    updatePrefs(patch) { prefs = { ...prefs, ...patch }; return snapshot(); },
    cancel() {}, dispose() {},
  };
  const bridge = { sendText: async () => false, sendVoice: async () => false };
  const dictation = { acquire: () => ({ state: {}, release() {} }) };
  const chat = { sessions: [], archived: [], session: () => null, registerSurface: () => ({ update() {}, dispose() {} }), markRead() {} };
  const disconnect = store.connect({ bridge, dictation, output, chat });

  assert.equal(store.setTtsEnabled(true), true);
  assert.equal(store.ttsConsentPrompt, true);
  assert.equal(store.confirmTtsConsent(), true);
  assert.equal(prefs.ttsEnabled, true);
  assert.equal(prefs.ttsConsent, true);
  assert.equal(store.outputState.available, false);
  assert.equal(store.outputState.status, 'unavailable');
  assert.equal(store.outputState.enabled, false);
  disconnect();
});
