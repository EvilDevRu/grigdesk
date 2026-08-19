// Интерактивный статус Telegram-пульта: список → задача → узлы и allowlisted plan.md.
// Все переходы read-only и перечитывают живой снимок; план открывается НОВЫМ
// сообщением, чтобы кнопки решения на исходной карточке ворот не исчезали.
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

function task(taskId, over = {}) {
  return {
    task: String(taskId),
    title: `Задача ${taskId}`,
    daemonAlive: true,
    stall: null,
    quiet: null,
    graph: {
      route: 'feature',
      pos: { scout: [0, 0], plan: [1, 0], build: [2, 0], review: [3, 0] },
      nodes: {
        scout: ['agent', '🔎 Разведка'],
        plan: ['agent', '📋 План'],
        build: ['agent', '🛠 Реализация'],
        review: ['agent', '🔬 Ревью'],
      },
      statuses: { scout: 'done', plan: 'done', build: 'run', review: 'pending' },
      progress: { done: 2, total: 4, current: 'build' },
    },
    ...over,
  };
}

async function fixture({ tasks = [task(4187, { title: 'Починить экспорт CSV' })] } = {}) {
  const botCalls = [];
  const apiCalls = [];
  const routes = new Map();
  const clock = { at: T0 };
  const snapshot = { tasks, waiting: [], stalled: [], silent: [], chat: [], running: [] };
  const botApi = {
    getMe: async () => ({ id: BOT_ID, username: 'example_pult_bot' }),
    callBotApi: async (token, method, body) => {
      botCalls.push({ method, body });
      if (method === 'sendMessage') {
        return { message_id: 900 + botCalls.filter((call) => call.method === 'sendMessage').length };
      }
      return true;
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

  const actions = new TelegramPultActions({
    isEnabled: () => true,
    summary: async () => snapshot,
    callApi: async (method, url, payload) => {
      apiCalls.push({ method, url, payload });
      return routes.get(`${method} ${url}`) || { statusCode: 404, body: { error: 'not_found' } };
    },
    queue: new PultSendQueue({ pauseMs: 0 }),
    now: () => clock.at,
    log: silent,
  });
  const withLease = async (operation) => {
    const lease = connection.acquireLease();
    try { return await operation(lease); } finally { await lease.release(); }
  };
  return {
    snapshot,
    clock,
    routes,
    apiCalls,
    botCalls,
    sends: () => botCalls.filter((call) => call.method === 'sendMessage'),
    edits: () => botCalls.filter((call) => call.method === 'editMessageText'),
    answers: () => botCalls.filter((call) => call.method === 'answerCallbackQuery'),
    say: (text) => withLease((lease) => actions.onMessage({
      chatId: OWNER_CHAT,
      chatType: 'private',
      messageId: 7,
      threadId: null,
      replyToMessageId: null,
      date: Math.floor(T0 / 1000),
      from: { id: OWNER_CHAT, name: 'Аня', username: 'anya' },
      text,
      media: [],
    }, 'message', lease)),
    tap: (data, messageId = 42) => withLease((lease) => actions.onCallback({
      id: `cb-${botCalls.length}`,
      data,
      from: { id: OWNER_CHAT, name: 'Аня', username: 'anya' },
      chatId: OWNER_CHAT,
      chatType: 'private',
      messageId,
    }, lease)),
  };
}

test('/status показывает название, текущий узел, процент и кнопку подробностей', async () => {
  const f = await fixture();
  await f.say('/status');
  const message = f.sends()[0].body;
  assert.match(message.text, /Починить экспорт CSV/u);
  assert.match(message.text, /2\/4 · 50% · 🛠 Реализация/u);
  assert.deepEqual(
    message.reply_markup.inline_keyboard.flat().map((button) => button.callback_data),
    ['sd:4187:0', 'sl:0'],
  );
});

test('/status <id> и кнопки дают подробную карточку и живой список узлов', async () => {
  const f = await fixture();
  await f.say('/status 4187');
  const detail = f.sends()[0].body;
  assert.match(detail.text, /Маршрут: feature/u);
  assert.match(detail.text, /Сейчас: 🛠 Реализация · выполняется/u);
  assert.match(detail.text, /Прогресс маршрута: 2\/4 · 50%/u);
  assert.deepEqual(
    detail.reply_markup.inline_keyboard.flat().map((button) => button.callback_data),
    ['sn:4187:0:0', 'po:4187', 'sl:0', 'sd:4187:0'],
  );

  await f.tap('sn:4187:0:0', 901);
  const nodes = f.edits()[0].body;
  assert.match(nodes.text, /✓ 🔎 Разведка/u);
  assert.match(nodes.text, /▸ 🛠 Реализация/u);
  assert.match(nodes.text, /○ 🔬 Ревью/u);
  assert.equal(nodes.reply_markup.inline_keyboard[0][0].callback_data, 'sd:4187:0');
  assert.equal(f.answers().length, 1);
});

test('список /status постраничный и сохраняет страницу при входе в задачу', async () => {
  const f = await fixture({ tasks: Array.from({ length: 7 }, (_, index) => task(4200 + index)) });
  await f.say('/status');
  assert.match(f.sends()[0].body.text, /7 задач · 1\/2/u);
  assert.equal(f.sends()[0].body.reply_markup.inline_keyboard[0][0].callback_data, 'sd:4200:0');

  await f.tap('sl:1', 901);
  const second = f.edits()[0].body;
  assert.match(second.text, /7 задач · 2\/2/u);
  assert.match(second.text, /#4205/u);
  assert.equal(second.reply_markup.inline_keyboard[0][0].callback_data, 'sd:4205:1');
});

test('план открывается новым сообщением и листается без потери исходной карточки', async () => {
  const f = await fixture();
  f.routes.set('GET /api/tasks/4187/doc/plan', {
    statusCode: 200,
    body: { text: `# Цель\n${'Первый раздел. '.repeat(250)}\n# Проверка\n${'Второй раздел. '.repeat(120)}` },
  });

  await f.tap('po:4187', 500);
  assert.equal(f.edits().length, 0, 'исходная status/gate-карточка остаётся с кнопками');
  assert.equal(f.sends().length, 1);
  const first = f.sends()[0].body;
  assert.match(first.text, /📄 План #4187 · 1\//u);
  const next = first.reply_markup.inline_keyboard.flat()
    .find((button) => /^pp:4187:1$/u.test(button.callback_data));
  assert.ok(next, 'у длинного плана есть следующая страница');

  await f.tap(next.callback_data, 901);
  assert.match(f.edits()[0].body.text, /📄 План #4187 · 2\//u);
  assert.equal(
    f.apiCalls.filter((call) => call.url.endsWith('/doc/plan')).length,
    1,
    'страницы листают один неизменный снимок, а не прыгающий живой файл',
  );
});

test('пустой план называется прямо и не затирает карточку ворот', async () => {
  const f = await fixture();
  f.routes.set('GET /api/tasks/4187/doc/plan', { statusCode: 200, body: { text: '' } });
  await f.tap('po:4187', 500);
  assert.equal(f.edits().length, 0);
  assert.match(f.sends()[0].body.text, /план ещё не создан/iu);
});

test('страницы плана после TTL не читают файл заново и не раскрывают старый снимок', async () => {
  const f = await fixture();
  f.routes.set('GET /api/tasks/4187/doc/plan', {
    statusCode: 200,
    body: { text: `${'страница '.repeat(500)}\n${'хвост '.repeat(500)}` },
  });
  await f.tap('po:4187', 500);
  const next = f.sends()[0].body.reply_markup.inline_keyboard.flat()
    .find((button) => button.callback_data === 'pp:4187:1');
  assert.ok(next);
  f.clock.at += 10 * 60_000 + 1;
  await f.tap(next.callback_data, 901);
  assert.match(f.edits()[0].body.text, /просмотр плана устарел/iu);
  assert.equal(f.apiCalls.filter((call) => call.url.endsWith('/doc/plan')).length, 1);
});
