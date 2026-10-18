// Срез A телеграм-пульта: кнопки решений (план, §4/§5.3).
//
// Обещания:
//  - нажатие транслируется в ту же ручку, что жмёт браузер (gate/permission),
//    успех — answerCallbackQuery + карточка «✓»;
//  - отказы CAS (gate_not_current, attempt_terminal) доезжают словами, карточка
//    отражает фактическое состояние;
//  - `resumed:false` не глотается — «решение записано, но прогон не поехал»;
//  - отклонение с пояснением: ожидание реплая на конкретный message_id, TTL,
//    «без пояснения» — пустой comment;
//  - вопрос агента: вариант i уезжает в {answers}; протухший pid — «уже закрыт»;
//  - чужое нажатие — молча ноль вызовов (owner-гейт).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TelegramPultActions } from '../../server/src/lib/telegram/pult/actions.ts';
import { TelegramPultStateStore } from '../../server/src/lib/telegram/pult/stateStore.ts';
import { PultSendQueue } from '../../server/src/lib/telegram/pult/sendQueue.ts';
import {
  TelegramModuleCredentials,
  telegramModuleConnection,
} from './helpers/telegram-account-module.js';

const TOKEN = '8123456789:AAHrEaLLyLoNgSeCrEtPaRt_x1y2z3w4v5u6';
const BOT_ID = 8123456789;
const OWNER_CHAT = 555001;
const T0 = Date.UTC(2026, 7, 19, 10, 0, 0);
const silent = { warn() {}, error() {}, info() {}, debug() {} };

function fakeGrigDesk() {
  const calls = [];
  const routes = new Map();
  return {
    calls,
    set: (method, url, response) => routes.set(`${method} ${url}`, response),
    callApi: async (method, url, payload) => {
      calls.push({ method, url, payload });
      const canned = routes.get(`${method} ${url}`);
      if (!canned) return { statusCode: 404, body: { error: 'not_found' } };
      return typeof canned === 'function' ? canned(payload) : canned;
    },
  };
}

async function fixture(t, { confirmed = true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-pult-actions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const botCalls = [];
  let failDeletes = false;
  let failDeleteBatches = false;
  const botApi = {
    getMe: async () => ({ id: BOT_ID, username: 'example_pult_bot' }),
    callBotApi: async (token, method, body) => {
      botCalls.push({ method, body });
      if (failDeleteBatches && method === 'deleteMessages') {
        throw Object.assign(new Error('Bad Request: too many requests'), { kind: 'telegram' });
      }
      if (failDeletes && method === 'deleteMessage') {
        throw Object.assign(new Error('telegram down'), { kind: 'transport' });
      }
      return { message_id: 900 + botCalls.length };
    },
  };
  const creds = new TelegramModuleCredentials();
  creds.write({ token: TOKEN, bot: { id: BOT_ID, username: 'example_pult_bot' } });
  const connection = telegramModuleConnection({
    creds,
    archive: { chats: async () => [], topics: async () => [] },
    rules: { read: async () => [], write: async (value) => value },
    botApi,
  });
  const seed = connection.acquireLease();
  const accountRef = seed.accountRef;
  if (confirmed) {
    await seed.context.botSettings.setPult({ chatId: OWNER_CHAT, userId: OWNER_CHAT, confirmedAtMs: T0 });
  }
  await seed.release();
  const grigdesk = fakeGrigDesk();
  const forgotten = [];
  const clock = { at: T0 };
  const store = new TelegramPultStateStore({ file: path.join(dir, 'pult-state.json'), log: silent });
  const actions = new TelegramPultActions({
    isEnabled: () => true,
    callApi: grigdesk.callApi,
    summary: async () => 'сводка',
    forget: (key) => forgotten.push(key),
    stateStoreFor: () => store,
    queue: new PultSendQueue({ pauseMs: 0 }),
    now: () => clock.at,
    log: silent,
  });
  const withLease = async (operation) => {
    const lease = connection.acquireLease();
    try { return await operation(lease); } finally { await lease.release(); }
  };
  return {
    grigdesk,
    forgotten,
    clock,
    botCalls,
    store,
    accountRef,
    setFailDeletes: (value) => { failDeletes = value; },
    setFailDeleteBatches: (value) => { failDeleteBatches = value; },
    answers: () => botCalls.filter((c) => c.method === 'answerCallbackQuery'),
    edits: () => botCalls.filter((c) => c.method === 'editMessageText'),
    sends: () => botCalls.filter((c) => c.method === 'sendMessage'),
    deletes: () => botCalls.filter((c) => c.method === 'deleteMessage'),
    deleteBatches: () => botCalls.filter((c) => c.method === 'deleteMessages'),
    tap: (data, over = {}) => withLease((lease) => actions.onCallback({
      id: 'cb1',
      data,
      from: { id: OWNER_CHAT, name: 'Аня', username: 'anya' },
      chatId: OWNER_CHAT,
      chatType: 'private',
      messageId: 42,
      ...over,
    }, lease)),
    say: (text, over = {}) => withLease((lease) => actions.onMessage({
      chatId: OWNER_CHAT,
      chatType: 'private',
      messageId: 7,
      threadId: null,
      replyToMessageId: null,
      date: Math.floor(T0 / 1000),
      from: { id: OWNER_CHAT, name: 'Аня', username: 'anya' },
      text,
      media: [],
      ...over,
    }, 'message', lease)),
  };
}

test('ворота approve: inject в ту же ручку, итог всплывашкой, карточка удалена, ключ забыт', async (t) => {
  const f = await fixture(t);
  f.grigdesk.set('POST', '/api/tasks/4187/gate/gate_plan/approve', {
    statusCode: 200, body: { ok: true, resumed: true },
  });
  await f.tap('g:4187:GATE_PLAN:a');
  assert.deepEqual(f.grigdesk.calls[0], {
    method: 'POST', url: '/api/tasks/4187/gate/gate_plan/approve', payload: {},
  });
  assert.equal(f.answers().length, 1);
  assert.match(f.answers()[0].body.text, /Принято/u, 'итог виден всплывашкой answerCallbackQuery');
  assert.deepEqual(f.deletes().map((c) => c.body.message_id), [42], 'решённая карточка удаляется из чата');
  assert.equal(f.edits().length, 0, 'карточка не правится в «✓ решено»');
  assert.deepEqual(f.forgotten, ['wait:4187']);
});

test('resumed:false не глотается: решение записано, но прогон не поехал', async (t) => {
  const f = await fixture(t);
  f.grigdesk.set('POST', '/api/tasks/4187/gate/gate_plan/approve', {
    statusCode: 200, body: { ok: true, resumed: false, resumeError: 'контракт профиля разошёлся' },
  });
  await f.tap('g:4187:GATE_PLAN:a');
  assert.match(f.edits()[0].body.text, /прогон не поехал: контракт профиля разошёлся/u);
  assert.equal(f.deletes().length, 0, 'причину человек обязан прочитать: карточка остаётся');
});

test('409 gate_not_current и attempt_terminal доезжают словами', async (t) => {
  const f = await fixture(t);
  f.grigdesk.set('POST', '/api/tasks/4187/gate/gate_plan/approve', {
    statusCode: 409,
    body: { error: 'gate_not_current', message: 'маршрут не стоит на этих воротах: журнал на узле build (ready)' },
  });
  await f.tap('g:4187:GATE_PLAN:a');
  assert.match(f.answers()[0].body.text, /журнал на узле build/u);
  assert.match(f.edits()[0].body.text, /⚠ #4187: маршрут не стоит на этих воротах/u);
  assert.equal(f.deletes().length, 0, 'отказ ручки карточку не удаляет: причина остаётся видимой');
  assert.deepEqual(f.forgotten, ['wait:4187'], 'свежую карточку пришлёт следующий обход');
});

test('отклонение с пояснением: реплай на карточку уезжает в {comment}', async (t) => {
  const f = await fixture(t);
  await f.tap('g:4187:GATE_PLAN:r');
  assert.equal(f.grigdesk.calls.length, 0, 'первый тап — только вопрос, без inject');
  assert.match(f.edits()[0].body.text, /Ответь РЕПЛАЕМ/u);
  const buttons = f.edits()[0].body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(buttons, ['po:4187', 'g:4187:GATE_PLAN:rn', 'g:4187:GATE_PLAN:a']);

  f.grigdesk.set('POST', '/api/tasks/4187/gate/gate_plan/reject', (payload) => ({
    statusCode: 200, body: { ok: true, resumed: true, got: payload },
  }));
  await f.say('Кнопка съезжает на мобиле, поправь отступы', { replyToMessageId: 42 });
  assert.equal(f.grigdesk.calls.length, 1);
  assert.deepEqual(f.grigdesk.calls[0].payload, { comment: 'Кнопка съезжает на мобиле, поправь отступы' });
  assert.deepEqual(f.deletes().map((c) => c.body.message_id), [42], 'карточка ворот удаляется после решения');
  assert.match(f.sends().at(-1).body.text, /✓ #4187: отклонено, замечание уехало агенту/u,
    'всплывашки у реплая нет — итог приходит эфемерным сообщением');
  assert.equal((await f.store.read()).sent.length, 1, 'эфемерное ✓ зарегистрировано для /clean');
});

test('durable-реплай на карточку ворот после рестарта остаётся пояснением к решению', async (t) => {
  const f = await fixture(t);
  await f.store.write({ cards: {
    'wait:4187': {
      messageId: 42,
      kind: 'gate',
      at: T0,
      ownerKey: `${f.accountRef}:${T0}:${OWNER_CHAT}`,
      replyAction: { kind: 'gate-reject', taskId: '4187', gateKey: 'GATE_PLAN' },
    },
  } });
  f.grigdesk.set('POST', '/api/tasks/4187/gate/gate_plan/reject', {
    statusCode: 200, body: { ok: true, resumed: true },
  });
  await f.say('/не запускай этот вариант', {
    replyToMessageId: 42,
    replyToFromId: BOT_ID,
  });
  assert.deepEqual(f.grigdesk.calls.map(({ method, url, payload }) => ({ method, url, payload })), [{
    method: 'POST',
    url: '/api/tasks/4187/gate/gate_plan/reject',
    payload: { comment: '/не запускай этот вариант' },
  }]);
});

test('реплай после TTL не уезжает: ожидание протухло', async (t) => {
  const f = await fixture(t);
  await f.tap('g:4187:GATE_PLAN:r');
  f.clock.at = T0 + 10 * 60_000 + 1;
  await f.say('поздний текст', { replyToMessageId: 42, replyToFromId: BOT_ID });
  assert.equal(f.grigdesk.calls.length, 0, 'inject не случился');
});

test('«без пояснения» шлёт reject с пустым comment', async (t) => {
  const f = await fixture(t);
  f.grigdesk.set('POST', '/api/tasks/4187/gate/gate_plan/reject', {
    statusCode: 200, body: { ok: true, resumed: true },
  });
  await f.tap('g:4187:GATE_PLAN:rn');
  assert.deepEqual(f.grigdesk.calls[0].payload, {});
});

test('вопрос агента: вариант i уезжает в {answers} с label из живого /api/chat/waiting', async (t) => {
  const f = await fixture(t);
  f.grigdesk.set('GET', '/api/chat/waiting', {
    statusCode: 200,
    body: {
      waiting: [{
        pid: 'p1abc',
        chatKey: 'c1',
        at: T0,
        questions: [{
          question: 'Какой способ миграции выбрать?',
          header: 'Миграция',
          options: [{ label: 'Одним скриптом' }, { label: 'Поэтапно' }],
        }],
      }],
    },
  });
  f.grigdesk.set('POST', '/api/chat/permission/p1abc', { statusCode: 200, body: { ok: true } });
  await f.tap('q:p1abc:1');
  const post = f.grigdesk.calls.find((c) => c.method === 'POST');
  assert.deepEqual(post.payload, {
    answers: [{ header: 'Миграция', question: 'Какой способ миграции выбрать?', selected: ['Поэтапно'] }],
  });
  assert.deepEqual(f.deletes().map((c) => c.body.message_id), [42], 'карточка вопроса удаляется после ответа');
  assert.equal(f.edits().length, 0, 'карточка не правится в «✓»');
  assert.deepEqual(f.forgotten, ['q:p1abc']);
});

test('старые кнопки structured form и external URL требуют завершения в GrigDesk', async (t) => {
  const f = await fixture(t);
  f.grigdesk.set('GET', '/api/chat/waiting', {
    statusCode: 200,
    body: {
      waiting: [{
        pid: 'p1abc',
        chatKey: 'c1',
        structured: true,
        questions: [{ question: 'Секрет?', options: [{ label: 'Да' }] }],
      }],
    },
  });

  await f.tap('q:p1abc:0');
  await f.tap('q:p1abc:txt', { messageId: 43 });

  f.grigdesk.set('GET', '/api/chat/waiting', {
    statusCode: 200,
    body: {
      waiting: [{
        pid: 'p2xyz',
        chatKey: 'c1',
        tool: 'MCP · installer',
        input: { kind: 'external_url', url: 'https://example.test/install' },
      }],
    },
  });
  await f.tap('p:p2xyz:a', { messageId: 44 });

  assert.equal(f.grigdesk.calls.filter((call) => call.method === 'POST').length, 0);
  assert.equal(f.answers().length, 3);
  assert.ok(f.answers().every((call) => /GrigDesk/u.test(call.body.text)));
  assert.ok(f.edits().every((call) => (
    call.body.reply_markup.inline_keyboard.length === 0
    && /Заверши в GrigDesk/u.test(call.body.text)
  )));
});

test('протухший pid — «вопрос уже закрыт», без inject ответа', async (t) => {
  const f = await fixture(t);
  f.grigdesk.set('GET', '/api/chat/waiting', { statusCode: 200, body: { waiting: [] } });
  await f.tap('q:p1abc:1');
  assert.equal(f.grigdesk.calls.filter((c) => c.method === 'POST').length, 0);
  assert.match(f.answers()[0].body.text, /уже закрыт/u);
  assert.deepEqual(f.deletes().map((c) => c.body.message_id), [42],
    'повод ушёл — карточка удаляется наравне с решёнными');
});

test('разрешение: allow/deny уезжают в permission, отказ с пояснением — реплаем', async (t) => {
  const f = await fixture(t);
  f.grigdesk.set('POST', '/api/chat/permission/p2xyz', (payload) => ({
    statusCode: 200, body: { ok: true, got: payload },
  }));
  await f.tap('p:p2xyz:a');
  // Перед решением карточка дочитывает имя чата, поэтому сверяем именно решение.
  assert.deepEqual(f.grigdesk.calls.filter((c) => c.method === 'POST').at(-1).payload, { allow: true });
  assert.deepEqual(f.deletes().map((c) => c.body.message_id), [42],
    'карточка разрешения удаляется после решения');

  f.grigdesk.set('GET', '/api/chat/waiting', {
    statusCode: 200,
    body: { waiting: [{ pid: 'p2xyz', chatKey: 'c1', at: T0, tool: 'Bash', input: { command: 'rm -rf dist' } }] },
  });
  await f.tap('p:p2xyz:c', { messageId: 43 });
  await f.say('Сначала покажи, что именно удалишь', { replyToMessageId: 43 });
  const denies = f.grigdesk.calls.filter((c) => c.method === 'POST');
  assert.deepEqual(denies.at(-1).payload, { allow: false, comment: 'Сначала покажи, что именно удалишь' });
  assert.deepEqual(f.deletes().map((c) => c.body.message_id), [42, 43],
    'карточка отказа с пояснением тоже удаляется');
  assert.match(f.sends().at(-1).body.text, /✓ .*: отклонено, пояснение уехало агенту/u);
});

test('Telegram-кнопка fail-closed не отвечает на SSH-origin ни одним endpoint', async (t) => {
  const f = await fixture(t);
  f.grigdesk.set('GET', '/api/chat/waiting', {
    statusCode: 200,
    body: {
      waiting: [{
        pid: 'ssh-private-pid',
        origin: 'ssh',
        chatKey: 'chat-a',
        server: { label: 'Боевой код', host: 'SSH_PRIVATE_HOST_91006', port: 22 },
        user: 'SSH_PRIVATE_USER_91006',
        command: 'SSH_PRIVATE_COMMAND_91006',
      }],
    },
  });
  f.grigdesk.set('POST', '/api/chat/permission/ssh-private-pid', {
    statusCode: 200,
    body: { ok: true },
  });
  f.grigdesk.set('POST', '/api/ssh/approvals/ssh-private-pid', {
    statusCode: 200,
    body: { ok: true },
  });
  await f.tap('p:ssh-private-pid:a');

  assert.deepEqual(
    f.grigdesk.calls.filter((call) => call.method === 'POST'),
    [],
  );
});

test('чужое нажатие — молча ноль вызовов: ни answer, ни inject', async (t) => {
  const f = await fixture(t);
  await f.tap('g:4187:GATE_PLAN:a', { from: { id: 999, name: 'Некто', username: '' } });
  await f.tap('g:4187:GATE_PLAN:a', { chatId: 777333 });
  await f.tap('g:4187:GATE_PLAN:a', { chatType: 'supergroup', chatId: -100123 });
  assert.equal(f.botCalls.length, 0);
  assert.equal(f.grigdesk.calls.length, 0);
});

test('мусорный callback_data владельцу отвечает «кнопка устарела»', async (t) => {
  const f = await fixture(t);
  await f.tap('nonsense:data');
  assert.equal(f.grigdesk.calls.length, 0);
  assert.match(f.answers()[0].body.text, /устарела/u);
});

// ----------------------------- удаление решённых карточек и /clean (t91001)

test('ворота reject «без пояснения»: итог всплывашкой, карточка удалена', async (t) => {
  const f = await fixture(t);
  f.grigdesk.set('POST', '/api/tasks/4187/gate/gate_plan/reject', {
    statusCode: 200, body: { ok: true, resumed: true },
  });
  await f.tap('g:4187:GATE_PLAN:rn');
  assert.match(f.answers()[0].body.text, /Отклонено/u);
  assert.deepEqual(f.deletes().map((c) => c.body.message_id), [42]);
  assert.equal(f.edits().length, 0);
  assert.deepEqual(f.forgotten, ['wait:4187']);
});

test('свой ответ на вопрос реплаем: карточка удаляется, итог — эфемерным сообщением', async (t) => {
  const f = await fixture(t);
  f.grigdesk.set('GET', '/api/chat/waiting', {
    statusCode: 200,
    body: {
      waiting: [{
        pid: 'p1abc',
        chatKey: 'c1',
        at: T0,
        questions: [{ question: 'Какой способ выбрать?', options: [{ label: 'Одним скриптом' }] }],
      }],
    },
  });
  await f.tap('q:p1abc:txt'); // режим реплая на карточку 42
  f.grigdesk.set('POST', '/api/chat/permission/p1abc', { statusCode: 200, body: { ok: true } });
  await f.say('Отвечаю своими словами', { replyToMessageId: 42 });
  const post = f.grigdesk.calls.find((c) => c.method === 'POST');
  assert.deepEqual(post.payload, { answers: [{ text: 'Отвечаю своими словами' }] });
  assert.deepEqual(f.deletes().map((c) => c.body.message_id), [42], 'карточка вопроса удалена');
  assert.match(f.sends().at(-1).body.text, /✓ .*: свой ответ уехал агенту/u);
  assert.equal((await f.store.read()).sent.length, 1, 'эфемерное ✓ зарегистрировано для /clean');
});

test('«Отменено» на карточке подтверждения: всплывашка + удаление, а не правка', async (t) => {
  const f = await fixture(t);
  await f.tap('r:4187'); // ask-шаг: карточка правится в [Да] [Отмена]
  const editsBefore = f.edits().length;
  await f.tap('r:4187:n'); // Отмена
  assert.equal(f.answers().at(-1).body.text, 'Отменено.');
  assert.deepEqual(f.deletes().map((c) => c.body.message_id), [42]);
  assert.equal(f.edits().length, editsBefore, 'карточка не правится в «Отменено.» — она удаляется');
});

test('реплай-отклонение ворот с resumed:false: карточка НЕ удаляется, причина видна текстом', async (t) => {
  const f = await fixture(t);
  await f.tap('g:4187:GATE_PLAN:r');
  f.grigdesk.set('POST', '/api/tasks/4187/gate/gate_plan/reject', {
    statusCode: 200, body: { ok: true, resumed: false, resumeError: 'контракт профиля разошёлся' },
  });
  await f.say('не нравится план', { replyToMessageId: 42 });
  assert.equal(f.deletes().length, 0, 'решение записано, но прогон не поехал — причину надо прочитать');
  assert.match(f.edits().at(-1).body.text, /⚠ #4187: .*прогон не поехал: контракт профиля разошёлся/u);
});

test('отказ deleteMessage не роняет обработку нажатия', async (t) => {
  const f = await fixture(t);
  f.grigdesk.set('POST', '/api/tasks/4187/gate/gate_plan/approve', {
    statusCode: 200, body: { ok: true, resumed: true },
  });
  f.setFailDeletes(true);
  await f.tap('g:4187:GATE_PLAN:a'); // не бросает
  assert.equal(f.deletes().length, 1, 'удаление пытались');
  assert.equal(f.answers().length, 1, 'итог всё равно показан всплывашкой');
  assert.deepEqual(f.forgotten, ['wait:4187']);
});

// ------------------------------------------------------------------ /clean: очистка

/** Известные пульту сообщения: экран, не-sticky карточка, два sticky-прогона, эфемерный ответ. */
async function seedKnown(f) {
  const watchKey = `${f.accountRef}:${OWNER_CHAT}:${T0}`; // форма ключа карточек вотчера
  await f.store.write({
    screen: { messageId: 5, at: T0, ownerKey: `${f.accountRef}:${T0}:${OWNER_CHAT}` },
    sent: [{ messageId: 7, at: T0 }],
    cards: {
      'wait:4187': { messageId: 10, kind: 'gate', subject: '#4187', at: T0, ownerKey: watchKey },
      'live:4190:a1': { messageId: 11, kind: 'live', subject: '#4190', at: T0, sticky: true, ownerKey: watchKey },
      'done:4190:a1': { messageId: 12, kind: 'done', subject: '#4190', at: T0, sticky: true, ownerKey: watchKey },
    },
  });
}

test('/clean удаляет известные сообщения одним пакетом deleteMessages, кроме sticky', async (t) => {
  const f = await fixture(t);
  await seedKnown(f);
  await f.say('/clean');
  const batches = f.deleteBatches();
  assert.equal(batches.length, 1, 'пакетный deleteMessages, а не вызов на каждое сообщение');
  assert.deepEqual([...batches[0].body.message_ids].sort((a, b) => a - b), [5, 7, 10],
    'экран, эфемерный ответ и не-sticky карточка');
  assert.equal(f.deletes().length, 0, 'поштучный deleteMessage не нужен, пакет справился');
});

test('/clean отвечает числом удалённых и неудалённых, ответ сам эфемерный', async (t) => {
  const f = await fixture(t);
  await seedKnown(f);
  await f.say('/clean');
  assert.match(f.sends().at(-1).body.text, /удалено 3, не удалось 0/u);
  const state = await f.store.read();
  assert.equal(state.screen, null, 'экран забыт');
  assert.equal(state.sent.length, 1, 'в реестре остался только сам ответ /clean');
});

test('/clean не трогает sticky-карточки прогонов и забывает удалённые у вотчера', async (t) => {
  const f = await fixture(t);
  await seedKnown(f);
  await f.say('/clean');
  const saved = await f.store.read();
  assert.equal('live:4190:a1' in saved.cards, true, 'live неприкосновенен');
  assert.equal('done:4190:a1' in saved.cards, true, 'done неприкосновенен');
  assert.equal('wait:4187' in saved.cards, false, 'удалённая карточка забыта');
  assert.deepEqual(f.forgotten, ['wait:4187'],
    'вотчеру забыты только удалённые не-sticky ключи: живой повод перевыпустит карточку');
});

test('/clean: сообщение старше 48 часов не ломает уборку и попадает в «не удалось»', async (t) => {
  const f = await fixture(t);
  await f.store.write({
    sent: [{ messageId: 7, at: T0 }, { messageId: 8, at: T0 - 49 * 3600 * 1000 }],
  });
  await f.say('/clean');
  const attempted = f.deleteBatches().flatMap((c) => c.body.message_ids);
  assert.equal(attempted.includes(8), false, 'старше 48 часов — даже не пытаемся удалять');
  assert.equal(attempted.includes(7), true);
  assert.match(f.sends().at(-1).body.text, /удалено 1, не удалось 1/u);
});

test('/clean: отказ пакета — поштучный обход этого пакета, остальные удаляются', async (t) => {
  const f = await fixture(t);
  await f.store.write({ sent: [{ messageId: 7, at: T0 }, { messageId: 8, at: T0 }, { messageId: 9, at: T0 }] });
  f.setFailDeleteBatches(true);
  await f.say('/clean');
  assert.equal(f.deleteBatches().length >= 1, true, 'пакетная попытка была');
  assert.deepEqual(f.deletes().map((c) => c.body.message_id).sort((a, b) => a - b), [7, 8, 9],
    'каждое сообщение отказавшего пакета удалено поштучно');
  assert.match(f.sends().at(-1).body.text, /удалено 3, не удалось 0/u);
});

test('/clean дробит удаление на пакеты не больше 100 id за вызов', async (t) => {
  const f = await fixture(t);
  // 150 записей — под потолком реестра sent (200), но больше лимита Bot API на вызов.
  const sent = Array.from({ length: 150 }, (_, index) => ({ messageId: 100 + index, at: T0 }));
  await f.store.write({ sent });
  await f.say('/clean');
  const batches = f.deleteBatches();
  assert.deepEqual(batches.map((c) => c.body.message_ids.length), [100, 50],
    '150 id уходят двумя пакетами: deleteMessages принимает до 100 id за вызов');
  assert.match(f.sends().at(-1).body.text, /удалено 150, не удалось 0/u);
});
