// Проверяет, что пузырь компаньона не обходит запросы разрешений и ведёт человека в полный чат.
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

test('COMP-PERM-01..07: bubble показывает только нейтральный wait CTA', async () => {
  const [host, bubble, store] = await Promise.all([
    source('web/src/features/companion/CompanionHost.vue'),
    source('web/src/features/companion/CompanionBubble.vue'),
    source('web/src/stores/companion.js'),
  ]);

  assert.match(host + store, /reduceCompanionState/);
  assert.match(bubble, /Открыть чат/);
  assert.match(bubble, /Открыть список чатов/);
  assert.doesNotMatch(host + bubble + store, /answerPerm|answerQuestion|ChatPermission|ChatQuestion/);
  assert.doesNotMatch(bubble, /remember|choice|Разрешить|Отклонить/);
});

test('COMP-PERM-01..07: exact pending даёт только CTA, а voice text остаётся plan-turn', async (t) => {
  const browser = await installCompanionBrowser(t);
  const [
    { createPinia, setActivePinia },
    { h, reactive },
    { mount, flushPromises },
    { useCompanionStore },
    { createCompanionChatBridge },
    Bubble,
  ] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/src/stores/companion.js'),
    import('../../web/src/features/companion/chat-bridge.js'),
    compileCompanionSfc('CompanionBubble'),
  ]);
  setActivePinia(createPinia());
  const store = useCompanionStore();
  const order = [];
  const turns = [];
  const spoken = [];
  const outputCancels = [];
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
        start() { publish({ phase: 'recording', busy: true }); return Promise.resolve(true); },
        stop() { return Promise.resolve(true); },
        cancel() { publish({ phase: 'idle', busy: false }); return Promise.resolve(true); },
        release() { return Promise.resolve(true); },
      };
    },
  };
  const chat = {
    pending: {},
    async ensureCompanion({ taskId }) {
      return { id: taskId ? `companion-${taskId}` : 'companion-global', taskId, purpose: 'companion' };
    },
    async sendTurn(id, text, _attachments, opts) {
      turns.push({ id, text, opts });
      return {
        accepted: true,
        directReply: 'Решение доступно в полном чате.',
        messageId: 'reply-permission',
        steps: [{ kind: 'permission', command: 'hidden' }],
        offline: false,
        error: '',
      };
    },
    selectChat(id) { order.push(`select:${id}`); },
    async stop() {},
    registerSurface: () => ({ update() {}, dispose() {} }),
    markRead() {},
  };
  const router = {
    currentRoute: { value: { path: '/pipeline' } },
    async push(path) { order.push(`push:${path}`); },
  };
  const uiContext = {
    capture: () => ({
      routingScope: { kind: 'task', taskId: '42' },
      promptContext: { page: 'Конвейер', path: '/pipeline', details: { pipeline: { taskId: '42' } } },
    }),
  };
  const bridge = createCompanionChatBridge({ chat, uiContext, router });
  const output = {
    snapshot: () => ({ available: true, status: 'idle', enabled: true, prefs: { ttsEnabled: true, ttsConsent: true }, voices: [] }),
    micStart() {}, setChat() {}, cancel(reason) { outputCancels.push(reason); }, dispose() {},
    speak(message) {
      if (message.steps?.length) return false;
      spoken.push(message);
      return true;
    },
  };
  const disconnect = store.connect({ bridge, dictation, output, chat });
  t.after(disconnect);
  assert.equal(await store.openForTask('42'), 'companion-42');

  store.setAttentionSnapshot({
    chat: {
      id: 'companion-42', unread: false,
      pending: [
        { pid: 'exact', kind: 'perm', chatKey: 'companion-42', command: 'secret command' },
        { pid: 'other', kind: 'question', chatKey: 'companion-99', options: ['secret'] },
      ],
    },
  });
  const wrapper = mount({ setup: () => () => h(Bubble, bubbleProps(store)) }, {
    attachTo: browser.document.querySelector('#mount'),
  });
  t.after(() => wrapper.unmount());
  assert.equal(store.attention.kind, 'wait');
  assert.equal(wrapper.find('[data-testid="companion-wait"]').text().includes('Открыть чат'), true);
  assert.doesNotMatch(wrapper.text(), /secret command|secret/);

  await wrapper.find('.open-wait').trigger('click');
  await flushPromises();
  assert.deepEqual(order, ['select:companion-42', 'push:/chats']);

  await store.startVoice();
  handlers.onFinal('разрешить', { generation: 11 });
  publish({ phase: 'idle', busy: false });
  await flushPromises();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'разрешить');
  assert.equal(turns[0].opts.modeOverride, 'plan');
  assert.equal(turns[0].opts.companionTurn, true);
  assert.equal(spoken.length, 0, 'permission/tool metadata не проходит TTS gate');

  assert.equal(store.currentChatId, 'companion-42');
  assert.ok(store.lastReply);
  store.setScope('99');
  assert.equal(store.currentChatId, null, 'смена scope инвалидирует разговор A');
  assert.equal(store.lastReply, '', 'ответ A не остаётся под scope B');
  assert.equal(outputCancels.includes('scope-change'), true);
  await store.openConversation('99');
  assert.deepEqual(order.slice(-2), ['select:companion-99', 'push:/chats']);

  store.setAttentionSnapshot({
    chat: { id: 'companion-99', unread: false, pending: [{ kind: 'perm', chatKey: 'companion-42' }] },
  });
  assert.equal(store.attention.kind, 'none', 'done/чужой pending не подменяет exact conversation');

  store.setAttentionSnapshot({
    pipeline: { waiting: [{ task: '77' }] },
    chat: { id: 'companion-99', unread: false, pending: [] },
  });
  await flushPromises();
  assert.equal(store.attentionDestination, 'pipeline');
  assert.match(store.statusLabel, /Конвейер/);
  assert.equal(wrapper.find('.open-wait').text(), 'Открыть конвейер');

  store.setAttentionSnapshot({
    pipeline: { waiting: [{ task: '77' }] },
    chat: { id: 'companion-99', unread: false, pending: [{ kind: 'question', chatKey: 'companion-99' }] },
  });
  await flushPromises();
  assert.equal(store.attentionDestination, 'chats', 'exact chat wait задаёт CTA при смешанном attention');
  assert.equal(wrapper.find('.open-wait').text(), 'Открыть чат');
});

test('COMP-PERM-08: duplicate conflict ведёт в список без повторного ensure/select', async () => {
  const [{ createPinia, setActivePinia }, { useCompanionStore }, { createCompanionChatBridge }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/src/stores/companion.js'),
    import('../../web/src/features/companion/chat-bridge.js'),
  ]);
  setActivePinia(createPinia());
  const store = useCompanionStore();
  let ensures = 0;
  const selected = [];
  const pushed = [];
  const conflict = Object.assign(new Error('Найдены дубли companion-чата'), {
    code: 'companion_chat_conflict', conflicts: [{ id: 'dup-a' }, { id: 'dup-b' }],
  });
  const chat = {
    sessions: [], archived: [], session: () => null,
    async ensureCompanion() { ensures += 1; throw conflict; },
    async sendTurn() { throw new Error('send не ожидался'); },
    selectChat(id) { selected.push(id); }, async stop() {},
    registerSurface: () => ({ update() {}, dispose() {} }), markRead() {},
  };
  const router = { currentRoute: { value: { path: '/pipeline' } }, async push(path) { pushed.push(path); } };
  const uiContext = { capture: () => ({ routingScope: { kind: 'task', taskId: '5' }, promptContext: { page: 'Задача', path: '/pipeline' } }) };
  const bridge = createCompanionChatBridge({ chat, uiContext, router, onTarget: (target) => store.handleTarget(target) });
  const dictation = { acquire: () => ({ state: {}, release() {} }) };
  const output = { snapshot: () => ({ prefs: { enabled: true }, voices: [] }), cancel() {}, dispose() {} };
  const disconnect = store.connect({ bridge, dictation, output, chat });

  assert.equal(await store.openForTask('5'), false);
  assert.equal(store.bubbleOpen, true);
  assert.equal(store.chatErrorCode, 'companion_chat_conflict');
  assert.deepEqual(store.chatConflictIds, ['dup-a', 'dup-b']);
  assert.equal(await store.openConversation(), true);
  assert.equal(ensures, 1, 'CTA conflict не повторяет неоднозначный ensure');
  assert.deepEqual(selected, []);
  assert.deepEqual(pushed, ['/chats']);
  disconnect();
});

test('COMP-ROUTE-17: Pipeline intent переживает dispose overlay и шлёт frozen exact context', async () => {
  const [{ createPinia, setActivePinia }, { useCompanionStore }, { createCompanionChatBridge }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/src/stores/companion.js'),
    import('../../web/src/features/companion/chat-bridge.js'),
  ]);
  setActivePinia(createPinia());
  const store = useCompanionStore();
  let resolveFirst;
  let ensureCount = 0;
  let snapshot = {
    routingScope: { kind: 'task', taskId: '55' },
    promptContext: Object.freeze({ page: 'Задача #55', path: '/pipeline', details: Object.freeze({ marker: 'overlay-55' }) }),
  };
  const events = [];
  const sends = [];
  const session = {
    id: 'companion-55', taskId: '55', purpose: 'companion',
    logicalIdentity: 'companion:task:55', messages: [], sending: false,
  };
  const chat = {
    sessions: [], archived: [],
    session: (id) => chat.sessions.find((item) => item.id === id) || null,
    ensureCompanion() {
      ensureCount += 1;
      if (ensureCount === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return Promise.resolve(session);
    },
    async sendTurn(id, text, attachments, opts) {
      events.push('send');
      sends.push({ id, text, attachments, opts });
      return { accepted: true, directReply: 'ok', messageId: 'm55', steps: [], offline: false, error: '' };
    },
    registerSurface() {
      return { update(value) { events.push(`surface:${value.chatId || '-'}`); }, dispose() {} };
    },
    markRead() {}, selectChat() {}, async stop() {},
  };
  const router = { currentRoute: { value: { path: '/pipeline' } }, async push() {} };
  const uiContext = { capture: () => snapshot };
  const bridge = createCompanionChatBridge({
    chat, uiContext, router, onTarget: (target) => store.handleTarget(target),
  });
  const output = {
    snapshot: () => ({ available: false, status: 'unavailable', prefs: { enabled: true }, voices: [] }),
    cancel() {}, dispose() {}, setChat() {}, micStart() {}, speak() {},
  };
  const dictation = { acquire: () => ({ state: {}, release() {} }) };
  const disconnect = store.connect({ bridge, dictation, output, chat });
  store.setSurfaceVisible(true);

  const opening = store.openForTask('55');
  assert.equal(store.bubbleOpen, true, 'intent открывает bubble до async ensure');
  assert.equal(store.contextPinned, true);
  snapshot = { routingScope: null, promptContext: { page: 'Конвейер', path: '/pipeline' } };
  store.syncPageScope(null);
  assert.equal(store.pinnedTaskId, '55', 'dispose overlay не сбрасывает pin');
  resolveFirst(session);
  chat.sessions.push(session);
  assert.equal(await opening, 'companion-55');
  assert.equal(store.currentChatId, 'companion-55');

  store.setDraft('продолжай');
  await store.sendText();
  assert.equal(sends[0].id, 'companion-55');
  assert.equal(sends[0].opts.promptContext.details.marker, 'overlay-55');
  const sendIndex = events.lastIndexOf('send');
  assert.equal(events.slice(0, sendIndex).at(-1), 'surface:companion-55',
    'exact surface публикуется до chat.sendTurn/self-notify');
  disconnect();
});
