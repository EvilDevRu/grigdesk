import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatTurnLedger } from '../../server/src/lib/chat/turnLedger.ts';
import { IN_TURN_PAGE_LIMIT } from '../../shared/chat/chatInTurnContracts.ts';
import { readChat, putPending, sampleChat, writeChat } from '../server/helpers/chat-list.js';
import { controlledExecutor, turnBody, waitFor } from '../server/helpers/chat-turns.js';
import { chatNotifications, setChatVisible } from './helpers/chat-store.js';
import { drain, memoryStorage, SNAPSHOT_KEY } from './helpers/chat-load.js';
import {
  CATALOG,
  DETAIL,
  detailReads,
  ensureMessages,
  headOf,
  lazyWindow,
  serverWorld,
} from './helpers/chat-lazy.js';

test('LAZY-ENTRY: список без полной истории, скрытая поверхность не загружает ленту', async (t) => {

  const { chat, calls } = await lazyWindow(t);

  const id = chat.sessions[0].id;

  const surface = chat.registerSurface('телефон', {
    chatId: id,
    visible: false,
  });

  t.after(() => surface.dispose());
  await drain();
  assert.equal(chat.loaded, true);
  assert.equal(calls.some((call) => call.url === CATALOG), true);
  assert.equal(calls.some((call) => call.url === '/api/chat/store'), false);
  assert.equal(detailReads(calls, id).length, 0);
  assert.deepEqual(chat.sessions[0].messages || [], []);
  assert.equal(chat.list('')[0].snippet, 'Ответ');
});

test('LAZY-OPEN: видимая поверхность и два потребителя делят одну загрузку', async (t) => {

  const gate = Promise.withResolvers();

  const original = sampleChat();

  const { chat, calls } = await lazyWindow(t, { detail: () => gate.promise });

  const live = chat.sessions[0];

  const surface = chat.registerSurface('страница', {
    chatId: original.id,
    visible: true,
  });

  t.after(() => surface.dispose());
  assert.equal(typeof chat.ensureChatMessages, 'function', 'есть адресная загрузка');

  const first = ensureMessages(chat, original.id);

  const second = ensureMessages(chat, original.id);

  await drain();
  assert.equal(detailReads(calls, original.id).length, 1);
  gate.resolve({
    chat: original,
    version: 'version-one',
  });
  await Promise.all([first, second]);
  assert.equal(chat.sessions[0], live);
  assert.deepEqual(live.messages, original.messages);
  await ensureMessages(chat, original.id);
  assert.equal(detailReads(calls, original.id).length, 1, 'полная лента не скачивается повторно');
});

for (const kind of ['network', '503', '401', 'no-messages', 'wrong-id', 'bad-envelope']) {
  test(`LAZY-RETRY: ${kind} не подтверждает пустую ленту и допускает повтор`, async (t) => {

    const original = sampleChat();

    let broken = true;

    const { chat, calls } = await lazyWindow(t, {
      detail: async () => {
        if (!broken) {
          return {
            chat: original,
            version: 'version-one',
          };
        }
        if (kind === 'network') {
          throw new TypeError('Нет связи');
        }
        if (kind === '503' || kind === '401') {
          throw Object.assign(new Error('Причина отказа'), { status: Number(kind) });
        }
        if (kind === 'no-messages') {

          const { messages, ...incomplete } = original;

          return {
            chat: incomplete,
            version: 'version-one',
          };
        }
        if (kind === 'wrong-id') {
          return {
            chat: {
              ...original,
              id: 'foreign-chat',
            },
            version: 'version-one',
          };
        }

        return { chat: original };
      },
    });

    assert.equal(typeof chat.ensureChatMessages, 'function', 'есть адресная загрузка');
    await ensureMessages(chat, original.id).catch(() => {});
    assert.deepEqual(chat.sessions[0].messages || [], []);
    assert.equal(calls.some((call) => call.method === 'PUT' && call.body?.chat?.id === original.id), false);
    broken = false;
    await ensureMessages(chat, original.id);
    assert.equal(detailReads(calls, original.id).length, 2);
    assert.deepEqual(chat.sessions[0].messages, original.messages);
  });
}

for (const action of ['dispose', 'remove']) {
  test(`LAZY-LATE: ${action} отвергает поздний detail`, async (t) => {

    const gate = Promise.withResolvers();

    const original = sampleChat();

    const { chat } = await lazyWindow(t, { detail: () => gate.promise });

    assert.equal(typeof chat.ensureChatMessages, 'function', 'есть адресная загрузка');

    const loading = ensureMessages(chat, original.id).catch(() => {});

    const live = chat.sessions[0];

    await drain();

    if (action === 'dispose') {
      chat.$dispose();
    } else {
      chat._dropRemoteChat(original.id);
    }

    gate.resolve({
      chat: original,
      version: 'version-one',
    });
    await loading;
    assert.deepEqual(live.messages || [], []);

    if (action === 'remove') {
      assert.equal(chat.sessions.some((session) => session.id === original.id), false);
    }
  });
}

test('LAZY-RETRY: rename во время detail не откатывается старым ответом', async (t) => {

  const gate = Promise.withResolvers();

  const original = sampleChat();

  const { chat } = await lazyWindow(t, {
    storage: false,
    detail: () => gate.promise,
    onCall: async ({ method, body }) => method === 'PATCH'
      ? { head: {
        ...headOf(original, 'version-two'),
        ...body.patch,
      } } : undefined,
  });

  assert.equal(typeof chat.ensureChatMessages, 'function', 'есть адресная загрузка');

  const loading = ensureMessages(chat, original.id);

  chat.renameChat(original.id, 'Название из окна');
  await chat._writeChat(original.id);
  gate.resolve({
    chat: original,
    version: 'version-one',
  });
  await loading;
  assert.equal(chat.sessions[0].title, 'Название из окна');
});

test('HEAD-MUTATIONS: действия головы не передают неполную ленту', async (t) => {

  const original = sampleChat('head-actions', {
    unread: true,
    draft: 'Сохранённый черновик',
  });

  const world = await serverWorld(t, [original, sampleChat('head-neighbor')]);

  const { chat, calls } = await world.open();

  chat.renameChat(original.id, 'Переименовали');
  await chat._writeChat(original.id);
  chat.setTitle(original.id, 'Другое имя');
  await chat._writeChat(original.id);
  setChatVisible(original.id);
  chat.markRead(original.id);
  await chat._writeChat(original.id);
  chat.closeSession(original.id);
  await chat._writeChat(original.id);
  assert.equal(chat.archived.some((entry) => entry.id === original.id), true);
  chat.restoreArchived(original.id);
  await chat._writeChat(original.id);
  chat.deleteChat(original.id);
  await chat._writeChat(original.id);

  const saved = await readChat(world, original);

  assert.deepEqual(saved.messages, original.messages);
  assert.equal(saved.draft, original.draft);
  assert.equal(saved.updatedAt, original.updatedAt);
  assert.equal(saved.title, 'Другое имя');
  assert.equal(detailReads(calls, original.id).length, 0);
  assert.equal(calls.some((call) => call.method === 'PUT' && call.body?.chat?.id === original.id), false);
  assert.equal(calls.filter((call) => call.method === 'PATCH').length > 0, true);
});

test('HEAD-NO-PUT: force и прямой writer не подтверждают голову как полную', async (t) => {

  const original = sampleChat('head-no-put');

  const world = await serverWorld(t, [original]);

  const { chat, calls } = await world.open();

  await chat._putChat(original.id, true).catch(() => {});
  await chat._writeChat(original.id, { force: true }).catch(() => {});
  chat._persist(true);
  await drain();
  assert.equal(calls.some((call) => call.method === 'PUT' && call.body?.chat?.id === original.id), false);
  assert.deepEqual((await readChat(world, original)).messages, original.messages);
});

test('HEAD-ALIVE: соседний persist сохраняет головы, явное удаление даёт один DELETE', async (t) => {

  const original = sampleChat('head-alive', { archived: true });

  const other = sampleChat('head-other');

  const world = await serverWorld(t, [original, other]);

  const { chat, calls } = await world.open();

  assert.deepEqual(chat._find(original.id).messages || [], [], 'неоткрытая голова не содержит ленту');
  chat.setTitle(other.id, 'Правка соседа');
  await chat._writeChat(other.id);
  assert.deepEqual((await readChat(world, original)).messages, original.messages);
  chat.deleteChat(original.id);
  chat._persist(true);
  await waitFor(() => calls.some((call) => call.method === 'DELETE'
    && call.url.split('?')[0] === `${DETAIL}${original.id}`));
  await drain();
  assert.equal(calls.filter((call) => call.method === 'DELETE'
    && call.url.split('?')[0] === `${DETAIL}${original.id}`).length, 1);
  assert.equal((await world.app.inject(`${DETAIL}${original.id}`)).statusCode, 404);
});

test('LAZY-SSE: чужая голова обновляет строку без detail', async (t) => {

  const original = sampleChat();

  const { chat, calls, sse } = await lazyWindow(t, {
    onCall: async ({ url }) => url.includes('/head/')
      ? { head: {
        ...headOf(original, 'version-two'),
        title: 'Из другого окна',
      } } : undefined,
  });

  const live = chat.sessions[0];

  sse('chat-store', {
    id: original.id,
    origin: 'foreign-window',
    archived: false,
  });
  await waitFor(() => calls.some((call) => call.url.includes('/head/')));
  await drain();
  assert.equal(live.title, 'Из другого окна');
  assert.equal(chat.sessions[0], live);
  assert.equal(detailReads(calls, original.id).length, 0);
  assert.deepEqual(live.messages || [], []);
});

test('LAZY-RESYNC: hello отправляет known, принимает changed/gone и хранит локальный чат', async (t) => {

  const original = sampleChat();

  const removed = sampleChat('gone-chat');

  const { chat, calls, sse } = await lazyWindow(t, {
    chats: [original, removed],
    onCall: async ({ url }) => url === '/api/chat/store/changes' ? {
      listProtocol: 1,
      sessions: [{
        ...headOf(original, 'version-two'),
        title: 'После обрыва',
      }],
      archived: [],
      gone: [removed.id],
    } : undefined,
  });

  const localId = chat.newSession();

  chat.setDraft(localId, 'Несохранённое');
  sse('hello', {});
  await waitFor(() => calls.some((call) => call.url === '/api/chat/store/changes'));
  await drain();

  const request = calls.find((call) => call.url === '/api/chat/store/changes');

  assert.equal(request.method, 'POST');
  assert.deepEqual(request.body.known, {
    [original.id]: 'version-one',
    [removed.id]: 'version-one',
  });
  assert.equal(chat._find(original.id).title, 'После обрыва');
  assert.equal(Boolean(chat._find(removed.id)), false);
  assert.equal(chat._find(localId).draft, 'Несохранённое');
  assert.equal(calls.some((call) => call.url === '/api/chat/store'), false);
  assert.equal(detailReads(calls, original.id).length, 0);
  assert.equal(calls.some((call) => call.method === 'DELETE' && call.url.endsWith(removed.id)), false);
});

test('HEAD-UNREAD: окончательный ответ уведомляет один раз, rename и блок не уведомляют', async (t) => {

  const original = sampleChat('head-notice', { unread: false });

  const world = await serverWorld(t, [original]);

  const { chat, sse, calls } = await world.open();

  assert.equal(chatNotifications().length, 0, 'вход не уведомляет о старой истории');
  await writeChat(world, {
    ...original,
    title: 'Другое имя',
  });
  sse('chat-store', {
    id: original.id,
    origin: 'foreign-window',
  });
  await waitFor(() => chat._find(original.id).title === 'Другое имя');
  assert.equal(chatNotifications().length, 0);
  await writeChat(world, {
    ...original,
    messages: [...original.messages,
    {
      role: 'assistant',
      text: 'Промежуточный блок',
      assistantMessageId: 'notice-block01',
      kind: 'assistant-block',
      runId: 'notice-run01',
    }],
  });
  sse('chat-store', {
    id: original.id,
    origin: 'foreign-window',
  });
  await drain();
  assert.equal(chatNotifications().length, 0);
  await writeChat(world, {
    ...original,
    messages: [...original.messages,
    {
      role: 'assistant',
      text: 'Новый финал',
      pid: 'notice-final01',
    }],
  });
  sse('chat-store', {
    id: original.id,
    origin: 'foreign-window',
  });
  await waitFor(() => chatNotifications().length === 1);
  sse('chat-store', {
    id: original.id,
    origin: 'foreign-window',
  });
  await drain();
  assert.equal(chatNotifications().length, 1);
  assert.equal(chat._find(original.id).unread, true);
  assert.equal(detailReads(calls, original.id).length, 0);
});

for (const mode of ['two-windows', 'sender-closed', 'old-pending']) {
  test(`LAZY-PENDING-FOREIGN: ${mode} сохраняет ответ без скрытой гидратации`, async (t) => {

    const control = controlledExecutor();

    const execute = control.executor.run;

    control.executor.inTurnInput = {
      protocol: 1,
      text: true,
      confirmation: 'forwarded',
    };
    control.executor.run = (options) => {
      options.onInTurnReady?.({
        async deliver() {
          return {
            ok: true,
            state: 'forwarded',
          };
        },
        close() {},
      });

      return execute(options);
    };

    const original = sampleChat('foreign-pending', { messages: [] });

    const world = await serverWorld(t, [original], { executor: control.executor });

    let first = null;

    let second;

    if (mode === 'old-pending') {
      await putPending(world, {
        id: 'foreign-old01',
        chatKey: original.id,
        reply: 'Ответ другого окна',
        at: Date.now() - 60000,
        steps: [{
          k: 'text',
          text: 'Старый шаг',
        }],
      });
      second = await world.open();
    } else {
      first = await world.open();
      second = await world.open();
      await ensureMessages(first.chat, original.id);
      await first.chat.send(original.id, 'Вопрос другого окна');
      await control.waitForRuns(1);
      await first.chat._loadActive();
      assert.equal(await first.chat.sendInTurn(original.id, 'Уточнение из окна'), true);

      const started = world.events.find((event) => event.event === 'chat-turn-start');

      if (started) {
        second.sse(started.event, started.data);
      }
      if (mode === 'sender-closed') {
        first.chat.loaded = false;
        first.chat.$dispose();
      }

      await control.runs[0].options.onAssistantMessage?.({
        assistantMessageId: 'foreign-block01',
        text: 'Промежуточный ответ',
        sourceRevision: 1,
        complete: true,
      });
      control.runs[0].release('Ответ другого окна');
      await waitFor(async () => (await world.app.inject('/api/chat/pending')).json().pending.length === 1);
    }

    const surface = second.chat.registerSurface('скрытый телефон', {
      chatId: original.id,
      visible: false,
    });

    t.after(() => surface.dispose());
    second.sse('chat-orphan', { chatKey: original.id });
    second.sse('chat-done', { chatKey: original.id });
    second.sse('hello', {});
    await waitFor(async () => (await readChat(world, original)).messages
      .filter((message) => message.text === 'Ответ другого окна').length === 1);
    await second.chat._collectPending();
    await second.chat._collectPending();
    await waitFor(() => second.chat.list('')[0]?.unread === true);
    await waitFor(() => second.calls.every((call) => call.done));
    assert.equal(detailReads(second.calls, original.id).length, 0);

    const writes = second.calls.filter((call) => call.method === 'PUT');

    const acknowledgements = second.calls.filter((call) => call.method === 'DELETE');

    assert.equal(writes.some((call) => call.body?.chat?.id === original.id), false);
    assert.equal(acknowledgements.some((call) => call.url.includes('/pending/')), false);
    assert.deepEqual(second.chat._find(original.id).messages || [], []);

    for (const call of second.calls) {
      assert.equal(JSON.stringify(call.response).includes('"messages"'), false, call.url);
      assert.equal(JSON.stringify(call.response).includes('"steps"'), false, call.url);
    }

    if (first && mode === 'two-windows') {
      first.sse('chat-store', {
        id: original.id,
        origin: 'другое-окно',
      });
      first.sse('chat-done', { chatKey: original.id });
      await first.chat._loadActive();
      await waitFor(() => first.chat._find(original.id).messages
        .filter((message) => message.text === 'Ответ другого окна').length === 1);
      assert.equal(first.chat._find(original.id).sending, false);
      await first.chat._writeChat(original.id, { force: true });
      assert.equal((await readChat(world, original)).messages
        .filter((message) => message.text === 'Ответ другого окна').length, 1);
    }

    await ensureMessages(second.chat, original.id);
    assert.equal(detailReads(second.calls, original.id).length, 1);
    assert.equal(second.chat._find(original.id).messages
      .filter((message) => message.text === 'Ответ другого окна').length, 1);
    assert.ok(second.chat._find(original.id).messages.at(-1).steps.length > 0);

    if (mode !== 'old-pending') {
      assert.equal(second.chat._find(original.id).messages
        .filter((message) => message.text === 'Уточнение из окна').length, 1);
    }
  });
}

test('LAZY-ACTIVE: turn-start и assistant-block головы не создают messages', async (t) => {

  const original = sampleChat('head-active');

  const { chat, sse, calls } = await lazyWindow(t);

  const id = chat.sessions[0].id;

  sse('chat-turn-start', {
    chatKey: id,
    runId: 'head-run01',
    turnId: 'head-turn01',
  });
  sse('chat-assistant-message', {
    chatKey: id,
    runId: 'head-run01',
    assistantMessageId: 'head-block01',
    text: 'Потоковый блок',
    complete: true,
    revision: 1,
  });
  await drain();
  assert.deepEqual(chat._find(id).messages || [], []);
  assert.equal(chat._find(id).updatedAt, original.updatedAt);
  assert.equal(calls.some((call) => call.method === 'PUT' && call.body?.chat?.id === id), false);
});

test('LAZY-SNAPSHOT: ответ A восстановлен при более новом B без замены каталога C', async (t) => {

  const one = sampleChat('snapshot-a', { updatedAt: 100 });

  const two = sampleChat('snapshot-b', { updatedAt: 9999 });

  const three = sampleChat('snapshot-c');

  const world = await serverWorld(t, [one, two, three]);

  const snapshot = {
    sessions: [{
      ...one,
      updatedAt: 200,
      messages: [...one.messages,
    {
      role: 'assistant',
      text: 'Спасённый ответ',
      pid: 'snapshot-reply01',
    }],
    }],
    archived: [],
  };

  memoryStorage(t, { [SNAPSHOT_KEY]: JSON.stringify(snapshot) });

  const { chat, calls } = await world.open();

  await waitFor(async () => (await readChat(world, one)).messages
    .some((message) => message.pid === 'snapshot-reply01'));
  assert.equal(chat._find(two.id).title, two.title);
  assert.ok(chat._find(three.id));
  assert.equal(detailReads(calls, three.id).length, 0);

  const saved = await readChat(world, one);

  assert.equal(saved.messages.filter((message) => message.pid === 'snapshot-reply01').length, 1);
  assert.equal(chat.historyStepReuseProtocol, 1);
});

test('LAZY-SNAPSHOT-FAIL: отказ списка не читает и не переписывает страховку', async (t) => {

  const saved = JSON.stringify({
    sessions: [sampleChat()],
    archived: [],
  });

  const { calls: storageCalls, values } = memoryStorage(t, { [SNAPSHOT_KEY]: saved });

  const { chat } = await lazyWindow(t, {
    storage: false,
    onCall: async ({ url }) => {
      if (url === CATALOG || url === '/api/chat/store') {
        throw new TypeError('Нет связи');
      }
    },
  });

  assert.equal(chat.loaded, false);
  assert.equal(storageCalls.some((call) => call[1] === SNAPSHOT_KEY), false);
  assert.equal(values.get(SNAPSHOT_KEY), saved);
});

for (const state of ['known', 'accepting', 'unknown']) {
  test(`LAZY-DELIVERY: ${state} сверяется без detail и повторного запуска`, async (t) => {

    const turnId = `delivery-${state}01`;

    const control = controlledExecutor();

    const gate = Promise.withResolvers();

    t.after(() => gate.resolve());

    const original = sampleChat(`delivery-${state}`, {
      messages: [{
        role: 'user',
        text: 'Вопрос',
        turnId,
        delivery: 'sending',
        sentAt: Date.now() - 60000,
        outbox: {
          text: 'Вопрос',
          modelRef: {
            provider: 'test-provider',
            model: 'test-model',
          },
        },
      }],
    });

    const world = await serverWorld(t, [original], {
      executor: control.executor,
      turns: state === 'known' ? [{
        turnId,
        chatKey: original.id,
        state: 'done',
        acceptedAt: Date.now(),
      }] : [],
    });

    let accepting;

    if (state === 'accepting') {

      const persist = ChatTurnLedger.prototype.persist;

      t.mock.method(ChatTurnLedger.prototype, 'persist', async function (id) {
        if (id === turnId) {
          gate.entered = true;
          await gate.promise;
        }

        return persist.call(this, id);
      });
      accepting = world.app.inject({
        method: 'POST',
        url: '/api/chat',
        payload: turnBody(original.id, turnId, 'Вопрос'),
      });
      accepting.then(() => {});
      await waitFor(() => gate.entered);
    }

    const view = await world.open();

    await view.chat._reconcileDeliveries();
    assert.deepEqual(view.chat._find(original.id).messages || [], []);
    assert.equal(detailReads(view.calls, original.id).length, 0);
    assert.equal(view.calls.some((call) => call.method === 'POST' && call.url === '/api/chat'), false);

    const saved = await readChat(world, original);

    assert.equal(saved.messages[0].delivery, state === 'known' ? undefined : 'sending');
    assert.equal(Boolean(saved.messages[0].outbox), state !== 'known');

    if (state === 'accepting') {
      gate.resolve();
      await accepting;
      await control.waitForRuns(1);
      control.runs[0].release();
    }
    if (state === 'unknown') {
      await ensureMessages(view.chat, original.id);
      assert.equal(view.chat.deliveries[turnId]?.state, 'lost', 'после открытия прежняя сверка немедленная');
      await view.chat.retryDelivery(original.id, turnId);
      await control.waitForRuns(1);

      const requests = view.calls.filter((call) => call.method === 'POST' && call.url === '/api/chat');

      assert.equal(requests.length, 1);
      assert.equal(requests[0].body.turnId, turnId);
      control.runs[0].release('Повтор принят');
    }
  });
}

for (const failure of ['none', 'page', 'put']) {
  test(`LAZY-PENDING: полная лента, ${failure}, все страницы до PUT и ACK`, async (t) => {

    const turnId = 'loaded-pending01';

    const runId = 'loaded-run0001';

    const original = sampleChat('loaded-pending', { messages: [{
      role: 'user',
      text: 'Вопрос',
      turnId,
    }] });

    const records = Array.from({ length: IN_TURN_PAGE_LIMIT + 1 }, (_, index) => ({
      chatKey: original.id,
      runId,
      parentTurnId: turnId,
      messageId: `loaded-message-${index}`,
      sequence: index + 1,
      revision: 1,
      state: 'consumed',
      fingerprint: `hash-${index}`,
      text: `Уточнение ${index}`,
      acceptedAt: Date.now(),
      updatedAt: Date.now(),
    }));

    const world = await serverWorld(t, [original], {
      inTurn: records,
      turns: [{
        turnId,
        chatKey: original.id,
        state: 'done',
        acceptedAt: Date.now(),
        runId,
      }],
    });

    const view = await world.open();

    await ensureMessages(view.chat, original.id);
    await putPending(world, {
      id: turnId,
      turnId,
      runId,
      chatKey: original.id,
      reply: 'Итог полной ленты',
      at: Date.now(),
      userText: 'Вопрос',
      steps: [{
        k: 'text',
        text: 'Шаг финала',
      }],
    });

    const originalGet = view.api.get;

    const originalPut = view.api.put;

    let broken = failure !== 'none';

    view.api.get = async (url, options) => {
      if (broken && failure === 'page' && /afterSequence=[1-9]/.test(url)) {
        throw new TypeError('Не пришла вторая страница');
      }

      return originalGet(url, options);
    };
    view.api.put = async (...args) => {
      if (broken && failure === 'put') {
        throw new TypeError('История не записалась');
      }

      return originalPut(...args);
    };

    const start = view.calls.length;

    await view.chat._collectPending();

    if (broken) {
      assert.equal(view.calls.slice(start).some((call) => call.method === 'DELETE'), false);
      assert.equal((await world.app.inject('/api/chat/pending')).json().pending.length, 1);
    }

    broken = false;
    await view.chat._collectPending();
    await view.chat._collectPending();

    const calls = view.calls.slice(start);

    const put = calls.findIndex((call) => call.method === 'PUT' && call.body?.chat?.id === original.id);

    const ack = calls.findIndex((call) => call.method === 'DELETE' && call.url.includes('/pending/'));

    const saved = await readChat(world, original);

    assert.ok(calls.some((call) => call.url === '/api/chat/store/reconcile'));
    assert.ok(put >= 0 && ack > put, 'полная запись предшествует ACK');
    assert.equal(saved.messages.filter((message) => message.pid === turnId).length, 1);

    for (const record of records) {
      assert.equal(saved.messages.filter((message) => message.messageId === record.messageId).length, 1);
    }
  });
}

for (const failure of ['detail', 'put']) {
  test(`LAZY-SNAPSHOT-FAIL: ${failure} сохраняет единственную свежую копию ответа`, async (t) => {

    const original = sampleChat('snapshot-failed', { updatedAt: 100 });

    const world = await serverWorld(t, [original]);

    const snapshot = {
      sessions: [{
        ...original,
        updatedAt: 200,
        messages: [...original.messages,
      {
        role: 'assistant',
        text: 'Единственная копия',
        pid: 'saved-only01',
      }],
      }],
      archived: [],
    };

    const storage = memoryStorage(t, { [SNAPSHOT_KEY]: JSON.stringify(snapshot) });

    const network = (await import('./helpers/chat-lazy.js')).windowApi(world.app);

    const method = failure === 'detail' ? 'get' : 'put';

    const request = network.api[method];

    let failed = false;

    network.api[method] = async (url, body) => {
      if (url.startsWith(DETAIL) || method === 'put' && url === '/api/chat/store/chat') {
        failed = true;

        throw new TypeError('Синтетический отказ восстановления');
      }

      return request(url, body);
    };

    const { chat } = await world.open(network);

    await waitFor(() => failed, { what: `введённый отказ ${failure}` });
    chat._persist(true);
    await drain();

    const retained = JSON.parse(storage.values.get(SNAPSHOT_KEY));

    const copy = retained.sessions.find((session) => session.id === original.id);

    assert.equal(copy.messages.filter((message) => message.pid === 'saved-only01').length, 1);
  });
}
