import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { IN_TURN_PAGE_LIMIT } from '../../shared/chat/chatInTurnContracts.ts';
import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';
import { ChatTurnLedger } from '../../server/src/lib/chat/turnLedger.ts';
import {
  assertLight,
  chatPath,
  headsOf,
  jsonRequest,
  listFixture,
  putPending,
  readChat,
  reconcile,
  sampleChat,
  versionsOf,
  writeChat,
} from './helpers/chat-list.js';

const LIST = '/api/chat/store/list';

const CHANGES = '/api/chat/store/changes';

const SEARCH = '/api/chat/store/search';

test('LIST-HEADS: тысяча строк без истории и тел вложений', async (t) => {

  const chats = Array.from({ length: 1000 }, (_, index) => sampleChat(`catalog-${index}`, {
    archived: index % 2 === 1,
    title: `Название ${index}`,
    purpose: 'general',
    taskId: '12345',
    logicalIdentity: 'general:12345',
    unread: true,
    closedAt: 300,
    draft: index === 0 ? '**Черновик**'.repeat(200) : '',
    draftAttachments: index === 1 ? [{
      name: 'план.txt',
      data: 'СЕКРЕТНОЕ ТЕЛО',
    }] : [],
  }));

  // Превью берётся из последней реплики, даже если она пустая.
  // Общая фикстура оставляет предыдущий ответ для проверки этого приоритета.
  chats[4].messages.push({
    role: 'assistant',
    text: '',
  });
  chats[5].messages.push({
    role: 'user',
    text: 'Вопрос',
  });
  chats[6].messages.push({
    role: 'error',
    text: 'Отказ',
  });

  const fixture = await listFixture(t, chats);

  const data = await jsonRequest(fixture.app, 'GET', LIST);

  assert.equal(data.listProtocol, 1);
  assert.equal(data.sessions.length, 500);
  assert.equal(data.archived.length, 500);
  assertLight(data);
  assert.equal(JSON.stringify(data).includes('СЕКРЕТНОЕ ТЕЛО'), false);

  for (const expected of chats) {

    const head = headsOf(data).find((entry) => entry.id === expected.id);

    for (const key of ['title', 'purpose', 'taskId', 'logicalIdentity', 'model', 'modelRef',
      'unread', 'archived', 'createdAt', 'updatedAt', 'revision']) {
      assert.deepEqual(head[key], expected[key], `${expected.id}.${key}`);
    }

    assert.equal(typeof head.version, 'string');
    assert.ok(head.version.length > 0);
    assert.equal(head.hasContent, true);
    assert.equal(head.previewSource.length <= 1024, true);
    assert.equal('draft' in head, false);
  }

  const byId = new Map(headsOf(data).map((head) => [head.id, head]));

  assert.equal(byId.get('catalog-0').previewSource, chats[0].draft.slice(0, 1024));
  assert.ok(JSON.stringify(byId.get('catalog-3').lastReply).length < 400);
  assert.equal(JSON.stringify(data).includes('ХВОСТ'), false);
  assert.equal(byId.get('catalog-4').previewSource, '');
  assert.equal(byId.get('catalog-4').hasContent, true);
  assert.equal(byId.get('catalog-5').previewSource, 'Ты: Вопрос');
  assert.equal(byId.get('catalog-6').previewSource, '⚠ Отказ');
  assert.equal(data.sessions.find((head) => head.id === 'catalog-0').hasDraft, true);
  assert.equal(data.archived.find((head) => head.id === 'catalog-1').previewSource, '📎 план.txt');

  const head = (await jsonRequest(fixture.app, 'GET', '/api/chat/store/head/catalog-2')).head;

  const detail = await jsonRequest(fixture.app, 'GET', '/api/chat/store/chat/catalog-2');

  assert.equal(head.previewSource, 'Ответ');
  assert.equal(head.version, detail.version);
  assert.ok(JSON.stringify(head.lastReply).length < 400);
  assert.deepEqual(detail.chat.messages, chats[2].messages);
});

test('LIST-CACHE: неизменные JSON не читаются, изменённый читается один раз', async (t) => {

  const chats = [sampleChat('cached-one'), sampleChat('cached-two')];

  const fixture = await listFixture(t, chats);

  const initial = await jsonRequest(fixture.app, 'GET', LIST);

  const reads = t.mock.method(fs, 'readFile');

  const countReads = () => reads.mock.calls.filter((call) =>
    chats.some((chat) => String(call.arguments[0]) === chatPath(fixture, chat))).length;

  await jsonRequest(fixture.app, 'GET', LIST);
  await jsonRequest(fixture.app, 'POST', CHANGES, { known: versionsOf(initial) });
  assert.equal(countReads(), 0);
  await writeChat(fixture, {
    ...chats[0],
    title: 'Изменённое название длиннее',
  });

  const delta = await jsonRequest(fixture.app, 'POST', CHANGES, { known: versionsOf(initial) });

  assert.equal(countReads(), 1);
  assert.deepEqual(headsOf(delta).map((head) => head.id), [chats[0].id]);
});

test('LIST-DELTA: версии переживают равные даты, архив, удаление и рестарт', async (t) => {

  const one = sampleChat('delta-one');

  const two = sampleChat('delta-two');

  const fixture = await listFixture(t, [one, two]);

  const initial = await jsonRequest(fixture.app, 'GET', LIST);

  const known = versionsOf(initial);

  // Внешняя правка сохраняет уже мигрированную запись и её служебные поля.
  // Иначе следующий старт закономерно меняет байты старого формата и его digest.
  const savedOne = await readChat(fixture, one);

  await writeChat(fixture, {
    ...savedOne,
    title: 'Правка без изменения времени',
    archived: true,
  });
  await fs.rm(chatPath(fixture, two));
  await jsonRequest(fixture.app, 'PUT', '/api/chat/store/chat', {
    chat: sampleChat('delta-new'),
    archived: false,
  });

  const delta = await jsonRequest(fixture.app, 'POST', CHANGES, { known });

  assert.deepEqual(delta.gone, [two.id]);
  assert.deepEqual(delta.sessions.map((head) => head.id), ['delta-new']);
  assert.deepEqual(delta.archived.map((head) => head.id), [one.id]);
  assert.notEqual(delta.archived[0].version, known[one.id]);
  await writeChat(fixture, {
    ...savedOne,
    title: 'Возвращён без новой даты',
  });

  const restored = await jsonRequest(fixture.app, 'POST', CHANGES, {
    known: {
      ...known,
      ...versionsOf(delta),
    },
  });

  assert.deepEqual(restored.sessions.map((head) => head.id), [one.id]);

  const current = await jsonRequest(fixture.app, 'GET', LIST);

  await fixture.app.close();

  const restarted = await listFixture(t, [], { root: fixture.root });

  const empty = await jsonRequest(restarted.app, 'POST', CHANGES, { known: versionsOf(current) });

  assert.deepEqual(headsOf(empty), []);
  assert.deepEqual(empty.gone, []);
});

test('SEARCH-CONTRACT: весь текст, первое совпадение и отдельный архив', async (t) => {

  const longText = 'а'.repeat(1500) + ' Найди Здесь ' + 'б'.repeat(200);

  const chats = [
    sampleChat('search-title', {
      title: 'НАЙДИ ЗДЕСЬ',
      messages: [],
    }),
    sampleChat('search-text', { messages: [
      {
        role: 'user',
        text: longText,
      },
      {
        role: 'assistant',
        text: 'Второе Найди Здесь',
      },
    ] }),
    sampleChat('search-archive', {
      archived: true,
      title: 'Найди Здесь',
    }),
  ];

  const fixture = await listFixture(t, chats);

  for (const archived of [0, 1]) {

    const query = encodeURIComponent('  НаЙдИ ЗдЕсЬ  ');

    const data = await jsonRequest(fixture.app, 'GET', `${SEARCH}?q=${query}&archived=${archived}`);

    assertLight(data);
    assert.deepEqual(data.matches.map((match) => match.id).sort(), archived
      ? ['search-archive'] : ['search-text', 'search-title']);

    if (!archived) {

      const index = longText.toLowerCase().indexOf('найди здесь');

      assert.equal(data.matches.find((match) => match.id === 'search-text').snippetSource,
        '…' + longText.slice(index - 24, index + 72));
      assert.equal(data.matches.find((match) => match.id === 'search-title').snippetSource, '');
    }
  }

  for (const query of ['', '   ', 'такого нет']) {

    const data = await jsonRequest(fixture.app, 'GET', `${SEARCH}?q=${encodeURIComponent(query)}&archived=0`);

    assert.deepEqual(data.matches, []);
  }
});

test('SEARCH-ALL: совпадения не теряются после обычного лимита страницы', async (t) => {

  const chats = Array.from({ length: 1000 }, (_, index) => sampleChat(`match-${index}`, {
    title: `Общий ключ ${index}`,
  }));

  const fixture = await listFixture(t, chats);

  const query = encodeURIComponent('Общий ключ');

  const data = await jsonRequest(fixture.app, 'GET', `${SEARCH}?q=${query}&archived=0`);

  assert.equal(new Set(data.matches.map((match) => match.id)).size, chats.length);
});

test('HEAD-PATCH: метаданные сохраняют ленту и неизвестные поля', async (t) => {

  const chat = sampleChat('patch-one', {
    sessionId: 'session-preserved',
    workdir: { kind: 'grigdesk' },
    customField: { preserved: true },
    inTurnReceipt: { runId: 'old-run' },
  });

  const fixture = await listFixture(t, [chat]);

  const patches = [
    {
      title: 'Новое имя',
      unread: true,
    },
    {
      archived: true,
      closedAt: 444,
    },
    {
      archived: false,
      closedAt: null,
    },
  ];

  for (const patch of patches) {

    const data = await jsonRequest(fixture.app, 'PATCH', `/api/chat/store/chat/${chat.id}`, {
      patch,
      origin: 'tests-window',
    });

    const saved = await readChat(fixture, chat);

    assertLight(data);
    assert.equal(data.head.id, chat.id);

    for (const key of ['messages', 'sessionId', 'workdir', 'customField', 'inTurnReceipt']) {
      assert.deepEqual(saved[key], chat[key]);
    }

    assert.equal(saved.updatedAt, chat.updatedAt);
    assert.equal(saved.archived, patch.archived ?? false);

    if (patch.closedAt === null) {
      assert.equal('closedAt' in saved, false);
    }
  }

  const before = await readChat(fixture, chat);

  const events = fixture.events.length;

  await jsonRequest(fixture.app, 'PATCH', `/api/chat/store/chat/${chat.id}`, {
    patch: { title: 'Новое имя' },
  });
  assert.equal((await readChat(fixture, chat)).revision, before.revision);
  assert.equal(fixture.events.length, events, 'no-op не будит SSE');
});

test('HEAD-PATCH-REJECT: запрещённые поля и типы не записываются', async (t) => {

  const chat = sampleChat('patch-invalid');

  const fixture = await listFixture(t, [chat]);

  await jsonRequest(fixture.app, 'GET', '/api/chat/store/list');

  const original = await fs.readFile(chatPath(fixture, chat), 'utf8');

  for (const patch of [{ messages: [] }, { model: 'other' }, { workdir: {} }, { unknown: 1 },
    { title: 5 }, { unread: 'yes' }, { archived: 1 }, { closedAt: 'now' }]) {

    const response = await fixture.app.inject({
      method: 'PATCH',
      url: `/api/chat/store/chat/${chat.id}`,
      payload: { patch },
    });

    assert.equal(response.statusCode, 400, JSON.stringify(patch));
    assert.equal(await fs.readFile(chatPath(fixture, chat), 'utf8'), original);
  }

  const missing = await fixture.app.inject({
    method: 'PATCH',
    url: '/api/chat/store/chat/unknown-id',
    payload: { patch: { title: 'Нет' } },
  });

  assert.equal(missing.statusCode, 404);
});

test('HEAD-PATCH-REJECT: удаляемый чат отвечает 409', async (t) => {

  const gate = Promise.withResolvers();

  const entered = Promise.withResolvers();

  t.after(() => gate.resolve());

  const chat = sampleChat('patch-deleting');

  const fixture = await listFixture(t, [chat]);

  const remove = ChatHistoryStore.prototype.remove;

  t.mock.method(ChatHistoryStore.prototype, 'remove', async function (id) {
    if (id === chat.id) {
      entered.resolve();
      await gate.promise;
    }

    return remove.call(this, id);
  });

  const deleting = fixture.app.inject({
    method: 'DELETE',
    url: `/api/chat/store/chat/${chat.id}`,
  });

  deleting.then(() => {});
  await entered.promise;

  const response = await fixture.app.inject({
    method: 'PATCH',
    url: `/api/chat/store/chat/${chat.id}`,
    payload: { patch: { title: 'Поздняя правка' } },
  });

  gate.resolve();
  await deleting;
  assert.equal(response.statusCode, 409, response.body);
});

test('HEAD-PENDING-KINDS: фон, синхронный итог и остановка сохраняются один раз', async (t) => {

  const chat = sampleChat('pending-kinds', {
    messages: [],
    unread: false,
  });

  const fixture = await listFixture(t, [chat], {
    turns: [{
      turnId: 'turn-cut01',
      chatKey: chat.id,
      state: 'done',
      acceptedAt: Date.now(),
      finishedAt: Date.now(),
      outcome: 'interrupted',
    }],
  });

  const entries = [
    {
      id: 'o-bg',
      role: 'assistant',
      reply: 'Фон',
      unsolicited: true,
      source: 'background',
      runId: 'run-bg01',
    },
    {
      id: 'o-sync',
      userText: 'Вопрос',
      reply: 'Ответ',
    },
    {
      id: 'o-cut',
      turnId: 'turn-cut01',
      reply: '⏹ Ход прерван перезапуском сервера — память сессии сохранена.',
      stopped: true,
      interruptedBy: 'server_shutdown',
      runId: 'run-cut01',
      steps: [{
        k: 'text',
        text: 'До остановки',
      }],
    },
  ];

  for (const entry of entries) {
    await putPending(fixture, {
      ...entry,
      chatKey: chat.id,
      at: Date.now(),
    });
  }

  const first = await reconcile(fixture.app);

  assertLight(first);
  await reconcile(fixture.app);
  await Promise.all([reconcile(fixture.app), reconcile(fixture.app)]);

  const saved = await readChat(fixture, chat);

  for (const entry of entries) {

    const finals = saved.messages.filter((message) => message.pid === entry.id);

    assert.equal(finals.length, 1, entry.id);
    assert.equal(finals[0].text, entry.reply);
  }

  assert.equal(saved.messages.some((message) => message.pid === 'o-bg:u'), false);
  assert.equal(saved.messages.filter((message) => message.pid === 'o-sync:u').length, 1);
  assert.equal(saved.messages.find((message) => message.pid === 'o-cut').stopped, true);
  assert.equal(saved.messages.find((message) => message.pid === 'o-cut').interruptedBy, 'server_shutdown');
  assert.equal(saved.unread, true);
  assert.deepEqual(await fs.readdir(path.join(fixture.config.chatsDir, 'pending')), []);
  await writeChat(fixture, {
    ...saved,
    unread: false,
  });
  await putPending(fixture, {
    ...entries[0],
    chatKey: chat.id,
    at: Date.now(),
  });
  await reconcile(fixture.app);
  assert.equal((await readChat(fixture, chat)).unread, false, 'повтор финала не поднимает unread');
});

for (const failure of ['history', 'ledger']) {
  test(`HEAD-PENDING-FAIL: отказ ${failure} оставляет повторяемый pending`, async (t) => {

    const chat = sampleChat(`pending-${failure}`, { messages: [] });

    const turnId = `orphan-${failure}`;

    const fixture = await listFixture(t, [chat], {
      turns: [{
        turnId,
        chatKey: chat.id,
        state: 'done',
        acceptedAt: Date.now(),
      }],
    });

    const entry = {
      id: turnId,
      turnId,
      chatKey: chat.id,
      reply: 'Устойчивый итог',
      at: Date.now(),
    };

    await putPending(fixture, entry);

    let broken = true;

    const method = failure === 'history' ? 'writeAtomic' : 'persist';

    const prototype = failure === 'history' ? ChatHistoryStore.prototype : ChatTurnLedger.prototype;

    const original = prototype[method];

    const mock = t.mock.method(prototype, method, async function (...args) {
      if (broken && (failure === 'ledger' || String(args[0]).startsWith(fixture.config.chatsDir))) {
        throw new Error('Синтетический отказ диска');
      }

      return original.apply(this, args);
    });

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/chat/store/reconcile',
      payload: {
        loadedIds: [],
        deliveryIds: [],
      },
    });

    assert.ok(response.statusCode >= 500, response.body);
    await fs.access(path.join(fixture.config.chatsDir, 'pending', `${entry.id}.json`));
    broken = false;
    await reconcile(fixture.app);
    mock.mock.restore();

    const saved = await readChat(fixture, chat);

    assert.equal(saved.messages.filter((message) => message.pid === entry.id).length, 1);
  });
}

test('HEAD-PENDING-META: старый run не откатывает новую сессию, имя и черновик', async (t) => {

  const chat = sampleChat('pending-meta', {
    sessionId: 'new-session',
    executionRunId: 'new-run01',
    title: 'Ручное имя',
    draft: 'Новый черновик',
    contextTokens: 999,
  });

  const fixture = await listFixture(t, [chat]);

  await putPending(fixture, {
    id: 'orphan-meta',
    chatKey: chat.id,
    reply: 'Старый итог',
    at: Date.now(),
    sessionId: 'old-session',
    runId: 'old-run01',
    contextTokens: 12,
    steps: [{
      k: 'text',
      text: 'Шаг',
    }],
    cost: 0.25,
    stopped: true,
  });
  await reconcile(fixture.app);

  const saved = await readChat(fixture, chat);

  const final = saved.messages.find((message) => message.pid === 'orphan-meta');

  assert.equal(saved.sessionId, chat.sessionId);
  assert.equal(saved.contextTokens, chat.contextTokens);
  assert.equal(saved.title, chat.title);
  assert.equal(saved.draft, chat.draft);
  assert.deepEqual(final.steps, [{
    k: 'text',
    text: 'Шаг',
  }]);
  assert.equal(final.cost, 0.25);
  assert.equal(final.stopped, true);
});

test('HEAD-PENDING-DURABLE: все страницы уточнений, финал и receipt до ACK', async (t) => {

  const turnId = 'durable-turn01';

  const runId = 'durable-run01';

  const chat = sampleChat('pending-durable', {
    messages: [{
      role: 'user',
      text: 'Начало',
      turnId,
      delivery: 'sending',
    }],
    outbox: [{
      turnId,
      text: 'Начало',
    }],
  });

  const records = Array.from({ length: IN_TURN_PAGE_LIMIT + 2 }, (_, index) => ({
    chatKey: chat.id,
    runId,
    parentTurnId: turnId,
    messageId: `durable-msg-${index}`,
    sequence: index + 1,
    revision: 1,
    state: 'consumed',
    fingerprint: `fingerprint-${index}`,
    text: `Уточнение ${index}`,
    acceptedAt: Date.now(),
    updatedAt: Date.now(),
  }));

  const fixture = await listFixture(t, [chat], {
    inTurn: records,
    turns: [{
      turnId,
      chatKey: chat.id,
      state: 'done',
      acceptedAt: Date.now(),
      runId,
    }],
  });

  const steps = [{
    k: 'text',
    text: 'Полная лента шагов',
  }];

  await putPending(fixture, {
    id: turnId,
    turnId,
    runId,
    chatKey: chat.id,
    userText: 'Начало',
    reply: 'Окончательный ответ',
    steps,
    at: Date.now(),
  });

  const lostResponse = await fixture.app.inject({
    method: 'POST',
    url: '/api/chat/store/reconcile',
    payload: {
      loadedIds: [],
      deliveryIds: [],
    },
  });

  assert.equal(lostResponse.statusCode, 200, 'сервер обработал ответ, который окно не применило');

  const response = await reconcile(fixture.app);

  assertLight(response);
  assert.deepEqual(response.pending, []);
  await Promise.all([reconcile(fixture.app), reconcile(fixture.app)]);

  const saved = await readChat(fixture, chat);

  for (const record of records) {
    assert.equal(saved.messages.filter((message) => message.messageId === record.messageId).length, 1);
  }

  const finals = saved.messages.filter((message) => message.pid === turnId && message.role === 'assistant');

  assert.equal(finals.length, 1);
  assert.deepEqual(finals[0].steps, steps);
  assert.equal(saved.messages.find((message) => message.turnId === turnId).delivery, undefined);
  assert.equal((saved.outbox || []).some((entry) => entry.turnId === turnId), false);
  assert.deepEqual(await fs.readdir(path.join(fixture.config.chatsDir, 'pending')), []);
});

test('HEAD-PENDING-FAIL: исчезнувший чат не создаётся повторной сверкой', async (t) => {

  const fixture = await listFixture(t);

  await putPending(fixture, {
    id: 'missing-pending',
    chatKey: 'missing-chat',
    reply: 'Не создавать',
    at: Date.now(),
  });

  const data = await reconcile(fixture.app);

  assert.ok(data.gone.includes('missing-chat'));
  assert.equal((await fixture.app.inject('/api/chat/store/chat/missing-chat')).statusCode, 404);
});

for (const kind of ['error-reset-seed', 'compact']) {
  test(`HEAD-PENDING-META: ${kind} сохраняет прежнюю семантику`, async (t) => {

    const chat = sampleChat(`meta-${kind}`, {
      sessionId: 'old-session',
      contextTokens: 5000,
      draft: 'Черновик',
      messages: [],
    });

    const fixture = await listFixture(t, [chat]);

    const seed = 'Сделано: один шаг. Дальше: второй.';

    const prefix = '[Выжимка предыдущего разговора — продолжаем с этого места]';

    const pending = kind === 'compact'
      ? {
        compact: {
          kind: 'summary',
          seed,
        },
        reply: seed,
      }
      : {
        role: 'error',
        reply: 'Ошибка хода',
        sessionReset: true,
        turnId: 'reset-turn01',
        userText: `${prefix}\n${seed}\n[/Выжимка]\n\nВопрос`,
      };

    await putPending(fixture, {
      id: `orphan-${kind}`,
      chatKey: chat.id,
      at: Date.now(),
      ...pending,
    });
    await reconcile(fixture.app);

    const saved = await readChat(fixture, chat);

    assert.equal(saved.sessionId, null);
    assert.equal(saved.contextTokens, 0);
    assert.equal(saved.pendingSeed, seed);
    assert.equal(saved.draft, chat.draft);
    assert.equal(saved.messages.at(-1).role, kind === 'compact' ? 'note' : 'error');
    assert.equal(saved.messages.at(-1).pid, `orphan-${kind}`);

    if (kind === 'error-reset-seed') {
      assert.equal(saved.messages[0].text, 'Вопрос');
      assert.equal(saved.messages.some((message) => message.text.includes(prefix)), false);
    }
  });
}
