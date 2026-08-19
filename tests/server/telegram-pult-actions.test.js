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
import test from 'node:test';

import { TelegramPultActions } from '../../server/src/lib/telegram/pult/actions.js';
import { PultSendQueue } from '../../server/src/lib/telegram/pult/send-queue.js';
import {
  TelegramModuleCredentials,
  telegramModuleConnection,
} from './helpers/telegram-account-module.js';

const TOKEN = '8123456789:AAHrEaLLyLoNgSeCrEtPaRt_x1y2z3w4v5u6';
const BOT_ID = 8123456789;
const OWNER_CHAT = 555001;
const T0 = Date.UTC(2026, 7, 19, 10, 0, 0);
const silent = { warn() {}, error() {}, info() {}, debug() {} };

function fakeCockpit() {
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

async function fixture({ confirmed = true } = {}) {
  const botCalls = [];
  const botApi = {
    getMe: async () => ({ id: BOT_ID, username: 'example_pult_bot' }),
    callBotApi: async (token, method, body) => {
      botCalls.push({ method, body });
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
  if (confirmed) {
    const seed = connection.acquireLease();
    await seed.context.botSettings.setPult({ chatId: OWNER_CHAT, userId: OWNER_CHAT, confirmedAtMs: T0 });
    await seed.release();
  }
  const cockpit = fakeCockpit();
  const forgotten = [];
  const clock = { at: T0 };
  const actions = new TelegramPultActions({
    isEnabled: () => true,
    callApi: cockpit.callApi,
    summary: async () => 'сводка',
    forget: (key) => forgotten.push(key),
    queue: new PultSendQueue({ pauseMs: 0 }),
    now: () => clock.at,
    log: silent,
  });
  const withLease = async (operation) => {
    const lease = connection.acquireLease();
    try { return await operation(lease); } finally { await lease.release(); }
  };
  return {
    cockpit,
    forgotten,
    clock,
    botCalls,
    answers: () => botCalls.filter((c) => c.method === 'answerCallbackQuery'),
    edits: () => botCalls.filter((c) => c.method === 'editMessageText'),
    sends: () => botCalls.filter((c) => c.method === 'sendMessage'),
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

test('ворота approve: inject в ту же ручку, answer + карточка «✓», ключ забыт', async () => {
  const f = await fixture();
  f.cockpit.set('POST', '/api/tasks/4187/gate/gate_plan/approve', {
    statusCode: 200, body: { ok: true, resumed: true },
  });
  await f.tap('g:4187:GATE_PLAN:a');
  assert.deepEqual(f.cockpit.calls[0], {
    method: 'POST', url: '/api/tasks/4187/gate/gate_plan/approve', payload: {},
  });
  assert.equal(f.answers().length, 1);
  assert.equal(f.edits().length, 1);
  assert.match(f.edits()[0].body.text, /✓ #4187: принято, прогон продолжен/u);
  assert.deepEqual(f.forgotten, ['wait:4187']);
});

test('resumed:false не глотается: решение записано, но прогон не поехал', async () => {
  const f = await fixture();
  f.cockpit.set('POST', '/api/tasks/4187/gate/gate_plan/approve', {
    statusCode: 200, body: { ok: true, resumed: false, resumeError: 'контракт профиля разошёлся' },
  });
  await f.tap('g:4187:GATE_PLAN:a');
  assert.match(f.edits()[0].body.text, /прогон не поехал: контракт профиля разошёлся/u);
});

test('409 gate_not_current и attempt_terminal доезжают словами', async () => {
  const f = await fixture();
  f.cockpit.set('POST', '/api/tasks/4187/gate/gate_plan/approve', {
    statusCode: 409,
    body: { error: 'gate_not_current', message: 'маршрут не стоит на этих воротах: журнал на узле build (ready)' },
  });
  await f.tap('g:4187:GATE_PLAN:a');
  assert.match(f.answers()[0].body.text, /журнал на узле build/u);
  assert.match(f.edits()[0].body.text, /⚠ #4187: маршрут не стоит на этих воротах/u);
  assert.deepEqual(f.forgotten, ['wait:4187'], 'свежую карточку пришлёт следующий обход');
});

test('отклонение с пояснением: реплай на карточку уезжает в {comment}', async () => {
  const f = await fixture();
  await f.tap('g:4187:GATE_PLAN:r');
  assert.equal(f.cockpit.calls.length, 0, 'первый тап — только вопрос, без inject');
  assert.match(f.edits()[0].body.text, /Ответь РЕПЛАЕМ/u);
  const buttons = f.edits()[0].body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(buttons, ['po:4187', 'g:4187:GATE_PLAN:rn', 'g:4187:GATE_PLAN:a']);

  f.cockpit.set('POST', '/api/tasks/4187/gate/gate_plan/reject', (payload) => ({
    statusCode: 200, body: { ok: true, resumed: true, got: payload },
  }));
  await f.say('Кнопка съезжает на мобиле, поправь отступы', { replyToMessageId: 42 });
  assert.equal(f.cockpit.calls.length, 1);
  assert.deepEqual(f.cockpit.calls[0].payload, { comment: 'Кнопка съезжает на мобиле, поправь отступы' });
  assert.match(f.edits()[1].body.text, /замечание уехало агенту/u);
});

test('реплай после TTL не уезжает: ожидание протухло', async () => {
  const f = await fixture();
  await f.tap('g:4187:GATE_PLAN:r');
  f.clock.at = T0 + 10 * 60_000 + 1;
  await f.say('поздний текст', { replyToMessageId: 42 });
  assert.equal(f.cockpit.calls.length, 0, 'inject не случился');
});

test('«без пояснения» шлёт reject с пустым comment', async () => {
  const f = await fixture();
  f.cockpit.set('POST', '/api/tasks/4187/gate/gate_plan/reject', {
    statusCode: 200, body: { ok: true, resumed: true },
  });
  await f.tap('g:4187:GATE_PLAN:rn');
  assert.deepEqual(f.cockpit.calls[0].payload, {});
});

test('вопрос агента: вариант i уезжает в {answers} с label из живого /api/chat/waiting', async () => {
  const f = await fixture();
  f.cockpit.set('GET', '/api/chat/waiting', {
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
  f.cockpit.set('POST', '/api/chat/permission/p1abc', { statusCode: 200, body: { ok: true } });
  await f.tap('q:p1abc:1');
  const post = f.cockpit.calls.find((c) => c.method === 'POST');
  assert.deepEqual(post.payload, {
    answers: [{ header: 'Миграция', question: 'Какой способ миграции выбрать?', selected: ['Поэтапно'] }],
  });
  assert.match(f.edits()[0].body.text, /Поэтапно/u);
  assert.deepEqual(f.forgotten, ['q:p1abc']);
});

test('протухший pid — «вопрос уже закрыт», без inject ответа', async () => {
  const f = await fixture();
  f.cockpit.set('GET', '/api/chat/waiting', { statusCode: 200, body: { waiting: [] } });
  await f.tap('q:p1abc:1');
  assert.equal(f.cockpit.calls.filter((c) => c.method === 'POST').length, 0);
  assert.match(f.answers()[0].body.text, /уже закрыт/u);
});

test('разрешение: allow/deny уезжают в permission, отказ с пояснением — реплаем', async () => {
  const f = await fixture();
  f.cockpit.set('POST', '/api/chat/permission/p2xyz', (payload) => ({
    statusCode: 200, body: { ok: true, got: payload },
  }));
  await f.tap('p:p2xyz:a');
  assert.deepEqual(f.cockpit.calls[0].payload, { allow: true });

  f.cockpit.set('GET', '/api/chat/waiting', {
    statusCode: 200,
    body: { waiting: [{ pid: 'p2xyz', chatKey: 'c1', at: T0, tool: 'Bash', input: { command: 'rm -rf dist' } }] },
  });
  await f.tap('p:p2xyz:c', { messageId: 43 });
  await f.say('Сначала покажи, что именно удалишь', { replyToMessageId: 43 });
  const denies = f.cockpit.calls.filter((c) => c.method === 'POST');
  assert.deepEqual(denies.at(-1).payload, { allow: false, comment: 'Сначала покажи, что именно удалишь' });
});

test('чужое нажатие — молча ноль вызовов: ни answer, ни inject', async () => {
  const f = await fixture();
  await f.tap('g:4187:GATE_PLAN:a', { from: { id: 999, name: 'Некто', username: '' } });
  await f.tap('g:4187:GATE_PLAN:a', { chatId: 777333 });
  await f.tap('g:4187:GATE_PLAN:a', { chatType: 'supergroup', chatId: -100123 });
  assert.equal(f.botCalls.length, 0);
  assert.equal(f.cockpit.calls.length, 0);
});

test('мусорный callback_data владельцу отвечает «кнопка устарела»', async () => {
  const f = await fixture();
  await f.tap('nonsense:data');
  assert.equal(f.cockpit.calls.length, 0);
  assert.match(f.answers()[0].body.text, /устарела/u);
});
