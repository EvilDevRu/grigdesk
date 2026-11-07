// Историю читают все устройства сразу, а узнать об изменении им было неоткуда: чат,
// начатый на планшете, появлялся на компьютере только после F5. Теперь пишущее окно
// помечает запрос своим origin, сервер шлёт SSE `chat-store`, остальные тянут ровно
// изменившуюся шапку, а для уже открытого чата — полную ленту.
import assert from 'node:assert/strict';
import test from 'node:test';

import { protocolHead, protocolList, reconcileWith } from './helpers/chat-protocol.js';

import {
  apiHarness,
  chatNotifications,
  chatStoreFixture,
  setChatVisible,
  sseOf,
} from './helpers/chat-store.js';

const CHAT = {
  id: 'c1', taskId: null, title: 'Чат', messages: [{ role: 'user', text: 'Привет' }],
  sessionId: 'sess-1', contextTokens: 1000, draft: '', createdAt: 100, updatedAt: 200,
};

function fixture(extra = {}) {
  return chatStoreFixture({ sessions: [{ ...CHAT, sending: false, compacting: false, steps: [], ...extra }] });
}

// Ответ сервера на точечное чтение чата.
function serveChat(chat) {
  apiHarness.get = async (url) => {
    if (url === '/api/chat/active') return { active: [] };
    if (url === `/api/chat/store/head/${chat.id}`) {
      return { head: protocolHead(chat) };
    }

    assert.equal(url, `/api/chat/store/chat/${chat.id}`);

    return { chat, version: protocolHead(chat).version };
  };
}

test('COMP-VIS-04: markRead и notifications используют exact registered surface', async () => {
  const chat = await fixture({ unread: true });

  chat.markRead('c1');
  assert.equal(chat.sessions[0].unread, true, 'смонтированный, но скрытый чат не прочитан');

  setChatVisible('other');
  chat.markRead('c1');
  assert.equal(chat.sessions[0].unread, true, 'видимость другого id не подходит');

  setChatVisible('c1');
  chat.markRead('c1');
  assert.equal(chat.sessions[0].unread, false);
});

test('WEB-00: старые миллионы Codex не заполняют кольцо после миграции метрики', async () => {
  const chat = await fixture({
    model: 'gpt-5.6-sol',
    modelRef: { provider: 'codex', model: 'gpt-5.6-sol' },
    contextTokens: 240_000,
    contextMetric: '',
    contextCache: { scope: 'request', status: 'reported', readTokens: -1, uncachedTokens: '240000' },
  });
  const session = chat.sessions[0];
  chat._normalize(chat.sessions);

  assert.equal(session.contextTokens, 0);
  assert.equal(session.contextWindow, 0);
  assert.equal(session.contextMetric, 'legacy-unavailable');
  assert.equal(session.contextIsEstimate, true);
  assert.equal(session.totalInputTokens, 240_000, 'старое значение остаётся только расходом');
  assert.deepEqual(session.contextCache, { scope: 'request', status: 'unavailable' },
    'reported без единой валидной числовой метрики не изображает измерение');
});

test('WEB-01: чат, начатый на другом устройстве, появляется без перезагрузки', async () => {
  const chat = await fixture();
  const sse = sseOf(chat);
  serveChat({ id: 'c2', title: 'С планшета', messages: [], createdAt: 50, updatedAt: 60 });

  sse('chat-store', { id: 'c2', archived: false, origin: 'другое-окно', at: 1 });
  await new Promise(setImmediate);

  assert.deepEqual(chat.sessions.map((s) => s.id), ['c2', 'c1'], 'порядок — по времени создания');
  assert.equal(chat.sessions[0].title, 'С планшета');
  assert.equal(chat.activeId, 'c1', 'чужой чат не перехватывает активную вкладку');
});

test('WEB-02: своё эхо игнорируется — origin окна не перечитывает сам себя', async () => {
  const chat = await fixture();
  const sse = sseOf(chat);
  let asked = false;
  apiHarness.get = async () => { asked = true; return { chat: CHAT }; };

  // origin своего окна тест не знает — берём его из запроса, который делает сам стор.
  let origin = '';
  apiHarness.put = async (_url, body) => { origin = body.origin; return { ok: true }; };
  chat.setTitle('c1', 'Переименовал');
  chat._persist(true);
  await new Promise(setImmediate);
  assert.ok(origin, 'запись помечена id окна');

  sse('chat-store', { id: 'c1', archived: false, origin, at: 2 });
  await new Promise(setImmediate);
  assert.equal(asked, false, 'своё изменение перечитывать нечего');
  assert.equal(chat.sessions[0].title, 'Переименовал');
});

test('WEB-03: чужая копия не затирает несохранённое своё', async () => {
  const chat = await fixture();
  const sse = sseOf(chat);
  serveChat({ ...CHAT, draft: 'чужой черновик' });

  chat.sessions[0].draft = 'мой недописанный текст'; // ещё не уехал на сервер
  sse('chat-store', { id: 'c1', archived: false, origin: 'другое-окно', at: 3 });
  await new Promise(setImmediate);

  assert.equal(chat.sessions[0].draft, 'мой недописанный текст');
});

test('WEB-04: принятая копия не гасит идущий ход и не подменяет объект чата', async () => {
  const chat = await fixture({ sending: true, steps: [{ kind: 'tool' }], progressTokens: 7 });
  const sse = sseOf(chat);
  const live = chat.sessions[0];
  serveChat({ ...CHAT, messages: [...CHAT.messages, { role: 'assistant', text: 'Ответ' }] });

  sse('chat-store', { id: 'c1', archived: false, origin: 'другое-окно', at: 4 });
  await new Promise(setImmediate);

  assert.equal(chat.sessions[0], live, 'объект обновляется на месте — на него держит ссылку send()');
  assert.equal(live.messages.length, 2, 'переписка подтянулась');
  assert.equal(live.sending, true, '«думает…» пережило чужую правку');
  assert.equal(live.progressTokens, 7);
  assert.deepEqual(live.steps, [{ kind: 'tool' }]);
});

test('WEB-05: чат, закрытый на другом устройстве, переезжает в архив', async () => {
  const chat = await fixture();
  const sse = sseOf(chat);
  const live = chat.sessions[0];
  serveChat({ ...CHAT, archived: true, closedAt: 300 });

  sse('chat-store', { id: 'c1', archived: true, origin: 'другое-окно', at: 5 });
  await new Promise(setImmediate);

  assert.equal(chat.sessions.length, 0);
  assert.deepEqual(chat.archived.map((c) => c.id), ['c1']);
  assert.equal(chat.archived[0], live, 'тот же объект, а не копия');
  assert.equal(chat.archived[0].archived, undefined, 'архивность — это список, а не поле чата');
});

test('WEB-06: удалённый на другом устройстве чат уходит и здесь', async () => {
  const chat = await fixture();
  const sse = sseOf(chat);

  sse('chat-store', { id: 'c1', gone: true, origin: 'другое-окно', at: 6 });
  assert.equal(chat.sessions.length, 0);
  assert.equal(chat.activeId, null, 'активной вкладкой не остаётся стёртый чат');
});

test('WEB-07: чужая мета меняет дефолты новых чатов, но не активную вкладку', async () => {
  const chat = await fixture();
  const sse = sseOf(chat);
  chat.defModel = 'claude-opus-5';

  sse('chat-store-meta', {
    meta: { activeId: 'c9', defModel: 'gpt-5.6-terra', defEffort: 'high', defMode: 'plan' },
    origin: 'другое-окно',
    at: 7,
  });

  assert.equal(chat.defModel, 'gpt-5.6-terra');
  assert.equal(chat.defEffort, 'high');
  assert.equal(chat.defMode, 'plan');
  assert.equal(chat.activeId, 'c1', 'разговор из-под рук не забираем');
});

test('WEB-08: после разрыва связи история сверяется по известным версиям', async () => {
  const chat = await fixture();
  const sse = sseOf(chat);
  const asked = [];
  const changed = { ...CHAT, title: 'Переименован там' };

  serveChat(changed);
  apiHarness.post = async (url, body) => {
    asked.push({ url, body });

    if (url === '/api/chat/store/reconcile') {
      return {
        pending: [],
        heads: [],
        gone: [],
        deliveries: [],
      };
    }

    assert.equal(url, '/api/chat/store/changes');

    return {
      ...protocolList({
        sessions: [changed, { id: 'c2', title: 'С планшета', messages: [], createdAt: 500 }],
        archived: [],
      }),
      gone: ['c0'],
    };
  };

  const removed = { id: 'c0', title: 'Стёртый', messages: [], createdAt: 10, steps: [] };

  chat.sessions.push(removed);
  chat._markSent();
  chat._applyChatHead(protocolHead(removed), false);
  sse('hello', {});
  await new Promise(setImmediate);
  await new Promise(setImmediate);

  const changes = asked.filter((call) => call.url === '/api/chat/store/changes');

  assert.equal(changes.length, 1, 'одна сверка на переподключение');
  assert.deepEqual(changes[0].body.known, {
    c1: protocolHead({
      ...CHAT,
      sending: false,
      compacting: false,
      steps: [],
      archived: false,
    }).version,
    c0: protocolHead(removed).version,
  });
  assert.deepEqual(chat.sessions.map((s) => s.id), ['c1', 'c2']);
  assert.equal(chat.sessions[0].title, 'Переименован там');
});

test('WEB-09: сверка не трогает свой новый чат и не тянет историю сразу после загрузки', async () => {
  const chat = await fixture();
  const sse = sseOf(chat);
  let pulls = 0;

  serveChat(CHAT);

  const get = apiHarness.get;

  apiHarness.get = async (url) => {
    if (url === '/api/chat/active') return { active: [] };
    if (url.includes('/waiting')) {
      return { waiting: [] };
    }

    return get(url);
  };

  apiHarness.post = async (url) => {
    if (url === '/api/chat/store/changes') {
      pulls += 1;

      return { ...protocolList({ sessions: [CHAT], archived: [] }), gone: [] };
    }

    return {
        pending: [],
        heads: [],
        gone: [],
        deliveries: [],
      };
  };

  chat.sessions.push({ id: 'c3', title: 'Только что завёл', messages: [], createdAt: 900, steps: [] });
  sse('hello', {});
  await new Promise(setImmediate);
  await new Promise(setImmediate);

  assert.equal(pulls, 1);
  assert.ok(chat.sessions.some((s) => s.id === 'c3'), 'ещё не уехавший чат не стираем');

  // Сверка только что прошла — следующее `hello` не тянет историю по второму разу
  // (ровно так и выглядит первое событие после загрузки страницы).
  sse('hello', {});
  await new Promise(setImmediate);
  assert.equal(pulls, 1, 'свежую сверку событие не повторяет');
});

test('WEB-10: ход в ещё неизвестном чате тянет и сам чат, и его живое состояние', async () => {
  const chat = await fixture();
  const sse = sseOf(chat);
  const asked = [];
  apiHarness.get = async (url) => {
    asked.push(url);
    if (url === '/api/chat/active') {
      return { active: [{ chatKey: 'c2', startedAt: 1, tokens: 12, steps: [], compact: false }] };
    }

    return { head: protocolHead({
      id: 'c2',
      title: 'С планшета',
      messages: [],
      createdAt: 500,
      updatedAt: 500,
    }) };
  };

  sse('chat-turn-start', { chatKey: 'c2', at: 8 });
  await new Promise(setImmediate);
  await new Promise(setImmediate);

  assert.deepEqual(asked, ['/api/chat/store/head/c2', '/api/chat/active']);
  const added = chat.sessions.find((s) => s.id === 'c2');
  assert.ok(added, 'чат подтянулся по событию хода');
  assert.equal(added.sending, true, 'и сразу с «думает…» — событие о старте мы уже пропустили');
  assert.equal(added.progressTokens, 12);
});

test('WEB-11: ответ, пришедший синхронизацией в фоновую PWA, показывает одно оповещение', async () => {
  const chat = await fixture();
  chat._visible = () => false;
  const sse = sseOf(chat);
  serveChat({
    ...CHAT,
    messages: [
      ...CHAT.messages,
      { role: 'assistant', text: 'Готово на другом устройстве' },
    ],
    updatedAt: 300,
  });

  sse('chat-store', { id: 'c1', archived: false, origin: 'другое-окно', at: 10 });
  await new Promise(setImmediate);

  assert.equal(chatNotifications().length, 1);
  assert.match(chatNotifications()[0][0], /Агент ответил/);
  assert.equal(chatNotifications()[0][1], 'Готово на другом устройстве');
  assert.equal(chat.sessions[0].unread, true);

  // Повторное SSE того же состояния не должно звонить снова.
  sse('chat-store', { id: 'c1', archived: false, origin: 'другое-окно', at: 11 });
  await new Promise(setImmediate);
  assert.equal(chatNotifications().length, 1);
});

test('WEB-11b: промежуточная реплика идущего хода не помечает чат непрочитанным, итог хода — помечает',
  async () => {
    const chat = await fixture();
    const block = {
      role: 'assistant',
      kind: 'assistant-block',
      runId: 'run-1',
      assistantMessageId: 'block-0001',
      text: 'Смотрю файлы этапа.',
      complete: true,
    };

    chat._visible = () => false;

    const sse = sseOf(chat);

    serveChat({
      ...CHAT,
      messages: [...CHAT.messages, block],
      updatedAt: 300,
    });
    sse('chat-store', {
      id: 'c1',
      archived: false,
      origin: 'сервер',
      at: 10,
    });
    await new Promise(setImmediate);

    assert.equal(chatNotifications().length, 0, 'промежуточная реплика — не ответ');
    assert.equal(Boolean(chat.sessions[0].unread), false);

    serveChat({
      ...CHAT,
      messages: [...CHAT.messages, block, {
        role: 'assistant',
        runId: 'run-1',
        text: 'Этап готов.',
        steps: [],
      }],
      updatedAt: 400,
    });
    sse('chat-store', {
      id: 'c1',
      archived: false,
      origin: 'сервер',
      at: 11,
    });
    await new Promise(setImmediate);

    assert.equal(chatNotifications().length, 1);
    assert.equal(chatNotifications()[0][1], 'Этап готов.');
    assert.equal(chat.sessions[0].unread, true);
  });

test('WEB-12: ответ из pending после обрыва фонового запроса тоже показывает оповещение', async () => {
  const chat = await fixture({ sending: true, offline: true });
  chat._visible = () => false;
  apiHarness.get = async (url) => {
    assert.equal(url, '/api/chat/pending');
    return {
      pending: [{
        id: 'orphan-1', chatKey: 'c1', role: 'assistant', reply: 'Дошло после сна',
        userText: 'Вопрос, потерянный окном', userSentAt: 250, at: 400,
      }],
    };
  };
  apiHarness.post = reconcileWith(apiHarness.post, apiHarness.get);

  await chat._collectPending();

  assert.equal(chatNotifications().length, 1);
  assert.equal(chatNotifications()[0][1], 'Дошло после сна');
  assert.equal(chat.sessions[0].unread, true);
  assert.equal(chat.sessions[0].offline, false);
  assert.deepEqual(chat.sessions[0].messages.slice(-2).map((message) => ({
    role: message.role, text: message.text, sentAt: message.sentAt,
  })), [
    { role: 'user', text: 'Вопрос, потерянный окном', sentAt: 250 },
    { role: 'assistant', text: 'Дошло после сна', sentAt: undefined },
  ]);

  // Тот же pending до подтверждения DELETE может попасть в следующую сверку.
  await chat._collectPending();
  assert.equal(chatNotifications().length, 1);
});
