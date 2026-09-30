import assert from 'node:assert/strict';
import test from 'node:test';

import { apiHarness, chatStoreFixture, sseOf } from './helpers/chat-store.js';

const CHAT = 'runtime-chat';
const snapshot = (runId) => ({
  chatKey: CHAT,
  runId,
  providerId: 'test-provider',
  requestedModelId: `model-${runId}`,
  cwd: `/synthetic/${runId}`,
  extraDirs: [],
});
const start = (runId, extra = {}) => ({
  chatKey: CHAT,
  runId,
  snapshot: snapshot(runId),
  ...extra,
});
const emptyPage = {
  entries: [],
  throughSequence: 0,
  nextAfterSequence: null,
};

/**
 * Настоящие обработчики стора работают с управляемым офлайн-транспортом.
 * Пустая история уточнений не создаёт посторонних сохранений и запросов к исполнителю.
 */
async function fixture() {
  const chat = await chatStoreFixture({ sessions: [{
    id: CHAT,
    model: 'next-model',
    messages: [],
    steps: [],
  }] });

  apiHarness.get = async () => emptyPage;

  return {
    chat,
    sse: sseOf(chat),
    session: chat.sessions[0],
  };
}

test('F5 восстанавливает snapshot и длительность по elapsedMs, без зависимости от часов сервера', async () => {
  const { chat, session } = await fixture();

  apiHarness.get = async (url) => url === '/api/chat/active'
    ? { active: [{
      ...start('run-a'),
      elapsedMs: 90_000,
      startedAt: 1,
      tokens: 42,
    }], protocol: 1 }
    : emptyPage;

  await chat._loadActive();
  assert.deepEqual({ ...chat.runtimeFor(CHAT).snapshot }, snapshot('run-a'));
  assert.equal(chat.runtimeFor(CHAT).active, true);
  assert.equal(session.progressTokens, 42);
  assert.ok(Math.abs(Date.now() - session.turnStartedAt - 90_000) < 1000);
});

test('GET active A не откатывает старт B, завершение A и более свежий факт модели', async () => {
  for (const event of ['start-b', 'done-a', 'metadata']) {
    const { chat, sse } = await fixture();

    sse('chat-turn-start', start('run-a'));
    let release;

    apiHarness.get = (url) => url === '/api/chat/active'
      ? new Promise((resolve) => {
        release = resolve;
      })
      : Promise.resolve(emptyPage);

    const active = chat._loadActive();

    if (event === 'start-b') {
      sse('chat-turn-start', start('run-b'));
    } else if (event === 'done-a') {
      sse('chat-done', { chatKey: CHAT, runId: 'run-a' });
    } else {
      sse('chat-run-metadata', { ...start('run-a'), snapshot: {
        ...snapshot('run-a'),
        actualModelId: 'confirmed',
        modelSource: 'response',
      } });
    }

    release({ active: [start('run-a')], protocol: 1 });
    await active;

    const current = chat.runtimeFor(CHAT);

    if (event === 'start-b') {
      assert.equal(current.runId, 'run-b');
    } else if (event === 'done-a') {
      assert.equal(current.active, false);
    } else {
      assert.equal(current.snapshot.actualModelId, 'confirmed');
    }
  }
});

test('поколение запроса active защищает два HTTP-ответа без промежуточного SSE', async () => {
  const { chat } = await fixture();
  const releases = [];

  apiHarness.get = (url) => url === '/api/chat/active'
    ? new Promise((resolve) => releases.push(resolve)) : Promise.resolve(emptyPage);

  const older = chat._loadActive();
  const newer = chat._loadActive();

  releases[1]({ active: [start('run-b')] });
  await newer;
  releases[0]({ active: [start('run-a')] });
  await older;
  assert.equal(chat.runtimeFor(CHAT).runId, 'run-b');
});

test('late done, progress и metadata A не меняют работающий B', async () => {
  const { chat, sse, session } = await fixture();

  sse('chat-turn-start', start('run-a'));
  sse('chat-done', {
    chatKey: CHAT,
    runId: 'run-a',
    queued: 1,
  });
  sse('chat-turn-start', start('run-b'));
  sse('chat-progress', {
    chatKey: CHAT,
    runId: 'run-b',
    tokens: 12,
  });
  sse('chat-progress', {
    chatKey: CHAT,
    runId: 'run-a',
    tokens: 999,
  });
  sse('chat-run-metadata', { ...start('run-a'), snapshot: {
    ...snapshot('run-a'),
    actualModelId: 'wrong-model',
    modelSource: 'response',
  } });
  sse('chat-done', { chatKey: CHAT, runId: 'run-a' });

  assert.equal(chat.runtimeFor(CHAT).runId, 'run-b');
  assert.equal(chat.runtimeFor(CHAT).active, true);
  assert.equal(chat.inTurnFor(CHAT).active, true);
  assert.equal(session.sending, true);
  assert.equal(session.progressTokens, 12);
});

test('finally pending A повторно сверяет run после асинхронного получения ответа', async () => {
  const { chat, sse, session } = await fixture();
  let release;

  apiHarness.get = (url) => url === '/api/chat/pending'
    ? new Promise((resolve) => {
      release = resolve;
    }) : Promise.resolve(emptyPage);

  sse('chat-turn-start', start('run-a', { turnId: 'turn-a' }));
  sse('chat-done', {
    chatKey: CHAT,
    runId: 'run-a',
    turnId: 'turn-a',
  });
  sse('chat-turn-start', start('run-b', { turnId: 'turn-b' }));
  release({ pending: [] });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });

  assert.equal(chat.runtimeFor(CHAT).active, true);
  assert.equal(chat.runtimeFor(CHAT).runId, 'run-b');
  assert.equal(session.sending, true);
  assert.equal(chat.inTurnFor(CHAT).runId, 'run-b');
});

test('старый итог попадает в историю без подмены нового контекста и канала уточнений', async () => {
  const { chat, sse, session } = await fixture();

  sse('chat-turn-start', start('run-b'));
  session.sessionId = 'session-b';
  await chat._reconcileInTurn(CHAT, 'run-a');
  chat._applyPending(session, {
    id: 'pending-a',
    chatKey: CHAT,
    runId: 'run-a',
    reply: 'Итог A',
    sessionId: 'session-a',
  });

  assert.equal(session.messages.at(-1).text, 'Итог A');
  assert.equal(session.sessionId, 'session-b');
  assert.equal(session.sending, true);
  assert.equal(chat.inTurnFor(CHAT).runId, 'run-b');
});

test('метаданные не сохраняют durable историю, compact и фон получают отдельные признаки', async () => {
  const { chat, sse, session } = await fixture();
  let saves = 0;

  chat._persist = () => {
    saves += 1;
  };
  sse('chat-turn-start', start('run-a'));
  sse('chat-run-metadata', { ...start('run-a'), snapshot: {
    ...snapshot('run-a'),
    actualModelId: 'actual',
    modelSource: 'session',
  } });
  sse('chat-progress', {
    chatKey: CHAT,
    runId: 'run-a',
    tokens: 123,
  });
  assert.equal(saves, 0);
  assert.equal(session.snapshot, undefined);

  sse('chat-done', { chatKey: CHAT, runId: 'run-a' });
  sse('chat-progress', { chatKey: CHAT, tokens: 2 });
  assert.equal(chat.runtimeFor(CHAT).source, 'background');
  assert.equal(chat.runtimeFor(CHAT).snapshot, null);
  sse('chat-turn-start', start('run-compact', { compact: true }));
  assert.equal(chat.runtimeFor(CHAT).compact, true);
  assert.equal(session.compacting, true);
  assert.equal(session.sending, false);
});
