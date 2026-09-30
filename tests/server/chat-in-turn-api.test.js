// HTTP-канал уточнений: приём, отказы, восстановление и публикация в active.
//
// Проверяем настоящий модуль чата и настоящий Fastify: окно получает короткий ответ сразу
// после устойчивой записи, а доставку выполняет координатор, не создавая второй обычный ход.
import assert from 'node:assert/strict';
import test from 'node:test';

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
 * Исполнитель под управлением теста: сам объявляет канал, отдаёт порт и записывает,
 * что именно ему передали. Настоящих моделей и процессов здесь нет.
 */
function inTurnExecutor({ registerPort = true } = {}) {
  const runs = [];
  const delivered = [];

  const executor = {
    id: 'test-provider',
    inTurnInput: { protocol: 1, text: true, confirmation: 'forwarded' },
    async run(options) {
      const hold = deferred();
      const run = {
        options,
        hold,
        closed: false,
        result: { ok: true, state: 'forwarded' },
      };

      runs.push(run);

      if (registerPort) {
        options.onInTurnReady?.({
          async deliver(input) {
            delivered.push(input);

            return run.result;
          },
          close(reason) {
            run.closed = true;
            run.closeReason = reason;
          },
        });
      }

      await hold.promise;

      return { reply: 'готово', sessionId: 'session-fixture', steps: [] };
    },
  };

  return { executor, runs, delivered };
}

/** Запуск обычного хода по протоколу приёма: окно получает 202 и turnId. */
async function startTurn(app, chatKey, turnId, message = 'исследуй два файла') {
  const answer = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody(chatKey, turnId, message),
  });

  assert.equal(answer.statusCode, 202, answer.body);

  return answer.json();
}

/** Текущий запуск чата, как его видит окно: runId и состояние канала уточнений. */
async function activeRun(app, chatKey) {
  const active = await app.inject({ method: 'GET', url: '/api/chat/active' });

  return active.json().active.find((entry) => entry.chatKey === chatKey) || null;
}

test('уточнение принимается по 202, доходит до порта и восстанавливается через GET', async (t) => {
  const { executor, runs, delivered } = inTurnExecutor();
  const { app, events } = await chatAppFixture(t, { executor });

  await saveChat(app, 'chat-fixture');
  await startTurn(app, 'chat-fixture', 'turn-fixture-0001');

  const started = await waitFor(async () => {
    const run = await activeRun(app, 'chat-fixture');

    return run?.inTurn?.available ? run : null;
  }, { what: 'готовый канал запуска' });

  assert.match(started.runId, /^run-[A-Za-z0-9-]{8,80}$/);
  assert.equal(started.inTurn.available, true);
  assert.equal(runs.length, 1);

  const accepted = await app.inject({
    method: 'POST',
    url: '/api/chat/in-turn',
    payload: {
      chatKey: 'chat-fixture',
      targetRunId: started.runId,
      messageId: 'message-fixture-0001',
      text: 'Почему выбран первый файл?',
    },
  });

  assert.equal(accepted.statusCode, 202, accepted.body);
  assert.equal(accepted.json().accepted, true);
  assert.equal(accepted.json().state, 'accepted');
  assert.equal(accepted.json().runId, started.runId);

  await waitFor(() => delivered.some((item) => item.messageId === 'message-fixture-0001'), {
    what: 'передачу уточнения в порт',
  });

  const receipt = await app.inject({
    method: 'GET',
    url: '/api/chat/in-turn?chatKey=chat-fixture&ids=message-fixture-0001,message-unknown-01',
  });
  const body = receipt.json();

  assert.equal(body.messages['message-fixture-0001'].state, 'forwarded');
  assert.equal(body.messages['message-fixture-0001'].sequence, 1);
  assert.equal(body.messages['message-unknown-01'], null);

  const runId = started.runId;
  const page = await app.inject({
    method: 'GET',
    url: `/api/chat/in-turn?chatKey=chat-fixture&runId=${runId}`,
  });
  const pageBody = page.json();

  assert.equal(pageBody.entries.length, 1);
  assert.equal(pageBody.entries[0].messageId, 'message-fixture-0001');
  assert.equal(pageBody.throughSequence, 1);
  assert.equal(pageBody.nextAfterSequence, null);

  assert.ok(events.some((event) => event.event === 'chat-in-turn'), 'событие канала ушло окнам');
  const start = events.find((event) => event.event === 'chat-turn-start');

  assert.equal(start.data.runId, runId, 'окно узнаёт runId из chat-turn-start');
});

test('дубликат, конфликт и негодные поля отвечают детерминированно', async (t) => {
  const { executor } = inTurnExecutor();
  const { app } = await chatAppFixture(t, { executor });

  await saveChat(app, 'chat-fixture');
  await startTurn(app, 'chat-fixture', 'turn-fixture-0001');

  const started = await waitFor(async () => {
    const run = await activeRun(app, 'chat-fixture');

    return run?.inTurn?.available ? run : null;
  }, { what: 'готовый канал запуска' });

  const payload = {
    chatKey: 'chat-fixture',
    targetRunId: started.runId,
    messageId: 'message-fixture-0001',
    text: 'Почему выбран первый файл?',
  };

  assert.equal((await app.inject({ method: 'POST', url: '/api/chat/in-turn', payload })).statusCode, 202);

  const duplicate = await app.inject({ method: 'POST', url: '/api/chat/in-turn', payload });

  assert.equal(duplicate.statusCode, 202);
  assert.equal(duplicate.json().duplicate, true);

  const conflict = await app.inject({
    method: 'POST',
    url: '/api/chat/in-turn',
    payload: { ...payload, text: 'Совсем другой вопрос' },
  });

  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error, 'message_conflict');

  const unknownField = await app.inject({
    method: 'POST',
    url: '/api/chat/in-turn',
    payload: { ...payload, model: 'evil-model' },
  });

  assert.equal(unknownField.statusCode, 400);
  assert.equal(unknownField.json().error, 'invalid_in_turn_message');

  const badId = await app.inject({
    method: 'POST',
    url: '/api/chat/in-turn',
    payload: { ...payload, messageId: 'short' },
  });

  assert.equal(badId.statusCode, 400);

  const tooLarge = await app.inject({
    method: 'POST',
    url: '/api/chat/in-turn',
    payload: { ...payload, messageId: 'message-fixture-0002', text: 'я'.repeat(20_000) },
  });

  assert.equal(tooLarge.statusCode, 413);
  assert.equal(tooLarge.json().error, 'message_too_large');
});

test('без активного запуска и без готового порта уточнение не принимается', async (t) => {
  const { executor } = inTurnExecutor({ registerPort: false });
  const { app } = await chatAppFixture(t, { executor });

  await saveChat(app, 'chat-fixture');
  await startTurn(app, 'chat-fixture', 'turn-fixture-0001');

  const started = await waitFor(() => activeRun(app, 'chat-fixture'), {
    what: 'запись запуска в active',
  });

  const unavailable = await app.inject({
    method: 'POST',
    url: '/api/chat/in-turn',
    payload: {
      chatKey: 'chat-fixture',
      targetRunId: started.runId,
      messageId: 'message-fixture-0001',
      text: 'Вопрос без готового транспорта',
    },
  });

  assert.equal(unavailable.statusCode, 409);
  assert.equal(unavailable.json().error, 'in_turn_unavailable');
  assert.equal(unavailable.json().reason, 'not_ready');

  const noRun = await app.inject({
    method: 'POST',
    url: '/api/chat/in-turn',
    payload: {
      chatKey: 'chat-fixture',
      targetRunId: 'run-does-not-exist',
      messageId: 'message-fixture-0002',
      text: 'Вопрос в пустоту',
    },
  });

  assert.equal(noRun.statusCode, 409);
  assert.equal(noRun.json().error, 'turn_changed');
});

test('GET не отдаёт чужие записи и объявляет протокол в истории', async (t) => {
  const { executor } = inTurnExecutor();
  const { app } = await chatAppFixture(t, { executor });

  await saveChat(app, 'chat-fixture');
  await saveChat(app, 'chat-other');

  const store = await app.inject({ method: 'GET', url: '/api/chat/store' });

  assert.equal(store.json().inTurnProtocol, 1);

  const foreign = await app.inject({
    method: 'GET',
    url: '/api/chat/in-turn?chatKey=chat-other&runId=run-fixture-absent',
  });

  assert.equal(foreign.statusCode, 404);

  const missingKey = await app.inject({ method: 'GET', url: '/api/chat/in-turn' });

  assert.equal(missingKey.statusCode, 400);

  const tooMany = await app.inject({
    method: 'GET',
    url: `/api/chat/in-turn?chatKey=chat-fixture&ids=${Array.from({ length: 51 }, (_, index) => `message-${index}`).join(',')}`,
  });

  assert.equal(tooMany.statusCode, 400);
});

test('вопрос исполнителя закрывает общий канал уточнений до ответа человека', async (t) => {
  const { executor, runs, delivered } = inTurnExecutor();
  const { app, events } = await chatAppFixture(t, { executor });
  await saveChat(app, 'chat-fixture');
  await startTurn(app, 'chat-fixture', 'turn-fixture-0001');
  const started = await waitFor(async () => {
    const run = await activeRun(app, 'chat-fixture');
    return run?.inTurn?.available ? run : null;
  }, { what: 'готовый канал запуска' });
  const question = runs[0].options.onPermission({
    tool: 'Вопрос агента', isQuestion: true,
    questions: [{ key: 'q1', question: 'Как продолжить?', options: [] }],
  });
  await waitFor(async () => (await activeRun(app, 'chat-fixture'))?.inTurn?.reason === 'awaiting_answer', {
    what: 'барьер вопроса',
  });
  const refused = await app.inject({
    method: 'POST', url: '/api/chat/in-turn',
    payload: {
      chatKey: 'chat-fixture', targetRunId: started.runId,
      messageId: 'message-fixture-0001', text: 'Почему выбран первый файл?',
    },
  });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().reason, 'awaiting_answer');
  assert.equal(delivered.length, 0);
  const pid = events.find((event) => event.event === 'chat-question')?.data?.pid;
  assert.ok(pid);
  const answered = await app.inject({
    method: 'POST', url: `/api/chat/permission/${pid}`,
    payload: { answers: [{ text: 'Проверяй дальше.' }] },
  });
  assert.equal(answered.statusCode, 200);
  assert.equal((await question).text, 'Проверяй дальше.');
  await waitFor(async () => (await activeRun(app, 'chat-fixture'))?.inTurn?.available, {
    what: 'возобновление канала',
  });
  const accepted = await app.inject({
    method: 'POST', url: '/api/chat/in-turn',
    payload: {
      chatKey: 'chat-fixture', targetRunId: started.runId,
      messageId: 'message-fixture-0001', text: 'Почему выбран первый файл?',
    },
  });
  assert.equal(accepted.statusCode, 202);
  await waitFor(() => delivered.length === 1, { what: 'доставку после ответа' });
});

test('Claude MCP-вопрос использует тот же барьер активного хода', async (t) => {
  const { executor, delivered } = inTurnExecutor();
  const { app, events } = await chatAppFixture(t, { executor });
  await saveChat(app, 'chat-fixture');
  await startTurn(app, 'chat-fixture', 'turn-fixture-0001');
  const started = await waitFor(async () => {
    const run = await activeRun(app, 'chat-fixture');
    return run?.inTurn?.available ? run : null;
  }, { what: 'готовый канал запуска' });
  const pending = app.inject({
    method: 'POST', url: '/api/chat/permission-request',
    payload: {
      chatKey: 'chat-fixture', tool_name: 'AskUserQuestion',
      input: { questions: [{ question: 'Как продолжить?' }] },
    },
  });
  const pid = await waitFor(() => events.find((event) => event.event === 'chat-question')?.data?.pid, {
    what: 'MCP-вопрос Claude',
  });
  assert.equal((await activeRun(app, 'chat-fixture')).inTurn.reason, 'awaiting_answer');
  const refused = await app.inject({
    method: 'POST', url: '/api/chat/in-turn',
    payload: {
      chatKey: 'chat-fixture', targetRunId: started.runId,
      messageId: 'message-fixture-0001', text: 'Почему выбран первый файл?',
    },
  });
  assert.equal(refused.json().reason, 'awaiting_answer');
  assert.equal(delivered.length, 0);
  await app.inject({
    method: 'POST', url: `/api/chat/permission/${pid}`,
    payload: { answers: [{ text: 'Проверяй дальше.' }] },
  });
  assert.match((await pending).json().message, /Проверяй дальше/u);
  await waitFor(async () => (await activeRun(app, 'chat-fixture'))?.inTurn?.available, {
    what: 'возобновление после MCP-вопроса',
  });
});
