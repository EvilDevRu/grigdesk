// Контракт исполнителя в части канала уточнений: разовый запуск и живая сессия.
//
// Порт обязан доходить до адаптера одинаково в обоих режимах, а видимый ответ — становиться
// durable-записью с общим sequence. Проверяем настоящий модуль чата, а не отдельную функцию.
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseInTurnCapability } from '../../shared/chatInTurnContracts.ts';
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
 * Разовый исполнитель: объявляет канал и отдаёт порт прямо из run(), как это делает
 * адаптер без живой сессии. Тест сам решает, когда ход закончится.
 */
function oneShotExecutor() {
  const delivered = [];
  const runs = [];

  const executor = {
    id: 'test-provider',
    inTurnInput: { protocol: 1, text: true, confirmation: 'forwarded' },
    async run(options) {
      const hold = deferred();

      runs.push({ options, hold });
      options.onInTurnReady?.({
        async deliver(input) {
          delivered.push(input);

          return { ok: true, state: 'forwarded' };
        },
        close() {},
      });
      await hold.promise;

      return { reply: 'готово', sessionId: 'session-one-shot', steps: [] };
    },
  };

  return { executor, delivered, runs };
}

/**
 * Живой исполнитель: порт приходит внутрь handle.send(), то есть через пул сессий.
 * Если пул потеряет колбэки, канал у живого режима молча закроется — этот тест и ловит.
 */
function liveExecutor() {
  const delivered = [];
  const sent = [];

  const executor = {
    id: 'test-provider',
    inTurnInput: { protocol: 1, text: true, confirmation: 'forwarded' },
    session: {
      mode: 'persistent',
      async open() {
        return {
          alive: true,
          async send(turn) {
            const hold = deferred();

            sent.push(turn);
            turn.onInTurnReady?.({
              async deliver(input) {
                delivered.push(input);

                return { ok: true, state: 'forwarded' };
              },
              close() {},
            });
            await hold.promise;

            return { sessionId: 'session-live' };
          },
          async interrupt() {},
          async close() {},
        };
      },
    },
  };

  return { executor, delivered, sent };
}

async function startTurn(app) {
  const answer = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody('chat-fixture', 'turn-fixture-0001'),
  });

  assert.equal(answer.statusCode, 202, answer.body);
}

async function activeRun(app) {
  const active = await app.inject({ method: 'GET', url: '/api/chat/active' });

  return active.json().active.find((entry) => entry.chatKey === 'chat-fixture') || null;
}

test('разовый запуск: порт, доставка и видимый ответ становятся durable', async (t) => {
  const { executor, delivered, runs } = oneShotExecutor();
  const { app } = await chatAppFixture(t, { executor, prefs: { chatLiveSessions: false } });

  await saveChat(app, 'chat-fixture');
  await startTurn(app);

  const started = await waitFor(async () => {
    const run = await activeRun(app);

    return run?.inTurn?.available ? run : null;
  }, { what: 'готовый канал разового запуска' });

  await runs[0].options.onAssistantMessage({
    assistantMessageId: 'assistant-fixture-0001',
    text: 'Сначала проверяю первый файл.',
    sourceRevision: 1,
    complete: false,
  });
  await runs[0].options.onAssistantMessage({
    assistantMessageId: 'assistant-fixture-0001',
    text: 'Сначала проверяю первый файл.',
    sourceRevision: 2,
    complete: true,
  });

  const accepted = await app.inject({
    method: 'POST',
    url: '/api/chat/in-turn',
    payload: {
      chatKey: 'chat-fixture',
      targetRunId: started.runId,
      messageId: 'message-fixture-0001',
      text: 'Почему начал с первого?',
    },
  });

  assert.equal(accepted.statusCode, 202);
  await waitFor(() => delivered.length === 1, { what: 'доставку в разовом режиме' });

  const page = await app.inject({
    method: 'GET',
    url: `/api/chat/in-turn?chatKey=chat-fixture&runId=${started.runId}`,
  });
  const entries = page.json().entries;

  assert.deepEqual(entries.map((entry) => entry.sequence), [1, 2], 'общий sequence без дыр');
  assert.equal(entries[0].assistantMessageId, 'assistant-fixture-0001');
  assert.equal(entries[0].complete, true);
  assert.equal(entries[0].text, 'Сначала проверяю первый файл.');
  assert.equal(entries[1].messageId, 'message-fixture-0001');
});

test('живая сессия: колбэки проходят через пул и порт открывается', async (t) => {
  const { executor, delivered, sent } = liveExecutor();
  const { app } = await chatAppFixture(t, { executor });

  await saveChat(app, 'chat-fixture');
  await startTurn(app);

  const started = await waitFor(async () => {
    const run = await activeRun(app);

    return run?.inTurn?.available ? run : null;
  }, { what: 'готовый канал живой сессии' });

  assert.equal(sent.length, 1, 'ход ушёл в живую сессию');
  assert.equal(typeof sent[0].onInTurnReady, 'function', 'порт дошёл до handle.send');

  const accepted = await app.inject({
    method: 'POST',
    url: '/api/chat/in-turn',
    payload: {
      chatKey: 'chat-fixture',
      targetRunId: started.runId,
      messageId: 'message-fixture-0002',
      text: 'И что дальше?',
    },
  });

  assert.equal(accepted.statusCode, 202);
  await waitFor(() => delivered.length === 1, { what: 'доставку в живой сессии' });
});

test('исполнитель без канала честно объявляет unsupported, а не «ещё не готов»', async (t) => {
  const executor = {
    id: 'test-provider',
    async run() {
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });

      return { reply: 'готово', sessionId: 'session-no-channel', steps: [] };
    },
  };
  const { app } = await chatAppFixture(t, { executor });

  await saveChat(app, 'chat-fixture');
  await startTurn(app);

  const started = await waitFor(async () => {
    const active = await app.inject({ method: 'GET', url: '/api/chat/active' });
    const run = active.json().active.find((entry) => entry.chatKey === 'chat-fixture');

    return run?.inTurn?.reason === 'unsupported' ? run : null;
  }, { what: 'причину unsupported' });

  const rejected = await app.inject({
    method: 'POST',
    url: '/api/chat/in-turn',
    payload: {
      chatKey: 'chat-fixture',
      targetRunId: started.runId,
      messageId: 'message-fixture-0001',
      text: 'Уточнение без канала',
    },
  });

  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json().error, 'in_turn_unavailable');
  assert.equal(rejected.json().reason, 'unsupported');
});

test('capability канала публикуется только из разобранного объявления', () => {
  assert.deepEqual(
    parseInTurnCapability({ protocol: 1, text: true, confirmation: 'consumed' }),
    { protocol: 1, text: true, confirmation: 'consumed' },
  );
  assert.equal(parseInTurnCapability({ protocol: 0, text: true }), null);
  assert.equal(parseInTurnCapability({ protocol: 2, text: false }), null);
  assert.equal(parseInTurnCapability('да'), null);
  assert.equal(parseInTurnCapability(null), null);
});
