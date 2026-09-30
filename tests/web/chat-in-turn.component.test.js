import assert from 'node:assert/strict';
import test from 'node:test';
import { compileChatSession } from './helpers/chat-session.js';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';
globalThis.__sharedChatContextFill = (await import('../../shared/chatContext.ts')).contextFill;

const PREFIX = '__inTurnComponent';
const PROVIDER = {
  id: 'codex', name: 'Codex', color: '#10a37f', available: true,
  inTurn: { protocol: 1, text: true, confirmation: 'forwarded' },
  models: [{ id: 'test-model', name: 'Test', efforts: [] }],
  commands: [{ cmd: '$review', desc: 'Проверить', run: 'prompt' }],
};

async function mountChat(t, { sending = true, available = true, accept = true } = {}) {
  const browser = await installUiBrowser(t, 'https://cockpit.test/#/chats');
  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const session = reactive({
    id: 'in-turn-chat', title: 'Тест', taskId: null, purpose: '',
    model: 'test-model', modelRef: { provider: 'codex', model: 'test-model' },
    effort: '', mode: '', messages: [{ role: 'user', text: 'Сделай два шага' }],
    steps: [], draft: '', sending, compacting: false, sessionResetting: false,
    contextTokens: 0,
  });
  const run = reactive({
    chatKey: session.id, runId: 'run-12345678', active: sending,
    availability: { runId: 'run-12345678', available, revision: 2 },
    entries: [],
  });
  const calls = { inTurn: [], following: [], stop: 0 };
  const store = {
    sessions: [session], archived: [], inTurnProtocol: 1, inTurnError: 'Отказ транспорта',
    inTurnFor: () => run, compactWindow: 0,
    loadConveyor() {}, markRead() {}, setDraft() {}, setEffort() {}, setMode() {},
    setTask() {}, setTitle() {}, permFor() { return null; },
    questionFor() { return null; }, isOnConveyor() { return false; },
    tabLabel() { return session.title; },
    async sendInTurn(...args) { calls.inTurn.push(args); return accept; },
    async send(...args) { calls.following.push(args); return true; },
    async stop() { calls.stop += 1; },
  };
  globalThis[`${PREFIX}Api`] = {
    url: (value) => value,
    async get() { return { tasks: [] }; },
    async upload() { return { file: 'file-1', name: 'test.txt', url: '/test.txt' }; },
  };
  globalThis[`${PREFIX}ChatStore`] = () => store;
  globalThis[`${PREFIX}TasksStore`] = () => ({ async load() { return null; } });
  globalThis[`${PREFIX}UiStore`] = () => ({ openTaskLaunch() {} });
  globalThis[`${PREFIX}Router`] = { async push() {} };
  globalThis[`${PREFIX}ProvidersStore`] = () => ({
    providers: [PROVIDER], load() {},
    modelOf() { return { id: 'test-model', model: PROVIDER.models[0], provider: PROVIDER }; },
    visibleModels() { return PROVIDER.models; }, modesOf() { return []; },
  });
  const [{ mount, flushPromises }, ChatSession] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileChatSession(PREFIX),
  ]);
  const wrapper = mount(ChatSession, {
    attachTo: browser.document.querySelector('#mount'), props: { sid: session.id },
  });
  t.after(() => {
    wrapper.unmount();
    for (const suffix of ['Api', 'ChatStore', 'TasksStore', 'UiStore', 'Router', 'ProvidersStore']) {
      delete globalThis[`${PREFIX}${suffix}`];
    }
  });
  await flushPromises();
  return { wrapper, session, run, calls, flushPromises };
}

test('active Enter and primary control clarify; following and stop stay separate', async (t) => {
  const { wrapper, calls } = await mountChat(t);
  const input = wrapper.get('textarea');
  await input.setValue('Какой сейчас шаг?');
  assert.match(wrapper.get('[data-context="chat-send"]').attributes('aria-label'), /Уточнить сейчас/);
  await input.trigger('keydown', { key: 'Enter' });
  assert.deepEqual(calls.inTurn, [['in-turn-chat', 'Какой сейчас шаг?']]);
  assert.deepEqual(calls.following, []);
  assert.equal(input.element.value, '');
  await input.setValue('Отдельная задача');
  await wrapper.get('[data-context="chat-send-following"]').trigger('click');
  assert.deepEqual(calls.following[0].slice(0, 2), ['in-turn-chat', 'Отдельная задача']);
  await wrapper.get('[data-context="chat-stop"]').trigger('click');
  assert.equal(calls.stop, 1);
});

test('Shift+Enter and IME composition do not send; rejection preserves draft', async (t) => {
  const { wrapper, calls } = await mountChat(t, { accept: false });
  const input = wrapper.get('textarea');
  await input.setValue('Вопрос');
  await input.trigger('keydown', { key: 'Enter', shiftKey: true });
  await input.trigger('keydown', { key: 'Enter', isComposing: true });
  assert.equal(calls.inTurn.length, 0);
  await input.trigger('keydown', { key: 'Enter' });
  assert.equal(calls.inTurn.length, 1);
  assert.equal(input.element.value, 'Вопрос');
  assert.match(wrapper.text(), /Отказ транспорта/);
});

test('exact $skill stays an ordinary prompt to the active agent', async (t) => {
  const { wrapper, calls } = await mountChat(t);
  const input = wrapper.get('textarea');
  await input.setValue('$review');
  await input.trigger('keydown', { key: 'Enter' });
  assert.deepEqual(calls.inTurn, [['in-turn-chat', '$review']]);
  assert.deepEqual(calls.following, []);
});

test('attachment and unavailable channel explain refusal but still allow following', async (t) => {
  const { wrapper, calls, run, flushPromises } = await mountChat(t);
  const input = wrapper.get('textarea');
  await input.setValue('Разбери файл');
  await wrapper.trigger('drop', {
    dataTransfer: { types: ['Files'], files: [new Blob(['x'], { type: 'text/plain' })] },
  });
  await flushPromises();
  assert.match(wrapper.get('[data-role="chat-in-turn-unavailable"]').text(), /Вложения/);
  assert.equal(wrapper.get('[data-context="chat-send"]').attributes('disabled'), '');
  await wrapper.get('[data-context="chat-send-following"]').trigger('click');
  assert.equal(calls.following[0][2].length, 1);
  await input.setValue('Новый вопрос');
  run.availability = { runId: run.runId, available: false, reason: 'awaiting_answer', revision: 3 };
  await flushPromises();
  assert.match(wrapper.get('[data-role="chat-in-turn-unavailable"]').text(), /ответь на вопрос/);
});

test('restored assistant block is visible outside collapsed steps', async (t) => {
  const { wrapper, session, flushPromises } = await mountChat(t, { sending: false });
  session.messages.push({
    role: 'assistant', kind: 'assistant-block', runId: 'run-12345678',
    assistantMessageId: 'answer-12345678', text: 'Ответ до финала', complete: true,
  });
  await flushPromises();
  assert.equal(wrapper.findAll('[data-role="chat-in-turn-reply"]').length, 1);
  assert.match(wrapper.get('[data-role="chat-in-turn-reply"]').text(), /Ответ до финала/);
});

test('StepList hides a text step only when its assistant id is explicitly displayed', async (t) => {
  await installUiBrowser(t);
  const [{ mount }, StepList] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/views/chat/StepList.vue')),
  ]);
  const steps = [{ k: 'text', id: 'answer-12345678', text: 'Один ответ', at: 1 }];
  const wrapper = mount(StepList, { props: { steps, live: true } });
  t.after(() => wrapper.unmount());
  assert.match(wrapper.text(), /Один ответ/);
  await wrapper.setProps({ displayedAssistantIds: ['answer-12345678'] });
  assert.doesNotMatch(wrapper.text(), /Один ответ/);
});
