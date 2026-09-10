// Срез M телеграм-пульта: мутации.
//
// Мутаций осталось две, и обе про ВСТАВШИЙ прогон — resume и пересборка стенда.
// Постановка задач, запуск прогона и остановка ходов из пульта сняты (дублировали
// Входящие, кокпит и мобильный Битрикс), поэтому здесь проверяется одно правило:
// всё, что стоит времени, подтверждается ВТОРЫМ тапом с TTL 10 минут; протухшее
// подтверждение — «запрос устарел», inject-а нет.
import assert from 'node:assert/strict';
import test from 'node:test';

import { TelegramPultActions } from '../../server/src/lib/telegram/pult/actions.ts';
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

function fakeCockpit() {
  const calls = [];
  const routes = new Map();
  return {
    calls,
    posts: () => calls.filter((c) => c.method === 'POST'),
    set: (method, url, response) => routes.set(`${method} ${url}`, response),
    callApi: async (method, url, payload) => {
      calls.push({ method, url, payload });
      const canned = routes.get(`${method} ${url}`);
      if (!canned) return { statusCode: 404, body: { error: 'not_found' } };
      return typeof canned === 'function' ? canned(payload) : canned;
    },
  };
}

async function fixture() {
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
  const seed = connection.acquireLease();
  await seed.context.botSettings.setPult({ chatId: OWNER_CHAT, userId: OWNER_CHAT, confirmedAtMs: T0 });
  await seed.release();

  const cockpit = fakeCockpit();
  const forgotten = [];
  const clock = { at: T0 };
  const actions = new TelegramPultActions({
    isEnabled: () => true,
    callApi: cockpit.callApi,
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
    deletes: () => botCalls.filter((c) => c.method === 'deleteMessage'),
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

// -------------------------------------------------------------------- resume

test('resume: первый тап — вопрос без inject, «Да» — inject, итог всплывашкой, карточка удалена', async () => {
  const f = await fixture();
  await f.tap('r:4187');
  assert.equal(f.cockpit.calls.length, 0, 'первый тап ничего не запускает');
  assert.match(f.edits()[0].body.text, /Точно продолжить #4187/u);
  const buttons = f.edits()[0].body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(buttons, ['r:4187:y', 'x']);

  f.cockpit.set('POST', '/api/tasks/4187/resume', { statusCode: 200, body: { ok: true, outcome: 'launched' } });
  await f.tap('r:4187:y');
  assert.deepEqual(f.cockpit.calls[0], { method: 'POST', url: '/api/tasks/4187/resume', payload: {} });
  assert.match(f.answers().at(-1).body.text, /прогон продолжен/u, 'итог показан всплывашкой');
  assert.deepEqual(f.deletes().map((c) => c.body.message_id), [42],
    'решённая карточка удаляется, а не правится в «✓ решено»');
  assert.equal(f.edits().length, 1, 'правок решённой карточки больше нет');
  assert.deepEqual(f.forgotten, ['stall:4187']);
});

test('resume: истёкший TTL подтверждения — «запрос устарел», inject-а нет', async () => {
  const f = await fixture();
  await f.tap('r:4187');
  f.clock.at = T0 + 10 * 60_000 + 1;
  await f.tap('r:4187:y');
  assert.equal(f.cockpit.calls.length, 0);
  assert.match(f.answers().at(-1).body.text, /устарел/u);
});

test('resume: «Да» без первого тапа не работает (подтверждение обязательно)', async () => {
  const f = await fixture();
  await f.tap('r:4187:y');
  assert.equal(f.cockpit.calls.length, 0);
  assert.match(f.answers()[0].body.text, /устарел/u);
});

test('resume: типизированный отказ движка доезжает словами', async () => {
  const f = await fixture();
  await f.tap('r:4187');
  f.cockpit.set('POST', '/api/tasks/4187/resume', {
    statusCode: 500,
    body: { error: 'runner_preflight_unavailable', message: 'исполнители недоступны: claude' },
  });
  await f.tap('r:4187:y');
  assert.match(f.edits()[1].body.text, /прогон не поехал: исполнители недоступны: claude/u);
  assert.equal(f.deletes().length, 0, 'отказ ручки карточку не удаляет: причина остаётся видимой');
});

test('«Отмена» на подтверждении гасит его и удаляет карточку: последующее «Да» уже не запускает', async () => {
  const f = await fixture();
  await f.tap('r:4187');
  await f.tap('x');
  assert.match(f.answers().at(-1).body.text, /Отменено/u, 'итог отмены — всплывашкой');
  assert.deepEqual(f.deletes().map((c) => c.body.message_id), [42],
    'карточка подтверждения удаляется, а не остаётся текстом «Отменено»');
  await f.tap('r:4187:y');
  assert.equal(f.cockpit.calls.length, 0);
});

// -------------------------------------------------------------- sandbox retry

test('sandbox retry: подтверждение → inject, итог и downOutput доезжают всплывашкой, карточка удалена', async () => {
  const f = await fixture();
  await f.tap('sb:4188');
  assert.match(f.edits()[0].body.text, /снести остатки песочницы #4188/iu);
  f.cockpit.set('POST', '/api/tasks/4188/sandbox/retry', {
    statusCode: 200,
    body: { ok: true, retried: true, downOutput: 'схема db_t4188 удалена\nworktree снят' },
  });
  await f.tap('sb:4188:y');
  assert.equal(f.cockpit.calls[0].url, '/api/tasks/4188/sandbox/retry');
  assert.match(f.answers().at(-1).body.text, /остатки снесены, прогон продолжен/u);
  assert.match(f.answers().at(-1).body.text, /схема db_t4188 удалена/u, 'downOutput доезжает во всплывашке');
  assert.deepEqual(f.deletes().map((c) => c.body.message_id), [42],
    'решённая карточка удаляется, а не правится в «✓ решено»');
});

test('sandbox retry: отказ (например shared workspace) доезжает словами вместе со сносом', async () => {
  const f = await fixture();
  await f.tap('sb:4188');
  f.cockpit.set('POST', '/api/tasks/4188/sandbox/retry', {
    statusCode: 409,
    body: { error: 'shared_workspace_lifecycle_forbidden', message: 'Общий checkout нельзя сносить из Cockpit.', downOutput: '' },
  });
  await f.tap('sb:4188:y');
  assert.match(f.edits()[1].body.text, /Общий checkout нельзя сносить/u);
  assert.equal(f.deletes().length, 0, 'отказ ручки карточку не удаляет: причина остаётся видимой');
});

// ------------------------------------------------------------------- owner-гейт

test('мутация от не-владельца — молча ноль вызовов (общий owner-гейт)', async () => {
  const f = await fixture();
  await f.tap('r:4187:y', { from: { id: 999, name: 'Некто', username: '' } });
  await f.say('/task Чужая задача', { from: { id: 999, name: 'Некто', username: '' } });
  assert.equal(f.cockpit.calls.length, 0);
  assert.equal(f.botCalls.length, 0);
});
