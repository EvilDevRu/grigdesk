import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileWith } from './helpers/chat-protocol.js';

import { apiHarness, chatStoreFixture, sseOf } from './helpers/chat-store.js';
import { chatStatus } from '../../web/src/views/chat/chatStatus.ts';
import { chatTimeline } from '../../web/src/views/chat/chatTimeline.ts';
import { inTurnComposerState } from '../../web/src/views/chat/chatInTurn.ts';

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
  apiHarness.post = reconcileWith(apiHarness.post, apiHarness.get);

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



const SELECTION = {
  providerId: 'next-provider',
  modelId: 'next-model',
  modelLabel: 'Следующая',
};
const LIVE_PHASES = ['running', 'legacy', 'background'];

/**
 * Свежий стор и журнал GET: тесты считают запросы канала уточнений по URL.
 * Сценарий может заменить messages/steps до первого события.
 */
async function backgroundFixture({ messages = [], steps = [] } = {}) {
  const chat = await chatStoreFixture({ sessions: [{
    id: CHAT,
    model: 'next-model',
    messages,
    steps,
  }] });
  const gets = [];

  apiHarness.get = async (url) => {
    gets.push(url);

    return url === '/api/chat/active' ? { active: [], protocol: 1 } : emptyPage;
  };

  return {
    chat,
    sse: sseOf(chat),
    session: chat.sessions[0],
    gets,
  };
}

/** Видимое окном состояние: фаза строки хода и наличие живого хвоста ленты. */
/**
 * Соединяет статус запуска с видимой проекцией ленты для проверки стора.
 * Считается живой хвост именно активного runtime, отдельно от канала уточнений.
 */
function view(chat, session) {
  const runtime = chat.runtimeFor(CHAT);
  const phase = chatStatus(session, runtime, SELECTION).phase;
  const rows = chatTimeline(session.messages, session.steps, LIVE_PHASES.includes(phase),
    chat.inTurnFor(CHAT), runtime?.active ? runtime.runId : '');

  return {
    phase,
    thinking: rows.filter((row) => row.thinking).length,
  };
}

/** Управляемая подмена прохода pending: тест сам решает, когда он закончился. */
function holdCollect(chat) {
  const held = { calls: 0, release: null };

  chat._collectPending = () => {
    held.calls += 1;

    return new Promise((resolve) => {
      held.release = resolve;
    });
  };

  return held;
}

const settle = () => new Promise((resolve) => {
  setImmediate(resolve);
});

test('фоновый запуск из SSE получает снимок, чистит ленту и не трогает очередь', async () => {
  const { chat, sse, session, gets } = await backgroundFixture({
    messages: [{
      role: 'user',
      text: 'жду',
      turnId: 'turn-q',
      queued: true,
    }],
    steps: [{ k: 'start', at: 1 }],
  });

  sse('chat-turn-start', start('run-bg', { source: 'background' }));
  await settle();

  assert.equal(chat.runtimeFor(CHAT).source, 'background');
  assert.deepEqual({ ...chat.runtimeFor(CHAT).snapshot }, snapshot('run-bg'));
  assert.equal(session.steps.length, 0);
  assert.equal(session.sending, true);
  assert.equal(session.messages[0].queued, true);
  assert.equal(chat.inTurnFor(CHAT)?.active ?? false, false);
  assert.equal(gets.filter((url) => url.startsWith('/api/chat/in-turn')).length, 0);
  assert.equal(view(chat, session).phase, 'running');
});

test('фоновый chat-done гасит ход только после разбора pending', async () => {
  const { chat, sse, session } = await backgroundFixture();

  sse('chat-turn-start', start('run-bg', { source: 'background' }));

  const held = holdCollect(chat);

  sse('chat-done', {
    chatKey: CHAT,
    runId: 'run-bg',
    source: 'background',
    queued: 0,
  });
  assert.equal(held.calls, 1);
  assert.equal(session.sending, true);
  assert.equal(chat.runtimeFor(CHAT).active, true);
  assert.deepEqual(view(chat, session), { phase: 'running', thinking: 1 });

  await chat._loadActive();
  assert.equal(chat.runtimeFor(CHAT).active, true, 'сверка с пустым active не гасит завершение');
  assert.equal(session.sending, true);

  sse('chat-done', {
    chatKey: CHAT,
    runId: 'run-bg',
    source: 'background',
    queued: 0,
  });
  assert.equal(held.calls, 1, 'повторный done не запускает второе завершение');

  held.release();
  await settle();
  assert.equal(chat.runtimeFor(CHAT).active, false);
  assert.equal(session.sending, false);
  assert.deepEqual(view(chat, session), { phase: 'idle', thinking: 0 });
});

test('F5 восстанавливает фоновый запуск без канала уточнений', async () => {
  const { chat, session, gets } = await backgroundFixture();

  apiHarness.get = async (url) => {
    gets.push(url);

    return url === '/api/chat/active'
      ? { active: [{
        ...start('run-bg'),
        source: 'background',
        elapsedMs: 1000,
        tokens: 5,
      }], protocol: 1 }
      : emptyPage;
  };
  await chat._loadActive();

  assert.equal(chat.runtimeFor(CHAT).source, 'background');
  assert.equal(chat.runtimeFor(CHAT).active, true);
  assert.equal(chat.runtimeFor(CHAT).snapshot.runId, 'run-bg');
  assert.equal(session.sending, true);
  assert.equal(session.progressTokens, 5);
  assert.equal(gets.filter((url) => url.startsWith('/api/chat/in-turn')).length, 0);
});

test('сверка active со сменой run заменяет ленту даже пустой', async () => {
  const { chat, sse, session } = await backgroundFixture();

  sse('chat-turn-start', start('run-a'));
  sse('chat-step', {
    chatKey: CHAT,
    runId: 'run-a',
    step: { k: 'tool', at: 5 },
  });
  sse('chat-step', {
    chatKey: CHAT,
    runId: 'run-a',
    step: { k: 'tool', at: 6 },
  });

  apiHarness.get = async (url) => url === '/api/chat/active'
    ? { active: [{
      ...start('run-b'),
      source: 'background',
      steps: [],
      elapsedMs: 10,
    }], protocol: 1 }
    : emptyPage;
  await chat._loadActive();
  assert.equal(chat.runtimeFor(CHAT).runId, 'run-b');
  assert.equal(session.steps.length, 0);

  apiHarness.get = async (url) => url === '/api/chat/active'
    ? { active: [{
      ...start('run-b'),
      source: 'background',
      steps: [{ k: 'tool', at: 1 }],
    }], protocol: 1 }
    : emptyPage;
  sse('chat-step', {
    chatKey: CHAT,
    runId: 'run-b',
    step: { k: 'tool', at: 7 },
  });
  sse('chat-step', {
    chatKey: CHAT,
    runId: 'run-b',
    step: { k: 'tool', at: 8 },
  });
  await chat._loadActive();
  assert.deepEqual(session.steps.map((step) => step.at), [7, 8], 'тот же run: старый снимок не откатывает');
});

test('завершение фонового A не гасит следующий запуск', async () => {
  for (const next of ['managed', 'background']) {
    const { chat, sse, session } = await backgroundFixture();

    sse('chat-turn-start', start('run-a', { source: 'background' }));

    const held = holdCollect(chat);

    sse('chat-done', {
      chatKey: CHAT,
      runId: 'run-a',
      source: 'background',
    });
    assert.equal(held.calls, 1, `${next}: фоновый done ждёт разбора pending`);

    const nextSource = next === 'background' ? { source: 'background' } : { turnId: 'turn-b' };

    sse('chat-turn-start', start('run-b', nextSource));
    sse('chat-step', {
      chatKey: CHAT,
      runId: 'run-b',
      step: { k: 'tool', at: 3 },
    });
    held.release();
    await settle();
    sse('chat-done', {
      chatKey: CHAT,
      runId: 'run-a',
      source: 'background',
    });
    sse('chat-progress', {
      chatKey: CHAT,
      runId: 'run-a',
      tokens: 999,
    });
    sse('chat-step', {
      chatKey: CHAT,
      runId: 'run-a',
      step: { k: 'tool', at: 4 },
    });

    assert.equal(chat.runtimeFor(CHAT).runId, 'run-b', next);
    assert.equal(chat.runtimeFor(CHAT).active, true, next);
    assert.equal(session.sending, true, next);
    assert.deepEqual(session.steps.map((step) => step.at), [3], next);
    assert.notEqual(session.progressTokens, 999, next);
  }
});

test('фоновый pending до done: итог и контекст применены, ход не погашен, канал не открыт', async () => {
  const { chat, sse, session, gets } = await backgroundFixture();
  const deletes = [];
  const pending = {
    id: 'o-bg',
    chatKey: CHAT,
    runId: 'run-bg',
    source: 'background',
    unsolicited: true,
    role: 'assistant',
    reply: 'Итог фона',
    sessionId: 'session-bg',
    contextTokens: 777,
    effort: 'high',
    at: 5,
  };

  apiHarness.get = async (url) => {
    gets.push(url);

    return url === '/api/chat/pending' ? { pending: [pending] } : emptyPage;
  };
  apiHarness.post = reconcileWith(apiHarness.post, apiHarness.get);
  apiHarness.put = async () => ({
    ok: true,
    written: true,
    revision: 1,
  });
  apiHarness.del = async (url) => {
    deletes.push(url);

    return { ok: true };
  };
  sse('chat-turn-start', start('run-bg', { source: 'background' }));
  await chat._collectPending();
  await chat._collectPending();

  assert.equal(session.messages.filter((message) => message.pid === 'o-bg').length, 1);
  assert.equal(session.messages.at(-1).runId, 'run-bg');
  assert.equal(session.sessionId, 'session-bg');
  assert.equal(session.contextTokens, 777);
  assert.equal(session.effort || '', '');
  assert.equal(session.messages.find((message) => message.pid === 'o-bg').effort, 'high');
  assert.equal(session.sending, true);
  assert.equal(chat.runtimeFor(CHAT).active, true);
  assert.equal(gets.filter((url) => url.startsWith('/api/chat/in-turn')).length, 0);
  assert.ok(deletes.includes('/api/chat/pending/o-bg'));

  sse('chat-turn-start', start('run-next', { source: 'background' }));
  session.sessionId = 'session-next';
  chat._applyPending(session, {
    ...pending,
    id: 'o-bg-late',
    reply: 'Поздний',
    sessionId: 'session-old',
  });
  assert.equal(session.messages.at(-1).text, 'Поздний');
  assert.equal(session.sessionId, 'session-next');
  assert.equal(chat.runtimeFor(CHAT).runId, 'run-next');
});

test('фон поверх живого канала уточнений закрывает его для композера', async () => {
  const { chat, sse } = await backgroundFixture();
  const posts = [];

  chat.inTurnProtocol = 1;
  apiHarness.post = async (url) => {
    posts.push(url);

    return {};
  };
  sse('chat-turn-start', start('run-a', { inTurn: {
    runId: 'run-a',
    available: true,
    revision: 1,
    entries: [],
    throughSequence: 0,
    nextAfterSequence: null,
  } }));
  assert.equal(chat.inTurnFor(CHAT).availability?.available, true, 'канал A готов до фона');
  sse('chat-turn-start', start('run-bg', { source: 'background' }));

  const run = chat.inTurnFor(CHAT);
  const state = inTurnComposerState({
    run,
    protocol: 1,
    capability: { protocol: 1, text: true },
    pendingCount: 0,
    text: 'уточнение',
  });

  assert.equal(run?.runId ?? 'run-a', 'run-a');
  assert.equal(state.active, false);
  assert.equal(await chat.sendInTurn(CHAT, 'уточнение'), false);
  assert.equal(posts.filter((url) => url === '/api/chat/in-turn').length, 0);
});

test('active-снимок фона и SSE дают одинаковые метрики; без снимка — честный фон', async () => {
  const metrics = {
    tokens: 40,
    tokensIsEstimate: false,
    contextTokens: 1234,
    contextWindow: 200000,
    contextCache: {
      scope: 'request',
      status: 'reported',
      readTokens: 10,
      uncachedTokens: 2,
    },
  };
  const restored = await backgroundFixture();

  apiHarness.get = async (url) => url === '/api/chat/active'
    ? { active: [{
      ...start('run-bg'),
      source: 'background',
      elapsedMs: 5,
      ...metrics,
    }], protocol: 1 }
    : emptyPage;
  await restored.chat._loadActive();

  const live = await backgroundFixture();

  live.sse('chat-turn-start', start('run-bg', { source: 'background' }));
  live.sse('chat-progress', {
    chatKey: CHAT,
    runId: 'run-bg',
    ...metrics,
  });

  for (const key of ['progressTokens', 'progressTokensEstimate', 'liveContext']) {
    assert.equal(restored.session[key], live.session[key], key);
  }

  assert.deepEqual({ ...restored.session.liveContextCache }, { ...live.session.liveContextCache });

  const unknown = await backgroundFixture();

  unknown.sse('chat-turn-start', {
    chatKey: CHAT,
    runId: 'run-bg',
    source: 'background',
    snapshot: null,
  });
  assert.equal(view(unknown.chat, unknown.session).phase, 'background');
  assert.equal(chatStatus(unknown.session, unknown.chat.runtimeFor(CHAT), SELECTION).modelLabel,
    'Модель текущего хода неизвестна');
});

test('восстановленный фон после конца управляемого хода продолжает таймер и ленту', async () => {
  const { chat, sse, session, gets } = await backgroundFixture();

  sse('chat-turn-start', start('run-m'));
  sse('chat-done', { chatKey: CHAT, runId: 'run-m' });
  sse('chat-turn-start', start('run-bg', {
    source: 'background',
    restored: true,
    elapsedMs: 90_000,
    steps: [{
      k: 'tool',
      at: 5,
      title: 'Фон',
    }],
    tokens: 42,
    tokensIsEstimate: true,
  }));
  sse('chat-done', { chatKey: CHAT, runId: 'run-m' });
  sse('chat-progress', {
    chatKey: CHAT,
    runId: 'run-m',
    tokens: 999,
  });
  await settle();

  assert.equal(chat.runtimeFor(CHAT).runId, 'run-bg');
  assert.equal(chat.runtimeFor(CHAT).active, true);
  assert.deepEqual(session.steps.map((step) => step.title), ['Фон']);
  assert.equal(session.progressTokens, 42);
  assert.equal(session.progressTokensEstimate, true);
  assert.ok(Math.abs(Date.now() - session.turnStartedAt - 90_000) < 1000);
  assert.equal(gets.filter((url) => url.includes('runId=run-bg')).length, 0);
});

test('фон, раскрытый после остановленного хода, начинается со свободной кнопкой стопа', async () => {
  const { chat, sse, session } = await backgroundFixture();

  sse('chat-turn-start', start('run-m', { turnId: 'turn-m' }));
  session.stopping = true;

  const held = holdCollect(chat);

  sse('chat-done', {
    chatKey: CHAT,
    runId: 'run-m',
    turnId: 'turn-m',
    queued: 0,
  });
  sse('chat-turn-start', start('run-bg', {
    source: 'background',
    restored: true,
    elapsedMs: 1000,
    steps: [],
  }));
  assert.equal(session.stopping, false);

  held.release();
  await settle();
  assert.equal(chat.runtimeFor(CHAT).runId, 'run-bg');
  assert.equal(chat.runtimeFor(CHAT).active, true, 'завершение прошлого хода не гасит фон');
  assert.equal(session.sending, true);
  assert.equal(session.stopping, false);
});
