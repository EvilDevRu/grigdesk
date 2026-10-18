// Проекция истории для следующего хода и опознание сообщений при слиянии.
//
// Проверяем два обещания этапа 7: следующий агент видит уточнения и ответы прошлого хода
// даже при закрытых окнах, а слияние не склеивает одинаковые тексты с разными id.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { mergeMessages } from '../../server/src/lib/chat/mergeChat.ts';
import { ChatAssistantMessages } from '../../server/src/lib/chat/assistantMessages.ts';
import { ChatInTurnLedger } from '../../server/src/lib/chat/inTurnLedger.ts';
import { InTurnHistory } from '../../server/src/lib/chat/inTurnHistory.ts';
import {
  chatAppFixture,
  saveChat,
  turnBody,
  waitFor,
} from './helpers/chat-turns.js';

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

/**
 * Исполнитель под управлением теста: отдаёт порт уточнений и держит ход, пока тест не
 * отпустит его. Так проверяется очередь «A работает → B ждёт».
 */
function holdingExecutor(t) {
  const runs = [];
  const delivered = [];
  let closing = false;

  t.after(() => {
    closing = true;

    for (const run of runs) {
      run.hold.resolve();
    }
  });

  const executor = {
    id: 'test-provider',
    inTurnInput: { protocol: 1, text: true, confirmation: 'forwarded' },
    // Снимок берётся до ожидания и до чтений через API: reader не должен сам
    // достраивать историю и тем самым скрывать отсутствие барьера записи.
    async run(options) {
      const chatPath = path.join(options.config.chatsDir, '2026-09', options.chatKey + '.json');
      const history = JSON.parse(await fs.readFile(chatPath, 'utf8')).messages;
      const hold = deferred();
      const run = {
        options,
        hold,
        history,
      };

      runs.push(run);

      if (closing) {
        hold.resolve();
      }

      options.onInTurnReady?.({
        async deliver(input) {
          delivered.push(input);

          return { ok: true, state: 'forwarded' };
        },
        close() {},
      });
      const extra = await hold.promise;

      return { reply: 'готово', sessionId: 'session-fixture', steps: [], ...(extra || {}) };
    },
  };

  return { executor, runs, delivered };
}

async function activeRun(app, chatKey) {
  const active = await app.inject({ method: 'GET', url: '/api/chat/active' });

  return active.json().active.find((entry) => entry.chatKey === chatKey) || null;
}

async function tmpHistory() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-in-turn-history-'));

  return {
    dir,
    ledger: new ChatInTurnLedger({ dir: path.join(dir, 'messages'), now: () => 1000 }),
    assistant: new ChatAssistantMessages({ dir: path.join(dir, 'assistant'), now: () => 1000 }),
  };
}

test('FLOW-15: следующий ход видит уточнение и ответы прошлого запуска при закрытых окнах', async (t) => {
  const { executor, runs, delivered } = holdingExecutor(t);
  const { app } = await chatAppFixture(t, { executor });

  await saveChat(app, 'chat-fixture');

  // Ход A: принимается коротко и держится тестом.
  const startedA = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('chat-fixture', 'turn-fixture-a001', 'Проверь два файла'),
  });

  assert.equal(startedA.statusCode, 202, startedA.body);

  const activeA = await waitFor(async () => {
    const run = await activeRun(app, 'chat-fixture');

    return run?.inTurn?.available ? run : null;
  }, { what: 'готовый канал хода A' });

  // Уточнение C приходит в A, пока B ещё не принят.
  const acceptedC = await app.inject({
    method: 'POST',
    url: '/api/chat/in-turn',
    payload: {
      chatKey: 'chat-fixture',
      targetRunId: activeA.runId,
      messageId: 'message-fixture-c001',
      text: 'Почему выбран первый файл?',
    },
  });

  assert.equal(acceptedC.statusCode, 202);
  await waitFor(() => delivered.length === 1, { what: 'доставку C в A' });

  // Промежуточный видимый ответ A.
  await runs[0].options.onAssistantMessage({
    assistantMessageId: 'assistant-fixture-a001',
    text: 'Потому что он меньше.',
    sourceRevision: 1,
    complete: true,
  });

  // Ход B встаёт в очередь обычных ходов: тот же чат, пока A работает.
  const startedB = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('chat-fixture', 'turn-fixture-b001', 'Теперь проверь третий файл'),
  });

  assert.equal(startedB.statusCode, 202);
  assert.equal(startedB.json().state, 'queued');

  // A завершается: итог уходит в pending, B получает очередь.
  runs[0].hold.resolve();

  await waitFor(() => runs.length === 2, { what: 'старт хода B' });

  assert.equal(Object.hasOwn(runs[1].options, 'chatHistory'), false);

  const history = runs[1].history;
  const texts = history.map((message) => String(message.text || ''));

  assert.equal(texts.filter((text) => text === 'Почему выбран первый файл?').length, 1, 'уточнение C ровно один раз');
  assert.equal(texts.filter((text) => text === 'Потому что он меньше.').length, 1, 'промежуточный ответ ровно один раз');
  assert.equal(texts.filter((text) => text === 'готово').length, 1, 'финальный ответ A ровно один раз');
  assert.deepEqual(texts, [
    'Проверь два файла',
    'Почему выбран первый файл?',
    'Потому что он меньше.',
    'готово',
  ]);

  const inTurn = history.find((message) => message.messageId === 'message-fixture-c001');

  assert.equal(inTurn.kind, 'in-turn');
  assert.equal(inTurn.runId, activeA.runId);

  const block = history.find((message) => message.assistantMessageId === 'assistant-fixture-a001');

  assert.equal(block.kind, 'assistant-block');
  assert.equal(block.role, 'assistant');

  runs[1].hold.resolve();
});

test('FLOW-17: ошибка записи группы не запускает следующий executor; повтор сохраняет её', async (t) => {
  const { executor, runs, delivered } = holdingExecutor(t);
  const { app, config } = await chatAppFixture(t, { executor });

  await saveChat(app, 'chat-fixture');
  await app.inject({
    method: 'POST', url: '/api/chat',
    payload: turnBody('chat-fixture', 'turn-fixture-a017', 'Первая работа'),
  });
  const active = await waitFor(async () => {
    const run = await activeRun(app, 'chat-fixture');

    return run?.inTurn?.available ? run : null;
  }, { what: 'канал A' });
  await app.inject({
    method: 'POST', url: '/api/chat/in-turn',
    payload: {
      chatKey: 'chat-fixture', targetRunId: active.runId,
      messageId: 'message-fixture-f017', text: 'Почему так?',
    },
  });
  await waitFor(() => delivered.length === 1, { what: 'доставку уточнения' });
  runs[0].hold.resolve();
  await waitFor(async () => {
    const response = await app.inject({ method: 'GET', url: '/api/chat/pending' });

    return response.json().pending.some((item) => item.turnId === 'turn-fixture-a017');
  }, { what: 'итог A' });

  const monthDir = path.join(config.chatsDir, '2026-09');
  await fs.chmod(monthDir, 0o500);

  try {
    await app.inject({
      method: 'POST', url: '/api/chat',
      payload: turnBody('chat-fixture', 'turn-fixture-b017', 'Вторая работа'),
    });
    await waitFor(async () => {
      const response = await app.inject({ method: 'GET', url: '/api/chat/pending' });

      return response.json().pending.some((item) => item.turnId === 'turn-fixture-b017');
    }, { what: 'ошибку записи B' });
    assert.equal(runs.length, 1, 'B не получил неполную историю');
  } finally {
    await fs.chmod(monthDir, 0o700);
  }

  await app.inject({
    method: 'POST', url: '/api/chat',
    payload: turnBody('chat-fixture', 'turn-fixture-c017', 'Третья работа'),
  });
  await waitFor(() => runs.length === 2, { what: 'восстановленный ход C' });
  assert.equal(runs[1].history.filter((message) => message.text === 'Почему так?').length, 1);
  runs[1].hold.resolve();
});

test('FLOW-18: большой PUT не переписывает canonical receipt, текст и sequence', async (t) => {
  const { executor, runs, delivered } = holdingExecutor(t);
  const { app } = await chatAppFixture(t, { executor });

  await saveChat(app, 'chat-fixture');
  await app.inject({
    method: 'POST', url: '/api/chat',
    payload: turnBody('chat-fixture', 'turn-fixture-a018', 'Первая работа'),
  });
  const active = await waitFor(async () => {
    const run = await activeRun(app, 'chat-fixture');

    return run?.inTurn?.available ? run : null;
  }, { what: 'канал A' });
  await app.inject({
    method: 'POST', url: '/api/chat/in-turn',
    payload: {
      chatKey: 'chat-fixture', targetRunId: active.runId,
      messageId: 'message-fixture-f018', text: 'Канонический вопрос',
    },
  });
  await waitFor(() => delivered.length === 1, { what: 'доставку уточнения' });
  await runs[0].options.onAssistantMessage({
    assistantMessageId: 'assistant-fixture-a018',
    text: 'готово', sourceRevision: 1, complete: true,
  });
  runs[0].hold.resolve({ assistantMessageId: 'assistant-fixture-a018' });
  await waitFor(async () => {
    const response = await app.inject({ method: 'GET', url: '/api/chat/pending' });

    return response.json().pending.some((item) => item.turnId === 'turn-fixture-a018');
  }, { what: 'итог A' });
  const forged = await app.inject({
    method: 'PUT', url: '/api/chat/store/chat',
    payload: { chat: {
      id: 'chat-fixture', revision: 99_999, modelRef: { provider: 'test-provider', model: 'test-model' },
      messages: [
        {
          role: 'user', kind: 'in-turn', runId: active.runId,
          messageId: 'message-fixture-f018', text: 'Подменённый вопрос',
          sequence: 99_999, receipt: { state: 'failed' },
        },
        {
          role: 'assistant', runId: active.runId,
          assistantMessageId: 'assistant-fixture-a018', text: 'Подменённый ответ',
          sequence: 99_999,
        },
      ],
    } },
  });
  assert.equal(forged.statusCode, 200, forged.body);
  const stored = await app.inject({ method: 'GET', url: '/api/chat/store/chat/chat-fixture' });
  const messages = stored.json().chat.messages;
  const question = messages.find((message) => message.messageId === 'message-fixture-f018');
  const answer = messages.find((message) => message.assistantMessageId === 'assistant-fixture-a018');

  assert.equal(question.text, 'Канонический вопрос');
  assert.equal(question.receipt.state, 'forwarded');
  assert.ok(question.sequence < 99_999);
  assert.equal(answer.text, 'готово');
  assert.ok(answer.sequence < 99_999);
  assert.equal(messages.filter((message) => message.assistantMessageId === 'assistant-fixture-a018').length, 1);
});

test('FLOW-16: недоставленное и неопределённое в проекцию не попадает', async () => {
  const { ledger, assistant } = await tmpHistory();
  const history = new InTurnHistory({ ledger, assistant });

  await ledger.put({
    chatKey: 'chat-fixture',
    messageId: 'message-fixture-0001',
    runId: 'run-fixture-0001',
    state: 'forwarded',
    revision: 1,
    sequence: 1,
    text: 'Доставленный вопрос',
    fingerprint: 'fp-1',
    acceptedAt: 1000,
    updatedAt: 1000,
  });
  await ledger.put({
    chatKey: 'chat-fixture',
    messageId: 'message-fixture-0002',
    runId: 'run-fixture-0001',
    state: 'failed',
    revision: 1,
    sequence: 2,
    text: 'Недоставленный вопрос',
    fingerprint: 'fp-2',
    acceptedAt: 1000,
    updatedAt: 1000,
  });
  await ledger.put({
    chatKey: 'chat-fixture',
    messageId: 'message-fixture-0003',
    runId: 'run-fixture-0001',
    state: 'unknown',
    revision: 1,
    sequence: 3,
    text: 'Вопрос с неясным исходом',
    fingerprint: 'fp-3',
    acceptedAt: 1000,
    updatedAt: 1000,
  });
  await assistant.begin({
    runId: 'run-fixture-0001',
    chatKey: 'chat-fixture',
    assistantMessageId: 'assistant-fixture-0001',
    sequence: 4,
  });
  await assistant.appendDelta('run-fixture-0001', 'assistant-fixture-0001', 'Ответ по ходу');
  await assistant.complete('run-fixture-0001', 'assistant-fixture-0001');

  const projected = history.project({
    chatKey: 'chat-fixture',
    base: [{ role: 'user', text: 'Исходная задача' }],
    pending: [],
  });

  assert.deepEqual(
    projected.map((message) => message.text),
    ['Исходная задача', 'Доставленный вопрос', 'Ответ по ходу'],
  );
  assert.equal(projected[1].kind, 'in-turn');
  assert.equal(projected[2].kind, 'assistant-block');
});

test('FLOW-16: одинаковые тексты с разными id не склеиваются, pending не дублируется', async () => {
  const { ledger, assistant } = await tmpHistory();
  const history = new InTurnHistory({ ledger, assistant });

  for (const [index, messageId] of ['message-fixture-0001', 'message-fixture-0002'].entries()) {
    await ledger.put({
      chatKey: 'chat-fixture',
      messageId,
      runId: 'run-fixture-0001',
      state: 'consumed',
      revision: 1,
      sequence: index + 1,
      text: 'да',
      fingerprint: `fp-${index}`,
      acceptedAt: 1000,
      updatedAt: 1000,
    });
  }

  const projected = history.project({
    chatKey: 'chat-fixture',
    base: [{ role: 'user', text: 'да', messageId: 'message-fixture-0001' }],
    pending: [
      { id: 'o-pending-1', chatKey: 'chat-fixture', role: 'assistant', reply: 'готово', turnId: 'turn-fixture-a001' },
    ],
  });

  assert.deepEqual(
    projected.map((message) => message.messageId || message.pid || message.turnId),
    ['message-fixture-0001', 'message-fixture-0002', 'o-pending-1'],
  );

  const again = history.project({
    chatKey: 'chat-fixture',
    base: [
      { role: 'user', text: 'да', messageId: 'message-fixture-0001' },
      { role: 'assistant', text: 'готово', pid: 'o-pending-1' },
    ],
    pending: [
      { id: 'o-pending-1', chatKey: 'chat-fixture', role: 'assistant', reply: 'готово', turnId: 'turn-fixture-a001' },
    ],
  });

  assert.equal(again.filter((message) => String(message.text) === 'готово').length, 1, 'pending не продублирован');
});

test('FLOW-13: слияние опознаёт сообщения по id, а не по тексту', () => {
  const server = {
    messages: [
      { role: 'user', text: 'да', messageId: 'message-fixture-0001', kind: 'in-turn' },
      { role: 'assistant', text: 'Ответ', assistantMessageId: 'assistant-fixture-0001', runId: 'run-fixture-0001' },
    ],
  };
  const staleWindow = {
    messages: [{ role: 'user', text: 'да', messageId: 'message-fixture-0002', kind: 'in-turn' }],
  };

  const merged = mergeMessages(server.messages, staleWindow.messages);

  assert.equal(merged.messages.filter((message) => message.text === 'да').length, 2, 'две реплики с разными id целы');
  assert.ok(
    merged.messages.some((message) => message.assistantMessageId === 'assistant-fixture-0001'),
    'блок ответа не потерян',
  );

  // Та же реплика, приехавшая двумя путями: сервер знает её по pid (восстановление из
  // pending), окно-отправитель присылает копию без ключа. Это одно сообщение, не два.
  const restored = mergeMessages(
    [{ role: 'user', text: 'да', pid: 'o-pending-1:u', turnId: 'turn-fixture-a001' }],
    [{ role: 'user', text: 'да', sentAt: 1 }],
  );

  assert.equal(restored.messages.filter((message) => message.text === 'да').length, 1);

  // Обратный порядок: серверная копия без ключа, клиентская — с ключом.
  const keyed = mergeMessages(
    [{ role: 'user', text: 'да', sentAt: 1 }],
    [{ role: 'user', text: 'да', messageId: 'message-fixture-0001' }],
  );

  assert.equal(keyed.messages.filter((message) => message.text === 'да').length, 1);
});

test('картинки уточнения переходят в историю вместе с сообщением', async () => {
  const { ledger, assistant } = await tmpHistory();
  const history = new InTurnHistory({ ledger, assistant });
  const attachments = [{
    file: '1700000000000-shot.png',
    name: 'shot.png',
    url: '/api/chat/attachment/1700000000000-shot.png',
    mime: 'image/png',
  }];

  await ledger.put({
    chatKey: 'chat-fixture',
    messageId: 'message-fixture-0001',
    runId: 'run-fixture-0001',
    state: 'forwarded',
    revision: 1,
    sequence: 1,
    text: 'Сравни с референсом',
    attachments,
    fingerprint: 'fp-1',
    acceptedAt: 1000,
    updatedAt: 1000,
  });

  const [message] = history.runMessages('run-fixture-0001');

  assert.equal(message.kind, 'in-turn');
  assert.deepEqual(message.attachments, attachments);
  assert.deepEqual(message.receipt.attachments, attachments);
});
