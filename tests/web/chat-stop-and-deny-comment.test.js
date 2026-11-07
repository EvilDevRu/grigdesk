// Две болезни одной гонки «стоп + очередь» и одной доставки «отказ с пояснением»:
//
// 1) Кнопка «Остановить агента» замирала в «Останавливаю…» на весь следующий ход:
//    chat-done с непустой очередью не сбрасывает stopping (работа ведь продолжается),
//    а старт очередного хода сброс не делал вовсе. Старт хода обязан освобождать кнопку —
//    стоп относился к прошлому ходу.
// 2) Пояснение к отказу из модалки у прямых исполнителей (GLM, DeepSeek) канал эскалации
//    не несёт: сервер отвечает commentDelivered:false, и агент получает голый отказ.
//    Пояснение должно догонять его в активном ходе (in-turn), а не ждать своей очереди
//    отдельным ходом; фолбэк — прежняя очередь, если канал не готов.
import assert from 'node:assert/strict';
import test from 'node:test';

import { apiHarness, chatStoreFixture, sseOf } from './helpers/chat-store.js';
import { newChatInTurnRun } from '../../web/src/stores/chatInTurn.ts';

const CHAT = 'stop-deny-chat';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function fixture() {
  const chat = await chatStoreFixture({ sessions: [{
    id: CHAT,
    model: 'test-model',
    messages: [],
    steps: [],
  }] });

  apiHarness.get = async () => ({});

  return {
    chat,
    sse: sseOf(chat),
    session: chat.sessions[0],
  };
}

test('старт хода из очереди освобождает кнопку остановки после стопа прошлого хода', async () => {
  const { sse, session } = await fixture();

  session.sending = true;
  session.stopping = true;

  sse('chat-done', {
    chatKey: CHAT,
    runId: 'run-a',
    turnId: 'turn-a',
    queued: 1,
  });
  await tick();
  // Прежний сброс в finish() не срабатывает: очередь непуста, а старт нового хода уже
  // поменял ревизию — гвардия выйдет раньше. Останавливается всё только стартом хода.
  sse('chat-turn-start', {
    chatKey: CHAT,
    runId: 'run-b',
    snapshot: { chatKey: CHAT, runId: 'run-b' },
  });
  await tick();

  assert.equal(session.stopping, false, 'кнопка обязана освободиться с началом нового хода');
  assert.equal(session.sending, true, 'работа продолжается — ход из очереди идёт');
});

test('пояснение отказа уходит в активный ход с префиксом-связкой, а не в очередь', async () => {
  const { chat } = await fixture();

  chat.pending['perm-1'] = {
    pid: 'perm-1',
    kind: 'perm',
    chatKey: CHAT,
    tool: 'Bash',
  };

  const run = newChatInTurnRun(CHAT, 'run-x');

  run.availability = {
    runId: 'run-x',
    available: true,
    revision: 1,
  };
  chat.inTurnRuns[CHAT] = run;
  chat.inTurnProtocol = 1;

  const posts = [];

  apiHarness.post = async (path, body) => {
    posts.push({ path, body });

    if (path === '/api/chat/in-turn') {
      return {
        chatKey: CHAT,
        runId: 'run-x',
        messageId: body.messageId,
        sequence: 1,
        revision: 1,
        state: 'forwarded',
        text: body.text,
        acceptedAt: 1,
        updatedAt: 1,
      };
    }

    return { ok: true, commentDelivered: false };
  };

  let queued = null;

  chat.send = async (id, text) => {
    queued = [id, text];

    return true;
  };

  await chat.answerPerm('perm-1', false, false, 'Без тега');

  assert.equal(queued, null, 'очередь не нужна: агент ещё в ходе и получит пояснение сразу');

  const inTurn = posts.find((p) => p.path === '/api/chat/in-turn');

  assert.ok(inTurn, 'реплика ушла в активный ход');
  assert.equal(inTurn.body.text, 'Пояснение к отказу (Bash): Без тега');
  assert.equal(inTurn.body.targetRunId, 'run-x');
});

test('неготовый in-turn канал оставляет прежний путь: пояснение встаёт в очередь чата', async () => {
  const { chat } = await fixture();

  chat.pending['perm-2'] = {
    pid: 'perm-2',
    kind: 'perm',
    chatKey: CHAT,
    tool: 'Bash',
  };

  apiHarness.post = async () => ({ ok: true, commentDelivered: false });

  let queued = null;

  chat.send = async (id, text) => {
    queued = [id, text];

    return true;
  };

  await chat.answerPerm('perm-2', false, false, 'evildev@yandex.ru');

  assert.deepEqual(queued, [CHAT, 'evildev@yandex.ru'], 'фолбэк повторяет прежнее поведение');
});
