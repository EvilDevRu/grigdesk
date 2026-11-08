// Проверяет ход ассистента в Telegram-пульте: очередь, ожидание и безопасную остановку.
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { TelegramPultActions } from '../../server/src/lib/telegram/pult/actions.ts';
import {
  encodePultOwnerKey,
  TelegramPultStateStore,
} from '../../server/src/lib/telegram/pult/stateStore.ts';
import { PultSendQueue } from '../../server/src/lib/telegram/pult/sendQueue.ts';
import * as pultFormat from '../../server/src/lib/telegram/pult/format.ts';

const OWNER = 555001;
const NOW = Date.UTC(2026, 7, 22, 10, 0, 0);
const silent = { warn() {}, error() {}, info() {}, debug() {} };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork() {
  // Durable marker делает fsync файла и каталога. Несколько микротиков не дают
  // libuv дождаться fs I/O и превращают верный неблокирующий handler в ложный красный.
  await delay(40);
  for (let index = 0; index < 12; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Не дождались: ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function beginTurn(fixtureValue, msg) {
  const delivery = fixtureValue.deliver(msg);
  await waitFor(
    () => fixtureValue.calls.some((call) => call.method === 'POST' && call.url === '/api/chat'),
    'запуск model POST',
  );
  return { delivery };
}

const message = (text, over = {}) => ({
  chatId: OWNER,
  chatType: 'private',
  messageId: 10,
  replyToMessageId: null,
  replyToFromId: null,
  from: { id: OWNER, name: 'Владелец', username: '' },
  text,
  media: [],
  ...over,
});

/**
 * Создаёт изолированный пульт с управляемым ответом модели.
 * Перед удалением состояния завершает собственные фоновые ходы и durable-записи.
 */
async function fixture(t, {
  speechRuntime = null,
  staleSaves = 0,
  providerModel = null,
  chatAutoCompact = true,
  compactWindow = 0,
  compactResponse = null,
  initiallyBusy = false,
  readPollStatus = () => null,
  editFailure = null,
} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'telegram-pult-assistant-'));
  const model = deferred();
  let actions = null;
  let store = null;

  t.after(async () => {
    actions?.stop();
    model.resolve({ statusCode: 200, body: { stopped: true, reply: 'Остановлено' } });

    const assistant = actions?.assistant;

    while (assistant?.background.size) {
      await Promise.allSettled([...assistant.background]);
    }

    await store?.queue;
    await rm(dir, { recursive: true, force: true });
  });

  const calls = [];
  const botCalls = [];
  let remainingStaleSaves = staleSaves;
  let active = initiallyBusy;
  let sseListener = null;
  let record = {
    schema: 2,
    revision: 1,
    id: 'server-owned-companion',
    title: 'Компаньон',
    purpose: 'companion',
    taskId: null,
    logicalIdentity: 'companion:global',
    messages: [],
    model: 'claude-test',
    modelRef: { provider: 'claude', model: 'claude-test' },
    effort: 'high',
    sessionId: 'session-before',
  };
  const callApi = async (method, url, payload) => {
    calls.push({ method, url, payload: structuredClone(payload) });
    if (method === 'POST' && url === '/api/chat/store/ensure') {
      return { statusCode: 200, body: { chat: structuredClone(record), created: false, restored: false } };
    }
    if (method === 'GET' && url === `/api/chat/store/chat/${record.id}`) {
      return { statusCode: 200, body: { chat: structuredClone(record) } };
    }
    if (method === 'PUT' && url === '/api/chat/store/chat') {
      record = { ...structuredClone(payload.chat), revision: record.revision + 1 };
      const stale = remainingStaleSaves > 0;
      if (stale) remainingStaleSaves -= 1;
      return { statusCode: 200, body: { ok: true, stale, revision: record.revision } };
    }
    if (method === 'GET' && url === '/api/providers') {
      return {
        statusCode: 200,
        body: {
          providers: [{
            id: 'claude', available: true, chatEnabled: true,
            capabilities: { chatAutoCompact },
            modes: [{ id: 'auto' }],
            models: [providerModel || { id: 'claude-test', context: 1_000_000 }],
          }],
        },
      };
    }
    if (method === 'GET' && url === '/api/chat/active') {
      return {
        statusCode: 200,
        body: { runs: active ? [{ chatKey: 'server-owned-companion' }] : [] },
      };
    }
    if (method === 'POST' && url === '/api/chat') return model.promise;
    if (method === 'POST' && url === '/api/chat/compact') {
      return compactResponse || {
        statusCode: 200,
        body: { compaction: { kind: 'summary', text: 'Краткая память' } },
      };
    }
    if (method === 'POST' && url === '/api/chat/session/reset') {
      return { statusCode: 200, body: { ok: true } };
    }
    if (method === 'POST' && url === '/api/chat/stop') {
      return { statusCode: 200, body: { ok: true } };
    }
    return { statusCode: 404, body: { error: 'not_found' } };
  };

  store = new TelegramPultStateStore({
    file: path.join(dir, 'pult-state.json'),
    log: silent,
  });

  const context = {
    botId: '8123456789',
    credentials: { token: '8123456789:test-token' },
    botApi: {
      callBotApi: async (_token, method, body) => {
        const result = { message_id: 101 + botCalls.length };
        botCalls.push({ method, body, result });
        if (method === 'editMessageText' && editFailure) throw editFailure;
        return result;
      },
      sendChatAction: async (_token, chatId, action) => {
        botCalls.push({ method: 'sendChatAction', body: { chat_id: chatId, action } });
        return true;
      },
      getFile: async () => ({ fileId: 'voice-1', filePath: 'voice/file.oga', size: 12 }),
      downloadFile: async () => Buffer.from('fake-voice'),
    },
    botSettings: {
      read: async () => ({
        pultChatId: OWNER,
        pultUserId: OWNER,
        pultConfirmedAtMs: NOW,
      }),
    },
  };
  const lease = () => ({
    accountRef: 'acc_test',
    generation: 1,
    context,
    isCurrent: () => true,
    release: async () => {},
  });

  actions = new TelegramPultActions({
    isEnabled: () => true,
    callApi,
    stateStoreFor: () => store,
    acquireLease: lease,
    speechRuntime,
    readSpeechPrefs: () => ({ quality: 'fast', model: 'small' }),
    readCompactWindow: () => compactWindow,
    readPollStatus,
    subscribe: (listener) => {
      sseListener = listener;
      return () => { sseListener = null; };
    },
    queue: new PultSendQueue({ pauseMs: 0 }),
    now: () => NOW,
    log: silent,
  });
  return {
    actions,
    store,
    calls,
    botCalls,
    model,
    record: () => structuredClone(record),
    seedMessages: (messages) => { record.messages = structuredClone(messages); },
    patchRecord: (patch) => { record = { ...record, ...structuredClone(patch) }; },
    setActive: (value) => { active = value; },
    emit: (event, data) => sseListener?.(event, data),
    deliver: async (msg) => {
      const held = lease();
      try { await actions.onMessage(msg, 'message', held); } finally { await held.release(); }
    },
    tap: async (data, over = {}) => {
      const held = lease();
      try {
        await actions.onCallback({
          id: 'cb-agent', data,
          from: { id: OWNER, name: 'Владелец', username: '' },
          chatId: OWNER, chatType: 'private', messageId: 77,
          ...over,
        }, held);
      } finally { await held.release(); }
    },
  };
}

test('свободный текст принимает тот же server-owned global companion', async (t) => {
  const f = await fixture(t);
  const { delivery } = await beginTurn(f, message('Проверь, почему встал конвейер'));
  const ensure = f.calls.find((call) => call.url === '/api/chat/store/ensure')?.payload;
  f.model.resolve({ statusCode: 200, body: { reply: 'Готово', sessionId: 'session-after' } });
  await delivery;
  await flushAsyncWork();
  assert.deepEqual({
    purpose: ensure?.purpose,
    taskId: ensure?.taskId,
    hasServerOrigin: typeof ensure?.origin === 'string' && ensure.origin.length > 0,
  }, { purpose: 'companion', taskId: null, hasServerOrigin: true });
});

test('обычный ход уходит в auto без companionTurn и обхода разрешений', async (t) => {
  const f = await fixture(t);
  const { delivery } = await beginTurn(f, message('Посмотри состояние'));
  const request = f.calls.find((call) => call.method === 'POST' && call.url === '/api/chat')?.payload;
  f.model.resolve({ statusCode: 200, body: { reply: 'Готово', sessionId: 'session-after' } });
  await delivery;
  await flushAsyncWork();
  assert.deepEqual({
    chatKey: request?.chatKey,
    mode: request?.mode,
    companionTurn: Object.hasOwn(request || {}, 'companionTurn'),
    dontAsk: Object.hasOwn(request || {}, 'dontAsk'),
    bypassPermissions: Object.hasOwn(request || {}, 'bypassPermissions'),
  }, {
    chatKey: 'server-owned-companion',
    mode: 'auto',
    companionTurn: false,
    dontAsk: false,
    bypassPermissions: false,
  });
});

test('обработчик сообщения возвращается до завершения модельного POST', async (t) => {
  const f = await fixture(t);
  let handlerReturned = false;
  const delivery = f.deliver(message('Долгий вопрос'));
  delivery.then(() => { handlerReturned = true; });
  await waitFor(() => f.calls.some((call) => call.url === '/api/chat'), 'запуск model POST');
  await waitFor(() => handlerReturned, 'возврат onMessage до ответа модели');
  const modelStarted = f.calls.some((call) => call.url === '/api/chat');
  const returnedBeforeModel = handlerReturned;
  f.model.resolve({ statusCode: 200, body: { reply: 'Ответ' } });
  await delivery;
  await flushAsyncWork();
  assert.deepEqual({ modelStarted, returnedBeforeModel }, {
    modelStarted: true,
    returnedBeforeModel: true,
  });
});

test('прямой ответ обгоняет ожидающие фоновые карточки в общей очереди', async () => {
  const queue = new PultSendQueue({ pauseMs: 0 });
  const held = deferred();
  const order = [];
  const running = queue.push(async () => {
    order.push('running-background');
    await held.promise;
  }, { priority: 'background' });
  const background = queue.push(async () => {
    order.push('waiting-background');
  }, { priority: 'background' });
  const interactive = queue.push(async () => {
    order.push('interactive');
  }, { priority: 'interactive' });

  held.resolve();
  await Promise.all([running, background, interactive]);
  assert.deepEqual(order, ['running-background', 'interactive', 'waiting-background']);
});

test('готовый ответ ждёт восстановления известного сбоя poll и не тратит sendMessage', async (t) => {
  let unavailable = true;
  const f = await fixture(t, {
    readPollStatus: () => ({
      running: true,
      lastError: unavailable ? { code: 'poll_unreachable' } : null,
    }),
  });
  const { delivery } = await beginTurn(f, message('Дождись Telegram'));
  f.model.resolve({ statusCode: 200, body: { reply: 'Сеть вернулась' } });
  await waitFor(
    () => f.record().messages.some((item) => item.role === 'assistant'),
    'сохранение готового ответа',
  );
  const sentWhileUnavailable = f.botCalls.some((call) => (
    call.method === 'sendMessage' && call.body.text === 'Сеть вернулась'
  ));

  unavailable = false;
  await delivery;
  await waitFor(
    () => f.botCalls.some((call) => (
      call.method === 'sendMessage' && call.body.text === 'Сеть вернулась'
    )),
    'отправка после восстановления poll',
  );
  assert.equal(sentWhileUnavailable, false);
});

test('занятый web-ход ждётся без Стопа, а новый ход берёт его свежую сессию', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t, { initiallyBusy: true });
  const delivery = f.deliver(message('Ответь после web-хода'));
  await waitFor(
    () => f.calls.filter((call) => call.url === '/api/chat/active').length >= 2,
    'переход в очередь за web-ходом',
  );
  await delivery;
  t.mock.timers.tick(30_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual({
    modelCalls: f.calls.filter((call) => call.url === '/api/chat').length,
    savedMessages: f.record().messages.length,
    stopMessages: f.botCalls.filter((call) => /Стоп|Остановить/iu.test(String(call.body.text))).length,
  }, { modelCalls: 0, savedMessages: 0, stopMessages: 0 });

  f.patchRecord({ sessionId: 'session-after-web' });
  f.setActive(false);
  t.mock.timers.tick(1_000);
  await waitFor(() => f.calls.some((call) => call.url === '/api/chat'), 'запуск после web-хода');
  const request = f.calls.find((call) => call.url === '/api/chat').payload;
  f.model.resolve({ statusCode: 200, body: { reply: 'Ответ' } });
  await flushAsyncWork();
  assert.deepEqual({ sessionId: request.sessionId, savedMessages: f.record().messages[0]?.text }, {
    sessionId: 'session-after-web',
    savedMessages: 'Ответь после web-хода',
  });
});

test('события прогресса и шагов не создают сообщений в переписке', async (t) => {
  const f = await fixture(t);
  const { delivery } = await beginTurn(f, message('Долгий вопрос без ленты'));
  f.emit('chat-progress', { chatKey: 'server-owned-companion', tokens: 12_400 });
  f.emit('chat-step', {
    chatKey: 'server-owned-companion',
    step: { k: 'tool', id: 'edit-1', name: 'Edit', files: ['src/app.js'] },
  });
  const duringTurn = {
    conversationMessages: f.botCalls.filter((call) => (
      ['sendMessage', 'editMessageText'].includes(call.method)
    )).length,
    typing: f.botCalls.filter((call) => (
      call.method === 'sendChatAction' && call.body.action === 'typing'
    )).length > 0,
  };
  f.model.resolve({ statusCode: 200, body: { reply: 'Ответ' } });
  await delivery;
  await flushAsyncWork();
  assert.deepEqual(duringTurn, { conversationMessages: 0, typing: true });
});

test('Стоп появляется на границе 30 секунд и останавливает exact chatKey', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  const { delivery } = await beginTurn(f, message('Очень долгий вопрос'));
  t.mock.timers.tick(29_999);
  await flushAsyncWork();
  const stopBeforeBoundary = f.botCalls.some((call) => /Стоп|Остановить/iu.test(String(call.body.text)));
  t.mock.timers.tick(1);
  await flushAsyncWork();
  const stop = f.botCalls.find((call) => /Стоп|Остановить/iu.test(String(call.body.text)));
  const data = stop?.body.reply_markup?.inline_keyboard?.flat()?.[0]?.callback_data;
  if (typeof data === 'string') await f.tap(data, { messageId: stop.result.message_id });
  const stopCalls = f.calls.filter((call) => call.url === '/api/chat/stop').map((call) => call.payload);
  f.model.resolve({ statusCode: 200, body: { reply: 'Остановлено', stopped: true } });
  await delivery;
  await flushAsyncWork();
  assert.deepEqual({ stopBeforeBoundary, stopShown: typeof data === 'string', stopCalls }, {
    stopBeforeBoundary: false,
    stopShown: true,
    stopCalls: [{ chatKey: 'server-owned-companion' }],
  });
});

test('финальный ответ безопасно заменяет сообщение Стоп без нового sendMessage', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  const { delivery } = await beginTurn(f, message('Долгий вопрос с ответом'));
  t.mock.timers.tick(30_000);
  await flushAsyncWork();
  const stop = f.botCalls.find((call) => /Стоп|Остановить/iu.test(String(call.body.text)));
  f.model.resolve({ statusCode: 200, body: { reply: 'Финальный ответ' } });
  await delivery;
  await flushAsyncWork();
  const lifecycle = f.botCalls.filter((call) => (
    call.method === 'deleteMessage' || /Финальный ответ/iu.test(String(call.body.text))
  )).map((call) => call.method);
  assert.deepEqual({ stopShown: Boolean(stop), lifecycle }, {
    stopShown: true,
    lifecycle: ['editMessageText'],
  });
});

test('неопределённый ответ правки не дублирует уже обновлённое сообщение Стоп', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t, {
    editFailure: Object.assign(new Error('Bad Request: message is not modified'), {
      kind: 'telegram',
      status: 400,
    }),
  });
  const { delivery } = await beginTurn(f, message('Долгий вопрос с оборванной правкой'));
  t.mock.timers.tick(30_000);
  await flushAsyncWork();
  f.model.resolve({ statusCode: 200, body: { reply: 'Уже доставлено' } });
  await delivery;
  await flushAsyncWork();
  assert.deepEqual({
    edits: f.botCalls.filter((call) => call.method === 'editMessageText').length,
    duplicateSends: f.botCalls.filter((call) => (
      call.method === 'sendMessage' && call.body.text === 'Уже доставлено'
    )).length,
    turns: (await f.store.read()).turns,
  }, {
    edits: 1,
    duplicateSends: 0,
    turns: [],
  });
});

test('slash-опечатка не создаёт платный ход ассистента', async (t) => {
  const f = await fixture(t);
  await f.deliver(message('   /помгите'));
  assert.deepEqual({
    chatCalls: f.calls.filter((call) => call.url.startsWith('/api/chat')).length,
    hints: f.botCalls.filter((call) => (
      call.method === 'sendMessage'
      && /не понял|команд|помощ/iu.test(String(call.body.text))
    )).length,
  }, { chatCalls: 0, hints: 1 });
});

test('завершённый ход делает свою кнопку Стоп неактивной', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  const { delivery } = await beginTurn(f, message('Долгий ход с устаревающей кнопкой'));
  t.mock.timers.tick(30_000);
  await flushAsyncWork();
  const stop = f.botCalls.find((call) => /Стоп|Остановить/iu.test(String(call.body.text)));
  const data = stop?.body.reply_markup?.inline_keyboard?.flat()?.[0]?.callback_data;
  f.model.resolve({ statusCode: 200, body: { reply: 'Ход завершён' } });
  await delivery;
  await flushAsyncWork();
  const apiBefore = f.calls.length;
  const botBefore = f.botCalls.length;
  if (typeof data === 'string') await f.tap(data, { messageId: stop.result.message_id });
  assert.deepEqual({
    stopShown: typeof data === 'string',
    stopCalls: f.calls.slice(apiBefore).filter((call) => call.url === '/api/chat/stop').length,
    botCalls: f.botCalls.length - botBefore,
  }, { stopShown: true, stopCalls: 0, botCalls: 0 });
});

test('отказ chat со статусом 5xx закрывает typing и Стоп одним видимым сообщением', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  const { delivery } = await beginTurn(f, message('Ход с серверным отказом'));
  t.mock.timers.tick(30_000);
  await flushAsyncWork();
  f.model.resolve({ statusCode: 503, body: { error: 'chat_failed', message: 'Исполнитель недоступен' } });
  await delivery;
  await flushAsyncWork();
  const typingAfterSettle = f.botCalls.filter((call) => call.method === 'sendChatAction').length;
  t.mock.timers.tick(8_000);
  await flushAsyncWork();
  assert.deepEqual({
    deletedStop: f.botCalls.filter((call) => call.method === 'deleteMessage').length,
    visibleErrors: f.botCalls.filter((call) => (
      ['sendMessage', 'editMessageText'].includes(call.method)
      && /ошиб|не удал|недоступ|сбой/iu.test(String(call.body.text))
    )).length,
    typingStopped: f.botCalls.filter((call) => call.method === 'sendChatAction').length === typingAfterSettle,
  }, { deletedStop: 0, visibleErrors: 1, typingStopped: true });
});

test('транспортный сбой chat закрывает typing и Стоп одним видимым сообщением', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  const { delivery } = await beginTurn(f, message('Ход с обрывом inject'));
  t.mock.timers.tick(30_000);
  await flushAsyncWork();
  if (f.calls.some((call) => call.url === '/api/chat')) {
    f.model.reject(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }));
  }
  await delivery.catch(() => {});
  await flushAsyncWork();
  const typingAfterSettle = f.botCalls.filter((call) => call.method === 'sendChatAction').length;
  t.mock.timers.tick(8_000);
  await flushAsyncWork();
  assert.deepEqual({
    deletedStop: f.botCalls.filter((call) => call.method === 'deleteMessage').length,
    visibleErrors: f.botCalls.filter((call) => (
      ['sendMessage', 'editMessageText'].includes(call.method)
      && /ошиб|не удал|связ|сбой/iu.test(String(call.body.text))
    )).length,
    typingStopped: f.botCalls.filter((call) => call.method === 'sendChatAction').length === typingAfterSettle,
  }, { deletedStop: 0, visibleErrors: 1, typingStopped: true });
});

test('итог хода считает файлы только после успешного tool-result и приклеивается к ответу', async (t) => {
  const f = await fixture(t);
  const { delivery } = await beginTurn(f, message('Измени два файла'));
  f.emit('chat-progress', { chatKey: 'server-owned-companion', tokens: 12_400 });
  f.emit('chat-step', {
    chatKey: 'server-owned-companion',
    step: {
      k: 'tool',
      id: 'edit-1',
      name: 'Edit',
      files: ['src/a.js', 'src/b.js'],
    },
  });
  f.emit('chat-step', {
    chatKey: 'server-owned-companion',
    step: {
      k: 'res',
      id: 'edit-1',
      ok: true,
    },
  });
  f.emit('chat-step', {
    chatKey: 'server-owned-companion',
    step: { k: 'tool', id: 'edit-2', name: 'Write', files: ['src/failed.js'] },
  });
  f.emit('chat-step', {
    chatKey: 'server-owned-companion',
    step: { k: 'res', id: 'edit-2', ok: false },
  });
  f.model.resolve({ statusCode: 200, body: { reply: 'Готово' } });
  await delivery;
  await flushAsyncWork();
  assert.deepEqual(f.botCalls.filter((call) => (
    call.method === 'sendMessage' && /Готово/iu.test(String(call.body.text))
  )).map((call) => call.body.text), ['Готово\n\n— 2 файла · 12.4k ток.']);
});

test('процент контекста считается от свежего порога сжатия', async (t) => {
  const f = await fixture(t, { compactWindow: 200_000 });
  const { delivery } = await beginTurn(f, message('Проверь контекст'));
  f.model.resolve({ statusCode: 200, body: { reply: 'Ответ', contextTokens: 165_172 } });
  await delivery;
  await waitFor(
    () => f.botCalls.some((call) => call.method === 'sendMessage' && /контекст 83%/u.test(call.body.text)),
    'итог с контекстом 83%',
  );
});

test('без автосжатия процент считается от 80% проверенного окна', async (t) => {
  const f = await fixture(t, { compactWindow: 0 });
  const { delivery } = await beginTurn(f, message('Проверь контекст без автосжатия'));
  f.model.resolve({ statusCode: 200, body: { reply: 'Ответ', contextTokens: 165_172 } });
  await delivery;
  await waitFor(
    () => f.botCalls.some((call) => call.method === 'sendMessage' && /контекст 21%/u.test(call.body.text)),
    'итог с контекстом 21%',
  );
});

test('исполнитель без поддержки настройки считает процент от окна', async (t) => {
  const f = await fixture(t, { compactWindow: 100_000, chatAutoCompact: false });
  const { delivery } = await beginTurn(f, message('Проверь контекст'));
  f.model.resolve({ statusCode: 200, body: { reply: 'Ответ', contextTokens: 165_172 } });
  await delivery;
  await waitFor(
    () => f.botCalls.some((call) => call.method === 'sendMessage' && /контекст 21%/u.test(call.body.text)),
    'запас до границы окна вместо неподдерживаемого автосжатия',
  );
});

test('недоступный итоговый контекст не откатывается к старому живому замеру', async (t) => {
  const f = await fixture(t, { compactWindow: 100_000 });
  const { delivery } = await beginTurn(f, message('Проверь сжатый контекст'));
  f.emit('chat-progress', {
    chatKey: f.record().id, tokens: 50, contextTokens: 150_000,
    contextWindow: 1_000_000, contextMetric: 'active-input-v1',
  });
  f.model.resolve({
    statusCode: 200,
    body: { reply: 'Контекст обновлён.', contextTokens: 0, contextMetric: 'unavailable' },
  });
  await delivery;
  await waitFor(
    () => f.botCalls.some((call) => (
      call.method === 'sendMessage' && /Контекст обновлён/u.test(call.body.text)
    )),
    'итог без устаревшего предупреждения',
  );
  const answer = f.botCalls.find((call) => (
    call.method === 'sendMessage' && /Контекст обновлён/u.test(call.body.text)
  ));
  assert.doesNotMatch(answer.body.text, /контекст \d+%|Контекст достиг/u);
});

test('окно фактического хода сильнее каталога модели', async (t) => {
  const f = await fixture(t, { compactWindow: 0 });
  const { delivery } = await beginTurn(f, message('Проверь runtime window'));
  f.model.resolve({
    statusCode: 200,
    body: { reply: 'Ответ', contextTokens: 80_000, contextWindow: 200_000 },
  });
  await delivery;
  await waitFor(
    () => f.botCalls.some((call) => call.method === 'sendMessage' && /контекст 50%/u.test(call.body.text)),
    'итог с runtime window',
  );
});

test('непроверенное окно каталога не даёт процент и кнопку сжатия', async (t) => {
  const f = await fixture(t, {
    compactWindow: 100_000,
    providerModel: { id: 'claude-test', context: 1_000_000, contextUnverified: true },
  });
  const { delivery } = await beginTurn(f, message('Проверь неизвестное окно'));
  f.model.resolve({ statusCode: 200, body: { reply: 'Ответ', contextTokens: 120_000 } });
  await delivery;
  await waitFor(
    () => f.botCalls.some((call) => call.method === 'sendMessage' && call.body.text === 'Ответ'),
    'ответ без выдуманного процента',
  );
  const sent = f.botCalls.find((call) => call.method === 'sendMessage' && call.body.text === 'Ответ');
  assert.equal(sent.body.reply_markup, undefined);
});

test('достигнутый порог добавляет предупреждение и кнопку «Сжать»', async (t) => {
  const f = await fixture(t, { compactWindow: 200_000 });
  const { delivery } = await beginTurn(f, message('Пора сжимать'));
  f.model.resolve({ statusCode: 200, body: { reply: 'Ответ', contextTokens: 200_000 } });
  await delivery;
  await waitFor(
    () => f.botCalls.some((call) => (
      call.method === 'sendMessage' && /Контекст достиг порога/iu.test(call.body.text)
    )),
    'предупреждение о сжатии',
  );
  const sent = f.botCalls.find((call) => /контекст 100%/u.test(String(call.body.text)));
  assert.equal(callbackByText(sent?.body.reply_markup?.inline_keyboard, '🗜 Сжать')?.startsWith('ac:'), true);
});

test('точная подпись постоянной клавиатуры разбирается до ветки чата', async (t) => {
  const f = await fixture(t);
  for (const [index, text] of ['📋 Конвейер', '💬 Агент', '📥 Задачи', '⚙️ Ещё'].entries()) {
    await f.deliver(message(text, { messageId: 20 + index }));
  }
  assert.deepEqual({
    chatCalls: f.calls.filter((call) => call.url.startsWith('/api/chat')).length,
    screenMethods: f.botCalls.map((call) => call.method),
  }, {
    chatCalls: 0,
    screenMethods: ['sendMessage', 'editMessageText', 'editMessageText', 'editMessageText'],
  });
});

test('почти совпавшая подпись остаётся свободным текстом', async (t) => {
  const f = await fixture(t);
  const { delivery } = await beginTurn(f, message('💬 Агент '));
  const ensured = f.calls.some((call) => call.url === '/api/chat/store/ensure');
  f.model.resolve({ statusCode: 200, body: { reply: 'Ответ' } });
  await delivery;
  await flushAsyncWork();
  assert.equal(ensured, true);
});

test('реплай владельца на собственное сообщение остаётся свободным текстом', async (t) => {
  const f = await fixture(t);
  const { delivery } = await beginTurn(f, message('Продолжай', {
    replyToMessageId: 9,
    replyToFromId: OWNER,
  }));
  const ensured = f.calls.some((call) => call.url === '/api/chat/store/ensure');
  f.model.resolve({ statusCode: 200, body: { reply: 'Продолжаю' } });
  await delivery;
  await flushAsyncWork();
  assert.equal(ensured, true);
});

test('ответ ассистента сохраняется рядом с пользовательской репликой', async (t) => {
  const f = await fixture(t);
  const { delivery } = await beginTurn(f, message('Сохрани этот вопрос'));
  f.model.resolve({
    statusCode: 200,
    body: { reply: 'Сохранил', sessionId: 'session-after', contextTokens: 100 },
  });
  await delivery;
  await flushAsyncWork();
  assert.deepEqual(f.record().messages.map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: 'Сохрани этот вопрос' },
    { role: 'assistant', text: 'Сохранил' },
  ]);
});

test('stale CAS до model POST повторяет точечное сохранение со свежей revision', async (t) => {
  const f = await fixture(t, { staleSaves: 1 });
  const { delivery } = await beginTurn(f, message('Сохрани без потерь'));
  const savesBeforeModel = f.calls
    .slice(0, f.calls.findIndex((call) => call.url === '/api/chat'))
    .filter((call) => call.method === 'PUT' && call.url === '/api/chat/store/chat');
  f.model.resolve({ statusCode: 200, body: { reply: 'Сохранил' } });
  await delivery;
  await flushAsyncWork();
  assert.deepEqual({
    revisions: savesBeforeModel.map((call) => call.payload.chat.revision),
    modelCalls: f.calls.filter((call) => call.url === '/api/chat').length,
  }, {
    revisions: [1, 2],
    modelCalls: 1,
  });
});

function restartTurn(over = {}) {
  return {
    id: 'trestart',
    ownerKey: encodePultOwnerKey('acc_test', NOW, OWNER),
    chatId: OWNER,
    chatKey: 'server-owned-companion',
    acceptedAt: NOW,
    startedAt: NOW,
    phase: 'started',
    stopMessageId: 77,
    ...over,
  };
}

test('боевой onReady не ждёт сверку через внутренний Fastify inject', async () => {
  // actions.start() внутри вызывает /api/chat/active через fastify.inject. Если ждать
  // этот Promise в onReady, inject ждёт тот же onReady и сервер падает по hook timeout.
  const source = await readFile(new URL('../../server/src/app.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /await\s+telegramPult\??\.?actions\??\.?start\(\)/u);
  assert.match(source, /void\s+telegramPult\??\.?actions\??\.?start\(\)\.catch/u);
});

test('маркер без active-хода после рестарта убирает Стоп и один раз просит повторить вопрос', async (t) => {
  const f = await fixture(t);

  await f.store.write({ turns: [restartTurn()] });
  await f.actions.start();
  assert.deepEqual({
    turns: (await f.store.read()).turns,
    methods: f.botCalls.map((call) => call.method),
    warning: f.botCalls.filter((call) => /restart|перезапуск|repeat|повтори/iu.test(String(call.body.text))).length,
    modelCalls: f.calls.filter((call) => call.url === '/api/chat').length,
  }, {
    turns: [],
    methods: ['deleteMessage', 'sendMessage'],
    warning: 1,
    modelCalls: 0,
  });
});

test('живой active-ход после рестарта только наблюдается и чистится по chat-done', async (t) => {
  const f = await fixture(t, { initiallyBusy: true });
  await f.store.write({ turns: [restartTurn()] });
  await f.actions.start();
  assert.deepEqual({
    phase: (await f.store.read()).turns[0]?.phase,
    botCalls: f.botCalls.length,
    modelCalls: f.calls.filter((call) => call.url === '/api/chat').length,
  }, { phase: 'observing', botCalls: 0, modelCalls: 0 });
  f.emit('chat-done', { chatKey: 'server-owned-companion' });
  await flushAsyncWork();
  assert.deepEqual({
    turns: (await f.store.read()).turns,
    deletes: f.botCalls.filter((call) => call.method === 'deleteMessage').length,
  }, { turns: [], deletes: 1 });
});

test('accepted-marker не присваивает себе чужой active-ход того же чата', async (t) => {
  const f = await fixture(t, { initiallyBusy: true });
  await f.store.write({ turns: [restartTurn({ phase: 'accepted', startedAt: null, stopMessageId: null })] });
  await f.actions.start();
  assert.deepEqual({
    turns: (await f.store.read()).turns,
    warning: f.botCalls.filter((call) => /повтори вопрос/iu.test(String(call.body.text))).length,
    modelCalls: f.calls.filter((call) => call.url === '/api/chat').length,
  }, { turns: [], warning: 1, modelCalls: 0 });
});

test('voice распознаётся в том же ходе без отдельного сообщения с расшифровкой', async (t) => {
  const transcriptions = [];
  const speechRuntime = {
    transcribe: async (options) => {
      transcriptions.push(options);
      return { transcript: { text: 'проверь конвейер' } };
    },
  };
  const f = await fixture(t, { speechRuntime });
  const { delivery } = await beginTurn(f, message('', {
    media: [{ kind: 'voice', fileId: 'voice-1', size: 12, mime: 'audio/ogg' }],
  }));
  f.model.resolve({ statusCode: 200, body: { reply: 'Проверил' } });
  await delivery;
  await flushAsyncWork();
  const workDir = transcriptions[0]?.workDir;
  let tempRemoved = false;
  if (workDir) {
    try { await access(workDir); } catch { tempRemoved = true; }
  }
  assert.deepEqual({
    transcriptions: transcriptions.length,
    ensureCalls: f.calls.filter((call) => call.url === '/api/chat/store/ensure').length,
    transcriptMessages: f.botCalls.filter((call) => /услышал:/iu.test(String(call.body.text))).length,
    tempRemoved,
  }, {
    transcriptions: 1,
    ensureCalls: 1,
    transcriptMessages: 1,
    tempRemoved: true,
  });
});

function callbackByText(rows, text) {
  return (rows || []).flat().find((button) => button.text === text)?.callback_data;
}

test('сжатие вызывает существующую ручку и сохраняет историю сообщений', async (t) => {
  const f = await fixture(t);
  const before = [
    { role: 'user', text: 'первый вопрос' },
    { role: 'assistant', text: 'первый ответ' },
  ];
  f.seedMessages(before);
  f.patchRecord({
    contextTokens: 90_000,
    contextWindow: 200_000,
    contextMetric: 'active-input-v1',
    contextIsEstimate: true,
    totalInputTokens: 120_000,
    cachedInputTokens: 30_000,
    contextCache: { used: 1 },
  });
  const data = callbackByText(pultFormat.agentKeyboard?.(), '🗜 Сжать');
  await f.tap(data);
  await waitFor(() => f.record().pendingSeed === 'Краткая память', 'сохранение выжимки');
  const after = f.record();
  assert.deepEqual({
    callbackType: typeof data,
    calls: f.calls.filter((call) => call.url === '/api/chat/compact').map((call) => call.payload),
    messages: after.messages,
    memory: {
      pendingSeed: after.pendingSeed,
      sessionId: after.sessionId,
      contextTokens: after.contextTokens,
      contextWindow: after.contextWindow,
      contextMetric: after.contextMetric,
      contextIsEstimate: after.contextIsEstimate,
      totalInputTokens: after.totalInputTokens,
      cachedInputTokens: after.cachedInputTokens,
      contextCache: after.contextCache,
    },
  }, {
    callbackType: 'string',
    calls: [{
      chatKey: 'server-owned-companion',
      model: 'claude-test',
      modelRef: { provider: 'claude', model: 'claude-test' },
      effort: 'high',
      sessionId: 'session-before',
      mode: 'auto',
    }],
    messages: before,
    memory: {
      pendingSeed: 'Краткая память',
      sessionId: null,
      contextTokens: 0,
      contextWindow: 0,
      contextMetric: '',
      contextIsEstimate: false,
      totalInputTokens: 0,
      cachedInputTokens: 0,
      contextCache: null,
    },
  });
});

test('native compact сохраняет sessionId и буквально не трогает messages', async (t) => {
  const f = await fixture(t, {
    compactResponse: { statusCode: 200, body: { compact: { kind: 'native' } } },
  });
  const before = [{ role: 'user', text: 'история останется' }];
  f.seedMessages(before);
  f.patchRecord({ contextTokens: 80_000, contextWindow: 200_000 });
  const data = callbackByText(pultFormat.agentKeyboard?.(), '🗜 Сжать');
  await f.tap(data);
  await waitFor(() => Number(f.record().compactedAt) > 0, 'native compact');
  assert.deepEqual({
    messages: f.record().messages,
    sessionId: f.record().sessionId,
    contextTokens: f.record().contextTokens,
    contextWindow: f.record().contextWindow,
  }, {
    messages: before,
    sessionId: 'session-before',
    contextTokens: 0,
    contextWindow: 0,
  });
});

test('остановленное Kimi-сжатие с sessionReset чистит сессию, но не историю', async (t) => {
  const f = await fixture(t, {
    compactResponse: { statusCode: 200, body: { stopped: true, sessionReset: true } },
  });
  const before = [{ role: 'assistant', text: 'не удаляй' }];
  f.seedMessages(before);
  f.patchRecord({ contextTokens: 80_000, contextWindow: 200_000 });
  const data = callbackByText(pultFormat.agentKeyboard?.(), '🗜 Сжать');
  await f.tap(data);
  await waitFor(
    () => f.botCalls.some((call) => /сессия сброшена/iu.test(String(call.body.text))),
    'итог остановленного сжатия',
  );
  assert.deepEqual({
    messages: f.record().messages,
    sessionId: f.record().sessionId,
    contextTokens: f.record().contextTokens,
    contextWindow: f.record().contextWindow,
  }, {
    messages: before,
    sessionId: null,
    contextTokens: 0,
    contextWindow: 0,
  });
});

test('сброс памяти всегда вызывает session reset и буквально сохраняет messages', async (t) => {
  const f = await fixture(t);
  const before = [{ role: 'user', text: 'не стирай историю' }];
  f.seedMessages(before);
  const data = callbackByText(pultFormat.agentKeyboard?.(), '🧹 Сбросить память');
  await f.tap(data);
  assert.deepEqual({
    callbackType: typeof data,
    calls: f.calls.filter((call) => call.url === '/api/chat/session/reset').map((call) => call.payload),
    messages: f.record().messages,
  }, {
    callbackType: 'string',
    calls: [{
      chatKey: 'server-owned-companion',
      modelRef: { provider: 'claude', model: 'claude-test' },
    }],
    messages: before,
  });
});

test('фоновый chat-done не закрывает наблюдение за ходом пульта', async (t) => {
  const f = await fixture(t, { initiallyBusy: true });
  await f.store.write({ turns: [restartTurn()] });
  await f.actions.start();
  f.emit('chat-done', {
    chatKey: 'server-owned-companion',
    runId: 'run-bg',
    source: 'background',
  });
  await flushAsyncWork();
  assert.equal((await f.store.read()).turns[0]?.phase, 'observing');
  assert.equal(f.botCalls.filter((call) => call.method === 'deleteMessage').length, 0);
  f.emit('chat-done', { chatKey: 'server-owned-companion' });
  await flushAsyncWork();
  assert.deepEqual((await f.store.read()).turns, []);
  assert.equal(f.botCalls.filter((call) => call.method === 'deleteMessage').length, 1);
});

test('фоновые шаги и метрики не попадают в итог хода пульта', async (t) => {
  const f = await fixture(t);
  const { delivery } = await beginTurn(f, message('Измени два файла'));
  const chatKey = 'server-owned-companion';

  f.emit('chat-progress', { chatKey, tokens: 12_400 });
  f.emit('chat-step', {
    chatKey,
    step: { k: 'tool', id: 'edit-1', name: 'Edit', files: ['src/a.js', 'src/b.js'] },
  });
  f.emit('chat-step', { chatKey, step: { k: 'res', id: 'edit-1', ok: true } });

  const background = {
    chatKey,
    runId: 'run-bg',
    source: 'background',
  };

  f.emit('chat-progress', { ...background, tokens: 99_000 });
  f.emit('chat-step', {
    ...background,
    step: {
      k: 'tool',
      id: 'edit-bg',
      name: 'Edit',
      files: ['src/bg.js'],
    },
  });
  f.emit('chat-step', { ...background, step: {
    k: 'res',
    id: 'edit-bg',
    ok: true,
  } });
  f.model.resolve({ statusCode: 200, body: { reply: 'Готово' } });
  await delivery;
  await flushAsyncWork();

  const replies = f.botCalls.filter((call) => (
    call.method === 'sendMessage' && /Готово/u.test(call.body.text)
  ));

  assert.deepEqual(replies.map((call) => call.body.text), ['Готово\n\n— 2 файла · 12.4k ток.']);
});
