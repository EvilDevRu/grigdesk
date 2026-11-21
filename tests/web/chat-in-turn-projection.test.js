import assert from 'node:assert/strict';
import test from 'node:test';

import { reactive } from '../../web/node_modules/vue/index.mjs';
import { materializeInTurnMessages } from '../../web/src/stores/chatInTurn.ts';
import { apiHarness, chatStoreFixture, sseOf } from './helpers/chat-store.js';

const CHAT = 'projection-chat';
const RUN = 'projection-run';
const TURN = 'projection-turn';

/**
 * Фикстура задаёт канонические сообщения независимо от проверяемого алгоритма.
 * Счётчик наблюдает чтения ключевых полей истории через Vue, не подменяя поиск
 * или результат.
 */
function projectionFixture(count) {
  let reads = 0;
  const entries = Array.from({ length: count }, (_, index) => ({
    chatKey: CHAT,
    runId: RUN,
    assistantMessageId: `block-${index}`,
    sequence: index + 1,
    revision: 1,
    text: `Ответ ${index}`,
    complete: true,
  }));
  const messages = entries.map((entry) => ({
    role: 'assistant',
    kind: 'assistant-block',
    text: entry.text,
    assistantMessageId: entry.assistantMessageId,
    runId: RUN,
    parentTurnId: TURN,
    sequence: entry.sequence,
    revision: entry.revision,
    complete: true,
    serverCanonical: true,
  }));
  const tracked = messages.map((message) => new Proxy(message, {
    get(target, key, receiver) {
      if (key === 'runId' || key === 'messageId' || key === 'assistantMessageId') {
        reads += 1;
      }

      return Reflect.get(target, key, receiver);
    },
  }));
  const state = reactive({
    messages: tracked,
    run: {
      chatKey: CHAT,
      runId: RUN,
      parentTurnId: TURN,
      entries,
    },
  });

  return { state, reads: () => reads };
}

test('PROJECT-COST: повтор большой reactive-истории читает её линейно', () => {
  for (const count of [100, 400, 1355]) {
    const fixture = projectionFixture(count);
    const history = fixture.state.messages;
    const projected = materializeInTurnMessages(history, fixture.state.run);

    assert.equal(projected === history, true);
    assert.equal(projected.at(-1) === history.at(-1), true);
    assert.ok(fixture.reads() <= 12 * (count + count), `Лишние чтения при ${count} блоках`);
  }
});

test('PROJECT-IDENTITY: роли, запуски и первое совпадение сохраняются', () => {
  const receipt = {
    chatKey: CHAT,
    runId: RUN,
    parentTurnId: TURN,
    messageId: 'shared-id',
    sequence: 1,
    revision: 2,
    state: 'forwarded',
    text: 'Уточнение',
    acceptedAt: 100,
  };
  const block = {
    chatKey: CHAT,
    runId: RUN,
    assistantMessageId: 'shared-id',
    sequence: 2,
    revision: 1,
    complete: true,
    text: 'Ответ',
  };
  const other = {
    role: 'assistant',
    runId: 'other-run',
    assistantMessageId: 'shared-id',
    text: 'Другой запуск',
    cost: 99,
  };
  const parent = {
    role: 'user',
    turnId: TURN,
    text: 'Вопрос',
  };
  const final = {
    role: 'assistant',
    runId: RUN,
    text: 'Итог',
    pid: 'final-pid',
  };
  const image = {
    file: 'image.png',
    name: 'image.png',
    url: '/image.png',
    mime: 'image/png',
  };

  receipt.attachments = [image];

  const history = [
    other,
    parent,
    {
      kind: 'in-turn',
      runId: RUN,
      messageId: 'shared-id',
      cost: 11,
    },
    {
      kind: 'in-turn',
      runId: RUN,
      messageId: 'shared-id',
      cost: 12,
    },
    {
      kind: 'assistant-block',
      runId: RUN,
      assistantMessageId: 'shared-id',
      cost: 21,
    },
    {
      kind: 'assistant-block',
      runId: RUN,
      assistantMessageId: 'shared-id',
      cost: 22,
    },
    final,
  ];
  const result = materializeInTurnMessages(history, {
    runId: RUN,
    parentTurnId: TURN,
    entries: [receipt, block],
  });

  assert.deepEqual(result.map((message) => message.text), [
    'Другой запуск', 'Вопрос', 'Уточнение', 'Ответ', 'Итог',
  ]);
  assert.equal(result[0] === other, true);
  assert.equal(result[1] === parent, true);
  assert.equal(result[2].cost, 11);
  assert.equal(result[3].cost, 21);
  assert.equal(result[2].attachments === receipt.attachments, true);
  assert.equal(result.at(-1) === final, true);
});

test('PROJECT-METADATA: новая ревизия сохраняет финальные поля и тела steps', () => {
  const fixture = projectionFixture(3);
  const { state } = fixture;
  const old = state.messages[2];

  old.pid = 'saved-final';
  old.cost = 0.4;
  old.steps = [{
    get text() {
      throw new Error('Прочитано тяжёлое тело steps');
    },
  }];

  const steps = old.steps;

  state.run.entries[2].text = 'Новая редакция';
  state.run.entries[2].revision = 2;

  const result = materializeInTurnMessages(state.messages, state.run);

  assert.equal(result === state.messages, false);
  assert.equal(result[0] === state.messages[0], true);
  assert.equal(result[1] === state.messages[1], true);
  assert.equal(result[2].text, 'Новая редакция');
  assert.equal(result[2].revision, 2);
  assert.equal(result[2].pid, 'saved-final');
  assert.equal(result[2].cost, 0.4);
  assert.equal(result[2].steps === steps, true);
});

test('PROJECT-PARTIAL: сохраняет место и порядок группы без исходного вопроса в окне', () => {
  const { state } = projectionFixture(3);
  const before = { role: 'user', text: 'Прежний вопрос без id' };
  const note = { role: 'note', text: 'Соседняя запись выше' };
  const after = { role: 'user', text: 'Следующий вопрос' };
  const first = state.messages[0];
  const last = state.messages[2];
  const middle = state.run.entries[1];
  const result = materializeInTurnMessages([before, note, first, last, after], {
    ...state.run, parentTurnId: undefined, entries: [middle],
  });

  assert.deepEqual(result.map((message) => message.text), [
    before.text, note.text, first.text, middle.text, last.text, after.text,
  ]);
  assert.equal(result[2] === first, true);
  assert.equal(result[4] === last, true);
});

test('PROJECT-EMPTY: пустая видимая группа не обходит прежнюю историю', () => {
  const history = [{
    get runId() {
      throw new Error('История не нужна при пустой группе');
    },
  }];

  for (const entries of [[], [{ complete: false, text: 'Черновик' }]]) {
    const result = materializeInTurnMessages(history, { runId: RUN, entries });

    assert.equal(result === history, true);
  }
});

test('PROJECT-STORE: пачка ответов и её повтор сохраняют порядок без лишней записи', async (t) => {
  const chat = await chatStoreFixture({ sessions: [{
    id: CHAT,
    title: 'Синтетический разговор',
    model: 'test-model',
    taskId: null,
    messages: [{
      role: 'user',
      text: 'Вопрос',
      turnId: TURN,
    }],
    steps: [],
    sending: false,
    draft: '',
  }] });

  t.after(() => chat.$dispose());

  let writes = 0;

  chat._persist = () => {
    writes += 1;
  };
  chat._ensureInTurn(CHAT, RUN, TURN);

  const sse = sseOf(chat);
  const blocks = Array.from({ length: 40 }, (_, index) => ({
    chatKey: CHAT,
    runId: RUN,
    assistantMessageId: `store-block-${index}`,
    sequence: index + 1,
    revision: 2,
    text: `Ответ ${index}`,
    complete: true,
  }));

  for (const block of blocks) {
    sse('chat-assistant-message', {
      chatKey: CHAT,
      runId: RUN,
      block,
    });
  }

  const history = chat.sessions[0].messages;
  const savedWrites = writes;

  assert.deepEqual(history.map((message) => message.text), ['Вопрос', ...blocks.map((b) => b.text)]);
  assert.equal(savedWrites, blocks.length);

  for (const block of blocks) {
    sse('chat-assistant-message', {
      chatKey: CHAT,
      runId: RUN,
      block: { ...block },
    });
    sse('chat-assistant-message', {
      chatKey: CHAT,
      runId: RUN,
      block: {
        ...block,
        complete: false,
        revision: 1,
      },
    });
  }

  chat._mergeInTurnSnapshot(CHAT, RUN, {
    runId: RUN,
    available: true,
    revision: 1,
    entries: blocks.map((block) => ({ ...block })),
    nextAfterSequence: null,
    throughSequence: blocks.length,
    runRevision: blocks.length,
  }, TURN);

  assert.equal(chat.sessions[0].messages === history, true);
  assert.equal(writes, savedWrites);
  assert.deepEqual(history.slice(1).map((message) => message.assistantMessageId),
    blocks.map((block) => block.assistantMessageId));
});

test('PROJECT-RECONCILE: повтор страниц пропускает только безопасные лишние проекции', async (t) => {
  const chat = await chatStoreFixture({ sessions: [{
    id: CHAT,
    title: 'Восстановление',
    model: 'test-model',
    taskId: null,
    messages: [{
      role: 'user',
      text: 'Вопрос',
      turnId: TURN,
    }],
    steps: [],
    sending: false,
    draft: '',
  }] });

  t.after(() => chat.$dispose());

  let writes = 0;

  chat._persist = () => {
    writes += 1;
  };

  const blocks = Array.from({ length: 6 }, (_, index) => ({
    chatKey: CHAT,
    runId: RUN,
    assistantMessageId: `restore-block-${index}`,
    sequence: index + 1,
    revision: 1,
    text: `Ответ ${index}`,
    complete: true,
  }));

  chat._mergeInTurnSnapshot(CHAT, RUN, {
    runId: RUN,
    available: true,
    revision: 1,
    entries: blocks,
    nextAfterSequence: null,
    throughSequence: blocks.length,
    runRevision: 1,
  }, TURN);

  const session = chat.sessions[0];
  const project = chat._materializeInTurn;
  let projections = 0;
  let mode = 'unchanged';
  const calls = [];

  chat._materializeInTurn = (run) => {
    projections += 1;

    return project(run);
  };

  // Run уже известен, но повторно загруженная видимая история пока без его группы.
  session.messages = [session.messages[0]];

  apiHarness.get = async (url) => {
    const parsed = new URL(url, 'https://synthetic.invalid');
    const after = Number(parsed.searchParams.get('afterSequence') || 0);

    calls.push(after);

    if (after === 2 && mode === 'fail') {
      throw new Error('Отказ второй страницы');
    }
    if (after === 2 && mode === 'replace') {
      session.messages = [session.messages[0]];
    }
    if (after === 2 && mode === 'truncate') {
      session.messages.splice(1);
    }
    if (after === 2 && mode === 'parent') {
      chat.inTurnFor(CHAT).parentTurnId = 'changed-parent';
    }

    const entries = blocks.slice(after, after + 2).map((block) => {
      if (block.sequence === 3 && mode !== 'unchanged') {
        return {
          ...block,
          text: 'Новая редакция',
          revision: 2,
        };
      }

      return { ...block };
    });
    const next = after + 2 < blocks.length ? after + 2 : null;

    return {
      entries,
      nextAfterSequence: next,
      throughSequence: blocks.length,
      runRevision: 2,
      truncated: next !== null,
      availability: {
        runId: RUN,
        available: true,
        revision: 1,
      },
    };
  };

  for (const scenario of ['unchanged', 'updated', 'replace', 'truncate', 'parent', 'fail']) {
    mode = scenario;
    projections = 0;
    writes = 0;
    calls.length = 0;
    chat.inTurnFor(CHAT).completeThrough = 0;

    const restored = await chat._reconcileInTurn(CHAT, RUN);
    const expectedTexts = ['Вопрос', ...blocks.map((block) => block.text)];

    if (mode !== 'unchanged') {
      expectedTexts[3] = 'Новая редакция';
    }

    assert.equal(restored, mode !== 'fail', mode);
    assert.deepEqual(session.messages.map((message) => message.text), expectedTexts, mode);
    assert.equal(session.messages.length, blocks.length + 1, mode);
    assert.equal(session.messages.slice(1).every((message) => (
      message.parentTurnId === chat.inTurnFor(CHAT).parentTurnId
    )), true, mode);
    assert.equal(writes, mode === 'fail' ? 0 : 1, mode);
    assert.deepEqual(calls, mode === 'fail' ? [0, 2] : [0, 2, 4], mode);
    assert.equal(projections, mode === 'unchanged' || mode === 'fail' ? 1 : 2, mode);
    assert.equal(chat.inTurnFor(CHAT).completeThrough, mode === 'fail' ? 0 : blocks.length, mode);
  }
});
