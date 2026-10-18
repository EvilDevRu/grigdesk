import assert from 'node:assert/strict';
import test from 'node:test';
import { compileChatSession } from './helpers/chat-session.js';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';
globalThis.__sharedChatContextFill = (await import('../../shared/chat/chatContext.ts')).contextFill;

const PREFIX = '__inTurnComponent';
const PROVIDER = {
  id: 'codex', name: 'Codex', color: '#10a37f', available: true,
  inTurn: { protocol: 1, text: true, confirmation: 'forwarded' },
  models: [{ id: 'test-model', name: 'Test', efforts: [] }],
  commands: [{ cmd: '$review', desc: 'Проверить', run: 'prompt' }],
};

/**
 * Настоящий композер получает управляемые стор и канал активного хода.
 * Счётчики различают немедленный ввод, очередь и остановку без вызова исполнителя.
 */
async function mountChat(t, {
  sending = true,
  available = true,
  accept = true,
  renderMarkdown,
  provider = PROVIDER,
  upload = { file: 'file-1', name: 'test.txt', url: '/test.txt' },
} = {}) {
  const browser = await installUiBrowser(t, 'https://grigdesk.test/#/chats');
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
    setDraftAttachments(id, list) {
      session.draftAttachments = list;
    },
    addDraftAttachment(id, attachment) {
      session.draftAttachments = [...(session.draftAttachments || []), attachment];
    },
    questionFor() { return null; }, isOnConveyor() { return false; },
    tabLabel() { return session.title; },
    async sendInTurn(...args) { calls.inTurn.push(args); return accept; },
    async send(...args) { calls.following.push(args); return true; },
    async stop() { calls.stop += 1; },
  };
  globalThis[`${PREFIX}Api`] = {
    url: (value) => value,
    async get() { return { tasks: [] }; },
    async upload() { return upload; },
  };
  globalThis[`${PREFIX}ChatStore`] = () => store;
  globalThis[`${PREFIX}MarkdownRenderer`] = renderMarkdown;
  globalThis[`${PREFIX}TasksStore`] = () => ({ async load() { return null; } });
  globalThis[`${PREFIX}UiStore`] = () => ({ openTaskLaunch() {} });
  globalThis[`${PREFIX}Router`] = { async push() {} };
  globalThis[`${PREFIX}ProvidersStore`] = () => ({
    providers: [provider], load() {},
    modelOf() { return { id: 'test-model', model: provider.models[0], provider }; },
    visibleModels() { return provider.models; }, modesOf() { return []; },
  });

  const [{ mount, flushPromises }, ChatSession] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileChatSession(PREFIX, { realSteps: true }),
  ]);
  const wrapper = mount(ChatSession, {
    attachTo: browser.document.querySelector('#mount'), props: { sid: session.id },
  });

  t.after(() => {
    wrapper.unmount();

    for (const suffix of ['Api', 'ChatStore', 'TasksStore', 'UiStore', 'Router', 'ProvidersStore',
      'MarkdownRenderer']) {
      delete globalThis[`${PREFIX}${suffix}`];
    }
  });
  await flushPromises();

  return {
    wrapper,
    session,
    run,
    calls,
    store,
    flushPromises,
  };
}

test('щелчок по картинке в ленте действий открывает общий просмотрщик чата', async (t) => {
  const previewed = [];

  // Стор просмотрщика берётся при монтировании, поэтому подмена ставится до mountChat.
  globalThis[`${PREFIX}DocumentPreview`] = {
    show() {},
    showImage(image) {
      previewed.push(image);
    },
  };
  t.after(() => {
    delete globalThis[`${PREFIX}DocumentPreview`];
  });

  const { wrapper, session, flushPromises } = await mountChat(t);

  session.steps.push({
    k: 'tool',
    id: 'read-1',
    name: 'Read',
    title: 'shot.png',
    sub: '/repo/shot.png',
  }, {
    k: 'res',
    id: 'read-1',
    ok: true,
    text: '[изображение]',
  });
  await flushPromises();
  await wrapper.get('.step.tool .step-disclosure').trigger('click');
  await wrapper.get('.step-image img').trigger('click', { button: 0, ctrlKey: true });
  assert.deepEqual(previewed, [], 'щелчок с модификатором остаётся ссылкой');
  await wrapper.get('.step-image img').trigger('click', { button: 0 });
  assert.deepEqual(previewed, [{
    src: 'https://grigdesk.test/api/chat/in-turn-chat/image?path=%2Frepo%2Fshot.png',
    name: 'shot.png',
    mime: '',
  }]);
});

test('одна кнопка и Enter отправляют в активный ход, стоп остаётся отдельным', async (t) => {
  const { wrapper, calls } = await mountChat(t);
  const input = wrapper.get('textarea');

  assert.equal(wrapper.findAll('[data-context="chat-send"]').length, 1);
  assert.equal(wrapper.find('[data-context="chat-send-following"]').exists(), false);
  await input.setValue('Какой сейчас шаг?');
  assert.match(wrapper.get('[data-context="chat-send"]').attributes('aria-label'), /Уточнить сейчас/);
  await input.trigger('keydown', { key: 'Enter' });
  assert.deepEqual(calls.inTurn, [['in-turn-chat', 'Какой сейчас шаг?', []]]);
  assert.deepEqual(calls.following, []);
  assert.equal(input.element.value, '');
  await input.setValue('Отдельная задача');
  await wrapper.get('[data-context="chat-send"]').trigger('click');
  assert.deepEqual(calls.inTurn[1], ['in-turn-chat', 'Отдельная задача', []]);
  assert.deepEqual(calls.following, []);
  await wrapper.get('[data-context="chat-stop"]').trigger('click');
  assert.equal(calls.stop, 1);
});

test('прогресс не разбирает Markdown старых ответов, изменение текста разбирает один', async (t) => {
  let renders = 0;
  const { session, flushPromises } = await mountChat(t, { renderMarkdown: (text) => {
    renders += 1;

    return text;
  } });

  session.messages.push({ role: 'assistant', text: 'Первый ответ' },
    { role: 'assistant', text: 'Второй ответ' });
  await flushPromises();
  assert.equal(renders, 2);

  for (let index = 1; index <= 10; index += 1) {
    session.progressTokens = index * 100;
    await flushPromises();
  }

  assert.equal(renders, 2);
  session.messages[1].text = 'Изменённый ответ';
  await flushPromises();
  assert.equal(renders, 3);
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
  assert.equal(calls.following.length, 0);
  assert.equal(input.element.value, 'Вопрос');
  assert.match(wrapper.text(), /Отказ транспорта/);
});

test('exact $skill stays an ordinary prompt to the active agent', async (t) => {
  const { wrapper, calls } = await mountChat(t);
  const input = wrapper.get('textarea');
  await input.setValue('$review');
  await input.trigger('keydown', { key: 'Enter' });
  assert.deepEqual(calls.inTurn, [['in-turn-chat', '$review', []]]);
  assert.deepEqual(calls.following, []);
});

test('та же кнопка ставит вложения и сообщение при открытом вопросе в очередь', async (t) => {
  const { wrapper, calls, run, flushPromises } = await mountChat(t);
  const input = wrapper.get('textarea');
  await input.setValue('Разбери файл');
  await wrapper.trigger('drop', {
    dataTransfer: { types: ['Files'], files: [new Blob(['x'], { type: 'text/plain' })] },
  });
  await flushPromises();
  assert.match(
    wrapper.get('[data-context="chat-send"]').attributes('data-ui-tooltip'),
    /после текущего хода/,
  );
  assert.notEqual(wrapper.get('[data-context="chat-send"]').attributes('disabled'), '');
  await wrapper.get('[data-context="chat-send"]').trigger('click');
  assert.equal(calls.following[0][2].length, 1);
  assert.equal(calls.inTurn.length, 0);
  await input.setValue('Новый вопрос');
  run.availability = { runId: run.runId, available: false, reason: 'awaiting_answer', revision: 3 };
  await flushPromises();
  assert.match(
    wrapper.get('[data-context="chat-send"]').attributes('data-ui-tooltip'),
    /после текущего хода/,
  );
  await input.trigger('keydown', { key: 'Enter' });
  assert.deepEqual(calls.following[1], ['in-turn-chat', 'Новый вопрос', []]);
  assert.equal(calls.inTurn.length, 0);
});

test('без активного хода одна кнопка запускает обычную отправку', async (t) => {
  const { wrapper, calls } = await mountChat(t, { sending: false });

  await wrapper.get('textarea').setValue('Новая задача');
  await wrapper.get('[data-context="chat-send"]').trigger('click');
  assert.deepEqual(calls.following, [['in-turn-chat', 'Новая задача', []]]);
  assert.deepEqual(calls.inTurn, []);
});

test('неготовый канал и неподтверждённый запуск не отнимают единственную отправку', async (t) => {
  const { wrapper, run, calls, store } = await mountChat(t, { available: false });
  const input = wrapper.get('textarea');

  await input.setValue('Пока канал не готов');
  await wrapper.get('[data-context="chat-send"]').trigger('click');
  assert.deepEqual(calls.following[0], ['in-turn-chat', 'Пока канал не готов', []]);

  run.active = false;
  await input.setValue('Без подтверждённого запуска');
  await input.trigger('keydown', { key: 'Enter' });
  assert.deepEqual(calls.following[1], ['in-turn-chat', 'Без подтверждённого запуска', []]);

  run.active = true;
  run.availability.available = true;
  store.inTurnProtocol = 0;
  await input.setValue('Без протокола уточнений');
  await wrapper.get('[data-context="chat-send"]').trigger('click');
  assert.deepEqual(calls.following[2], ['in-turn-chat', 'Без протокола уточнений', []]);
  assert.deepEqual(calls.inTurn, []);
});

test('restored assistant block is visible outside collapsed steps', async (t) => {
  const { wrapper, session, flushPromises } = await mountChat(t, { sending: false });

  session.messages.push({
    role: 'assistant',
    kind: 'assistant-block',
    runId: 'run-12345678',
    assistantMessageId: 'answer-12345678',
    text: 'Ответ до финала',
  });
  await flushPromises();
  assert.equal(wrapper.findAll('[data-role="chat-in-turn-reply"]').length, 1);
  assert.match(wrapper.get('[data-role="chat-in-turn-reply"]').text(), /Ответ до финала/);
  assert.doesNotMatch(wrapper.get('[data-role="chat-in-turn-reply"]').text(), /Пишет/);
});

test('реплика стоит между действиями после старта и не размножается при завершении', async (t) => {
  const { wrapper, session, run, flushPromises } = await mountChat(t);
  const block = {
    role: 'assistant',
    kind: 'assistant-block',
    runId: run.runId,
    assistantMessageId: 'reply-between-tools',
    sequence: 1,
    text: 'Файл проверен',
    complete: false,
    startedAt: 3,
  };

  session.steps = [
    {
      k: 'start',
      at: 1,
      model: 'test-model',
    },
    {
      k: 'tool',
      id: 'read-one',
      at: 2,
      name: 'Read',
      title: 'Первый файл',
    },
    {
      k: 'text',
      id: block.assistantMessageId,
      at: 3,
      text: block.text,
    },
    {
      k: 'tool',
      id: 'read-two',
      at: 4,
      name: 'Read',
      title: 'Второй файл',
    },
  ];
  run.entries.push(block);
  await flushPromises();

  const order = () => wrapper.findAll('.step.start, .step.tool, [data-role="chat-in-turn-reply"]')
    .map((row) => row.text());
  const before = order();

  assert.match(before[0], /старт/);
  assert.match(before[1], /Первый файл/);
  assert.match(before[2], /Файл проверен/);
  assert.match(before[3], /Второй файл/);
  assert.doesNotMatch(wrapper.text(), /Агент · ответ во время хода/);
  assert.equal(wrapper.findAll('[data-role="chat-turn"]').length, 1);
  assert.equal(wrapper.get('[data-role="chat-turn"] .reply-mark svg').exists(), true);

  session.messages.push({ ...block, complete: true });
  run.entries[0].complete = true;
  await flushPromises();
  assert.equal(order().length, 4);
  assert.equal(wrapper.findAll('[data-role="chat-in-turn-reply"]').length, 1);

  session.messages.push({
    role: 'assistant',
    runId: run.runId,
    text: 'Итог работы',
    steps: session.steps,
    model: 'test-model',
  });
  session.sending = false;
  run.active = false;
  await flushPromises();

  assert.match(order()[0], /старт/);
  assert.match(order()[1], /Файл проверен/);
  assert.equal(wrapper.findAll('.step.tool').length, 0);
  assert.equal(wrapper.findAll('.ahead').length, 1);
  assert.equal(wrapper.findAll('.mrow .text').at(-1).text(), 'Итог работы');
  assert.equal(wrapper.findAll('[data-role="chat-turn"]').length, 1);
  assert.equal(wrapper.findAll('[data-role="chat-turn"] .reply-mark svg').length, 2);
  assert.equal(
    wrapper.get('[data-role="chat-turn"]').element.style.getPropertyValue('--prov'),
    PROVIDER.color,
  );
  assert.equal(wrapper.findAll('[aria-label^="Действия агента:"]').length, 2);
  assert.doesNotMatch(wrapper.get('[data-role="chat-turn"]').text(), /Ход агента:/);
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

test('оборванный черновик не обещает «Пишет…», а говорит об обрыве', async (t) => {
  const { wrapper, run, flushPromises } = await mountChat(t);
  const draft = {
    runId: run.runId,
    chatKey: 'in-turn-chat',
    assistantMessageId: 'reply-cut-12345678',
    sequence: 1,
    revision: 1,
    text: 'Начало ответа',
    complete: false,
    startedAt: 1,
  };

  run.entries.push(draft);
  await flushPromises();
  assert.match(wrapper.get('[data-role="chat-in-turn-reply"]').text(), /Пишет…/);

  run.entries.splice(0, 1, {
    ...draft,
    revision: 2,
    abandoned: true,
  });
  await flushPromises();

  const reply = wrapper.get('[data-role="chat-in-turn-reply"]').text();

  assert.match(reply, /Начало ответа/);
  assert.match(reply, /Ответ оборван/);
  assert.doesNotMatch(reply, /Пишет/);
});

test('картинка при готовом канале уходит в текущий ход, черновик вложений очищается', async (t) => {
  const image = {
    file: '1700000000000-shot.png',
    name: 'shot.png',
    url: '/api/chat/attachment/1700000000000-shot.png',
    mime: 'image/png',
  };
  const provider = { ...PROVIDER, inTurn: { ...PROVIDER.inTurn, images: true } };
  const { wrapper, calls, session, flushPromises } = await mountChat(t, { provider, upload: image });
  const input = wrapper.get('textarea');

  await input.setValue('Сравни с референсом');
  await wrapper.trigger('drop', {
    dataTransfer: { types: ['Files'], files: [new Blob(['x'], { type: 'image/png' })] },
  });
  await flushPromises();
  assert.match(wrapper.get('[data-context="chat-send"]').attributes('aria-label'), /Уточнить сейчас/);
  await wrapper.get('[data-context="chat-send"]').trigger('click');
  await flushPromises();
  assert.deepEqual(calls.inTurn, [['in-turn-chat', 'Сравни с референсом', [image]]]);
  assert.deepEqual(calls.following, []);
  assert.deepEqual(session.draftAttachments, [], 'принятая картинка уходит из черновика');
});

test('не картинка идёт после хода даже у исполнителя с картинками', async (t) => {
  const provider = { ...PROVIDER, inTurn: { ...PROVIDER.inTurn, images: true } };
  const { wrapper, calls, flushPromises } = await mountChat(t, { provider });

  await wrapper.get('textarea').setValue('Разбери файл');
  await wrapper.trigger('drop', {
    dataTransfer: { types: ['Files'], files: [new Blob(['x'], { type: 'text/plain' })] },
  });
  await flushPromises();
  assert.match(
    wrapper.get('[data-context="chat-send"]').attributes('data-ui-tooltip'),
    /после текущего хода/,
  );
  await wrapper.get('[data-context="chat-send"]').trigger('click');
  assert.equal(calls.following.length, 1);
  assert.equal(calls.inTurn.length, 0);
});

test('картинка у исполнителя без картинок в ходе идёт после хода', async (t) => {
  const image = {
    file: '1700000000000-shot.png',
    name: 'shot.png',
    url: '/api/chat/attachment/1700000000000-shot.png',
    mime: 'image/png',
  };
  const { wrapper, calls, flushPromises } = await mountChat(t, { upload: image });

  await wrapper.get('textarea').setValue('Сравни с референсом');
  await wrapper.trigger('drop', {
    dataTransfer: { types: ['Files'], files: [new Blob(['x'], { type: 'image/png' })] },
  });
  await flushPromises();
  await wrapper.get('[data-context="chat-send"]').trigger('click');
  assert.deepEqual(calls.following, [['in-turn-chat', 'Сравни с референсом', [image]]]);
  assert.equal(calls.inTurn.length, 0);
});

test('устаревший черновик store не даёт «Пишет…» под законченным ответом истории', async (t) => {
  const { wrapper, session, run, flushPromises } = await mountChat(t, { sending: false });

  run.entries.push({
    runId: run.runId,
    chatKey: 'in-turn-chat',
    assistantMessageId: 'answer-done-12345678',
    sequence: 1,
    revision: 1,
    text: 'Готовый отв',
    complete: false,
    startedAt: 1,
  });
  // Законченный блок в истории так, как его отдаёт сервер: без complete и abandoned.
  session.messages.push({
    role: 'assistant',
    kind: 'assistant-block',
    text: 'Готовый ответ целиком.',
    assistantMessageId: 'answer-done-12345678',
    runId: run.runId,
    sequence: 1,
    revision: 2,
    serverCanonical: true,
  });
  await flushPromises();

  const reply = wrapper.get('[data-role="chat-in-turn-reply"]').text();

  assert.match(reply, /Готовый ответ целиком\./);
  assert.doesNotMatch(reply, /Пишет|Ответ оборван/);
});

test('подпись строки истории: черновик законченного хода оборван, готовый блок без подписи',
  async (t) => {
    const { wrapper, session, flushPromises } = await mountChat(t, { sending: false });

    session.messages.push({
      role: 'assistant',
      kind: 'assistant-block',
      runId: 'run-12345678',
      assistantMessageId: 'answer-stale-12345678',
      sequence: 1,
      text: 'Пишу файл плана.',
      complete: false,
    }, {
      role: 'assistant',
      kind: 'assistant-block',
      runId: 'run-12345678',
      assistantMessageId: 'answer-done-12345678',
      sequence: 2,
      text: 'План записан.',
      complete: true,
      abandoned: true,
    });
    await flushPromises();

    const [stale, done] = wrapper.findAll('[data-role="chat-in-turn-reply"]')
      .map((row) => row.text());

    assert.match(stale, /Пишу файл плана\./);
    assert.match(stale, /Ответ оборван/);
    assert.doesNotMatch(stale, /Пишет/);
    assert.match(done, /План записан\./);
    assert.doesNotMatch(done, /Пишет|Ответ оборван/);
  });
