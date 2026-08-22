// Проверяет выбор серверного чата компаньона, передачу контекста и привязку Stop к точной цели.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createCompanionChatBridge } from '../../web/src/features/companion/chat-bridge.js';

function harness({ snapshots } = {}) {
  const ensured = [];
  const sends = [];
  const selected = [];
  const pushed = [];
  const stops = [];
  let captureCalls = 0;
  const queue = snapshots || [{
    routingScope: null,
    promptContext: Object.freeze({ page: 'Главная', path: '/' }),
  }];
  const chat = {
    sessions: [
      { id: 'normal-7', taskId: '7', purpose: '' },
      { id: 'debug-7', taskId: '7', purpose: 'debug' },
    ],
    async ensureCompanion(scope) {
      ensured.push(structuredClone(scope));
      const taskId = scope.taskId || null;
      return { id: taskId ? `companion-${taskId}` : 'companion-global', taskId, purpose: 'companion' };
    },
    async sendTurn(id, text, attachments, opts) {
      sends.push({ id, text, attachments, opts });
      return { accepted: true, directReply: `reply:${text}`, offline: false, error: '' };
    },
    selectChat(id) { selected.push(id); },
    async stop(id) { stops.push(id); },
  };
  const uiContext = {
    capture() {
      const value = queue[Math.min(captureCalls, queue.length - 1)];
      captureCalls += 1;
      return value;
    },
  };
  const router = { currentRoute: { value: { path: '/' } }, async push(path) { pushed.push(path); } };
  return {
    bridge: createCompanionChatBridge({ chat, uiContext, router }),
    chat, ensured, sends, selected, pushed, stops,
    captures: () => captureCalls,
  };
}

test('COMP-ROUTE-01/02/04/07: global bridge использует только server ensure, не обычный/debug чат', async () => {
  const h = harness();
  const result = await h.bridge.sendText('Привет');

  assert.deepEqual(h.ensured, [{ taskId: null }]);
  assert.equal(h.sends[0].id, 'companion-global');
  assert.equal(result.chatId, 'companion-global');
  assert.equal(h.captures(), 1);
});

test('COMP-ROUTE-03/06/10/14: exact trusted scope выбирает task chat и plan только в request', async () => {
  const snapshot = Object.freeze({
    routingScope: Object.freeze({ kind: 'task', taskId: '7' }),
    promptContext: Object.freeze({
      page: 'Конвейер', path: '/pipeline',
      details: Object.freeze({ taskId: '999', scope: { kind: 'task', taskId: '999' } }),
    }),
  });
  const h = harness({ snapshots: [snapshot] });
  const result = await h.bridge.sendText('Продолжай');

  assert.deepEqual(h.ensured, [{ taskId: '7' }]);
  assert.equal(h.sends[0].id, 'companion-7');
  assert.equal(h.sends[0].opts.promptContext, snapshot.promptContext);
  assert.equal(h.sends[0].opts.modeOverride, 'plan');
  assert.equal(h.sends[0].opts.companionTurn, true);
  assert.equal(result.taskId, '7');
});

test('COMP-ROUTE-08/13: target и frozen context не меняются во время async turn', async () => {
  const first = Object.freeze({
    routingScope: Object.freeze({ kind: 'task', taskId: '11' }),
    promptContext: Object.freeze({ page: 'A', path: '/pipeline' }),
  });
  const second = Object.freeze({
    routingScope: Object.freeze({ kind: 'task', taskId: '12' }),
    promptContext: Object.freeze({ page: 'B', path: '/board' }),
  });
  const h = harness({ snapshots: [first, second] });

  const voice = await h.bridge.sendVoice('Голосом', { voiceTurnId: 'voice-1' });
  assert.equal(voice.chatId, 'companion-11');
  assert.equal(voice.voiceTurnId, 'voice-1');
  assert.equal(voice.directReply, 'reply:Голосом');
  assert.equal(h.sends[0].opts.promptContext, first.promptContext);

  const typed = await h.bridge.sendText('Теперь здесь');
  assert.equal(typed.chatId, 'companion-12');
  assert.equal(Object.hasOwn(typed, 'voiceTurnId'), false);
});

test('COMP-ROUTE-09: полный разговор открывается exact selection перед navigation', async () => {
  const h = harness();
  await h.bridge.openForTask('21');
  await h.bridge.openConversation();

  assert.deepEqual(h.selected, ['companion-21']);
  assert.deepEqual(h.pushed, ['/chats']);
  await h.bridge.stop();
  assert.deepEqual(h.stops, ['companion-21']);
});

test('COMP-ROUTE-15: exact target публикуется до sendTurn, а новый pending scope сразу убирает stale Stop id', async () => {
  let resolveEnsure;
  const ensure = new Promise((resolve) => { resolveEnsure = resolve; });
  const events = [];
  const stopped = [];
  let deferred = false;
  const chat = {
    async ensureCompanion({ taskId }) {
      if (deferred) return ensure;
      return { id: `companion-${taskId}`, taskId, purpose: 'companion' };
    },
    async sendTurn() { events.push('send'); return { accepted: true, directReply: '', steps: [] }; },
    async stop(id) { stopped.push(id); },
    selectChat() {},
  };
  const uiContext = {
    capture: () => ({
      routingScope: { kind: 'task', taskId: '8' },
      promptContext: { page: 'Задача', path: '/pipeline' },
    }),
  };
  const router = { currentRoute: { value: { path: '/pipeline' } }, async push() {} };
  const bridge = createCompanionChatBridge({
    chat, uiContext, router,
    onTarget: ({ chatId }) => events.push(`target:${chatId}`),
  });
  await bridge.openForTask('7');
  deferred = true;
  const pending = bridge.sendText('точный ход');
  assert.deepEqual(bridge.current(), { chatId: null, taskId: '8' });
  assert.equal(await bridge.stop(), false);
  assert.deepEqual(stopped, [], 'pending ensure B никогда не останавливает прежний A');
  resolveEnsure({ id: 'companion-8', taskId: '8', purpose: 'companion' });
  await pending;
  assert.deepEqual(events.slice(-2), ['target:companion-8', 'send']);
});

test('COMP-ROUTE-16: late ensure B не перетирает current после более нового ensure C', async () => {
  const resolvers = new Map();
  const chat = {
    ensureCompanion: ({ taskId }) => new Promise((resolve) => resolvers.set(taskId, resolve)),
    async sendTurn() { return { accepted: true, directReply: '', steps: [] }; },
    async stop() {}, selectChat() {},
  };
  const uiContext = { capture: () => ({ routingScope: null, promptContext: { page: '', path: '/' } }) };
  const router = { currentRoute: { value: { path: '/' } }, async push() {} };
  const targets = [];
  const bridge = createCompanionChatBridge({ chat, uiContext, router, onTarget: (target) => targets.push(target.chatId) });
  const b = bridge.openForTask('22');
  const c = bridge.openForTask('23');
  resolvers.get('23')({ id: 'companion-23', taskId: '23', purpose: 'companion' });
  await c;
  resolvers.get('22')({ id: 'companion-22', taskId: '22', purpose: 'companion' });
  await b;
  assert.deepEqual(bridge.current(), { chatId: 'companion-23', taskId: '23' });
  assert.deepEqual(targets, ['companion-23', 'companion-22'],
    'stale exact identity публикуется для active-turn binding, но current не перетирает');
});

test('COMP-ROUTE-18: Stop держит exact chat хода A после explicit openForTask(B)', async () => {
  const [{ createPinia, setActivePinia }, { useCompanionStore }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/src/stores/companion.js'),
  ]);
  setActivePinia(createPinia());
  const store = useCompanionStore();
  let resolveReplyA;
  let markSendStarted;
  const sendStarted = new Promise((resolve) => { markSendStarted = resolve; });
  const stopped = [];
  const chat = {
    sessions: [], archived: [],
    session: () => null,
    async ensureCompanion({ taskId }) {
      return {
        id: `companion-${taskId}`, taskId, purpose: 'companion',
        logicalIdentity: `companion:task:${taskId}`,
      };
    },
    sendTurn(id) {
      assert.equal(id, 'companion-41');
      markSendStarted();
      return new Promise((resolve) => { resolveReplyA = resolve; });
    },
    async stop(id) { stopped.push(id); return true; },
    selectChat() {},
    registerSurface: () => ({ update() {}, dispose() {} }),
    markRead() {},
  };
  const uiContext = {
    capture: () => ({
      routingScope: { kind: 'task', taskId: '41' },
      promptContext: { page: 'Конвейер', path: '/pipeline' },
    }),
  };
  const router = { currentRoute: { value: { path: '/pipeline' } }, async push() {} };
  const bridge = createCompanionChatBridge({
    chat, uiContext, router,
    onTarget: (target) => store.handleTarget(target),
  });
  const dictation = { acquire: () => ({ state: {}, release() {} }) };
  const output = { snapshot: () => ({ prefs: { enabled: true }, voices: [] }), setChat() {}, cancel() {}, dispose() {} };
  const disconnect = store.connect({ bridge, dictation, output, chat });

  assert.equal(await store.openForTask('41'), 'companion-41');
  store.setDraft('долгий ход A');
  const pendingA = store.sendText();
  await sendStarted;
  assert.equal(await store.openForTask('42'), 'companion-42');
  assert.equal(store.currentChatId, 'companion-42');
  assert.equal(store.thinking, true);
  store.setDraft('следующий черновик B');

  assert.equal(await store.stopTurn(), true);
  assert.deepEqual(stopped, ['companion-41'],
    'Stop не использует новый current/bridge.current как цель старого хода');
  resolveReplyA({ accepted: true, directReply: 'готово A', messageId: 'a-final', steps: [], offline: false, error: '' });
  await pendingA;
  assert.equal(store.currentChatId, 'companion-42', 'поздний A не возвращает UI из B');
  assert.equal(store.draft, 'следующий черновик B', 'поздний success A не стирает draft B');
  disconnect();
});

test('COMP-ROUTE-19: success/error долгого хода не стирают новый текст в том же scope', async () => {
  const [{ createPinia, setActivePinia }, { useCompanionStore }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/src/stores/companion.js'),
  ]);
  setActivePinia(createPinia());
  const store = useCompanionStore();
  let settle;
  const bridge = {
    sendVoice: async () => false,
    sendText: () => new Promise((resolve, reject) => { settle = { resolve, reject }; }),
    stop: async () => true,
  };
  const dictation = { acquire: () => ({ state: {}, release() {} }) };
  const output = { snapshot: () => ({ prefs: { enabled: true }, voices: [] }), cancel() {}, dispose() {} };
  const chat = { sessions: [], archived: [], session: () => null, registerSurface: () => ({ update() {}, dispose() {} }), markRead() {} };
  const disconnect = store.connect({ bridge, dictation, output, chat });

  store.setDraft('первый отправленный');
  const success = store.sendText();
  store.setDraft('новый текст во время success');
  settle.resolve({ accepted: true, directReply: 'готово', chatId: null, taskId: null });
  await success;
  assert.equal(store.draft, 'новый текст во время success');

  store.setDraft('второй отправленный');
  const failure = store.sendText();
  store.setDraft('новый текст во время error');
  settle.reject(new Error('executor failed'));
  await failure;
  assert.equal(store.draft, 'новый текст во время error');
  disconnect();
});

test('COMP-ROUTE-20: stale ensure A всё равно привязывает Stop после более нового open B', async () => {
  const [{ createPinia, setActivePinia }, { useCompanionStore }] = await Promise.all([
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
    import('../../web/src/stores/companion.js'),
  ]);
  setActivePinia(createPinia());
  const store = useCompanionStore();
  let resolveEnsureA;
  let resolveTurnA;
  let sendStarted;
  const started = new Promise((resolve) => { sendStarted = resolve; });
  const stopped = [];
  const chat = {
    sessions: [], archived: [], session: () => null,
    ensureCompanion({ taskId }) {
      if (String(taskId) === '41') {
        return new Promise((resolve) => { resolveEnsureA = resolve; });
      }
      return Promise.resolve({
        id: `companion-${taskId}`, taskId: String(taskId), purpose: 'companion',
        logicalIdentity: `companion:task:${taskId}`,
      });
    },
    sendTurn(id) {
      assert.equal(id, 'companion-41');
      sendStarted();
      return new Promise((resolve) => { resolveTurnA = resolve; });
    },
    async stop(id) { stopped.push(id); },
    selectChat() {},
    registerSurface: () => ({ update() {}, dispose() {} }),
    markRead() {},
  };
  const uiContext = { capture: () => ({
    routingScope: { kind: 'task', taskId: '41' },
    promptContext: { page: 'Конвейер', path: '/pipeline' },
  }) };
  const router = { currentRoute: { value: { path: '/pipeline' } }, async push() {} };
  const bridge = createCompanionChatBridge({
    chat, uiContext, router,
    onTarget: (target) => store.handleTarget(target),
  });
  const dictation = { acquire: () => ({ state: {}, release() {} }) };
  const output = { snapshot: () => ({ prefs: { enabled: true }, voices: [] }), setChat() {}, cancel() {}, dispose() {} };
  const disconnect = store.connect({ bridge, dictation, output, chat });

  store.setScope('41');
  store.setDraft('ход A');
  const pendingA = store.sendText();
  assert.equal(await store.openForTask('42'), 'companion-42');
  resolveEnsureA({
    id: 'companion-41', taskId: '41', purpose: 'companion', logicalIdentity: 'companion:task:41',
  });
  await started;
  assert.equal(await store.stopTurn(), true);
  assert.deepEqual(stopped, ['companion-41']);
  resolveTurnA({ accepted: true, directReply: '', chatId: 'companion-41', taskId: '41' });
  await pendingA;
  disconnect();
});
