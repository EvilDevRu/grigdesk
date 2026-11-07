// Интерактивный статус Telegram-пульта: список → задача → узлы и разрешённый plan.md.
// Все переходы только для чтения и перечитывают живой снимок; вся навигация живёт в ОДНОМ
// сообщении-экране (t91001): правится на месте, закрывается кнопкой «✕ Закрыть».
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

async function fixture(t, { tasks = [task(4187, { title: 'Починить экспорт CSV' })] } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-pult-status-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const botCalls = [];
  const apiCalls = [];
  const routes = new Map();
  const clock = { at: T0 };
  const snapshot = { tasks, waiting: [], stalled: [], silent: [], chat: [], running: [] };
  let failEdits = false;
  const botApi = {
    getMe: async () => ({ id: BOT_ID, username: 'example_pult_bot' }),
    callBotApi: async (token, method, body) => {
      botCalls.push({ method, body });
      if (failEdits && method === 'editMessageText') {
        throw Object.assign(new Error('Bad Request: message to edit is not found'), { kind: 'telegram' });
      }
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
  const accountRef = seed.accountRef;
  await seed.context.botSettings.setPult({ chatId: OWNER_CHAT, userId: OWNER_CHAT, confirmedAtMs: T0 });
  await seed.release();

  const store = new TelegramPultStateStore({ file: path.join(dir, 'pult-state.json'), log: silent });
  const actions = new TelegramPultActions({
    isEnabled: () => true,
    summary: async () => snapshot,
    callApi: async (method, url, payload) => {
      apiCalls.push({ method, url, payload });
      return routes.get(`${method} ${url}`) || { statusCode: 404, body: { error: 'not_found' } };
    },
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
    snapshot,
    clock,
    routes,
    apiCalls,
    botCalls,
    store,
    accountRef,
    setFailEdits: (value) => { failEdits = value; },
    sends: () => botCalls.filter((call) => call.method === 'sendMessage'),
    edits: () => botCalls.filter((call) => call.method === 'editMessageText'),
    answers: () => botCalls.filter((call) => call.method === 'answerCallbackQuery'),
    deletes: () => botCalls.filter((call) => call.method === 'deleteMessage'),
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

test('/status показывает название, текущий узел, процент и кнопку подробностей', async (t) => {
  const f = await fixture(t);
  await f.say('/status');
  const message = f.sends()[0].body;
  assert.match(message.text, /Починить экспорт CSV/u);
  assert.match(message.text, /2\/4 · 50% · 🛠 Реализация/u);
  assert.deepEqual(
    message.reply_markup.inline_keyboard.flat().map((button) => button.callback_data),
    ['sd:4187:0', 'sl:0', 'nh', 'sc'],
    'навигация по списку, на главную и закрытие экрана',
  );
});

test('/status <id> и кнопки дают подробную карточку и живой список узлов', async (t) => {
  const f = await fixture(t);
  await f.say('/status 4187');
  const detail = f.sends()[0].body;
  assert.match(detail.text, /Маршрут: feature/u);
  assert.match(detail.text, /Сейчас: 🛠 Реализация · выполняется/u);
  assert.match(detail.text, /Прогресс маршрута: 2\/4 · 50%/u);
  assert.deepEqual(
    detail.reply_markup.inline_keyboard.flat().map((button) => button.callback_data),
    ['sn:4187:0:0', 'po:4187', 'sl:0', 'sd:4187:0', 'nh', 'sc'],
  );

  await f.tap('sn:4187:0:0', 901);
  const nodes = f.edits()[0].body;
  assert.match(nodes.text, /✓ 🔎 Разведка/u);
  assert.match(nodes.text, /▸ 🛠 Реализация/u);
  assert.match(nodes.text, /○ 🔬 Ревью/u);
  assert.equal(nodes.reply_markup.inline_keyboard[0][0].callback_data, 'sd:4187:0');
  assert.equal(f.answers().length, 1);
});

test('список /status постраничный и сохраняет страницу при входе в задачу', async (t) => {
  const f = await fixture(t, { tasks: Array.from({ length: 7 }, (_, index) => task(4200 + index)) });
  await f.say('/status');
  assert.match(f.sends()[0].body.text, /7 задач · 1\/2/u);
  assert.equal(f.sends()[0].body.reply_markup.inline_keyboard[0][0].callback_data, 'sd:4200:0');

  await f.tap('sl:1', 901);
  const second = f.edits()[0].body;
  assert.match(second.text, /7 задач · 2\/2/u);
  assert.match(second.text, /#4205/u);
  assert.equal(second.reply_markup.inline_keyboard[0][0].callback_data, 'sd:4205:1');
});

test('план открывается новым сообщением и листается без потери исходной карточки', async (t) => {
  const f = await fixture(t);
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

test('пустой план называется прямо и не затирает карточку ворот', async (t) => {
  const f = await fixture(t);
  f.routes.set('GET /api/tasks/4187/doc/plan', { statusCode: 200, body: { text: '' } });
  await f.tap('po:4187', 500);
  assert.equal(f.edits().length, 0);
  assert.match(f.sends()[0].body.text, /план ещё не создан/iu);
});

test('страницы плана после TTL не читают файл заново и не раскрывают старый снимок', async (t) => {
  const f = await fixture(t);
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

test('кнопка «Все узлы» живой карточки правит экран навигации, а не саму карточку', async (t) => {
  const pult = await fixture(t);
  await pult.say('/status'); // экран создан: message_id 901
  await pult.tap('sm:4187', 4242); // нажатие пришло с ЖИВОЙ карточки
  const edits = pult.edits();
  assert.equal(edits.length, 1, 'узлы правят сохранённый экран, нового сообщения нет');
  assert.equal(edits[0].body.message_id, 901, 'правится экран, а не живая карточка 4242');
  assert.match(edits[0].body.text, /🗺 Узлы #4187/u);
  assert.match(edits[0].body.text, /▸ 🛠 Реализация/u);
  assert.equal(pult.sends().length, 1, 'второго сообщения не появилось');
  assert.equal(pult.answers().length, 1, 'callback обязан быть отвечен, иначе «часики»');
});

test('снятые команды больше не работают: ни одного вызова GrigDesk', async (t) => {
  const pult = await fixture(t);
  for (const text of [
    '/task Починить экспорт\nописание',
    '/launch 4187',
    '/timer 4187 start',
    '/complete 4187',
    '/renew 4187',
    '/stop',
  ]) {
    await pult.say(text);
  }
  assert.equal(pult.apiCalls.length, 0, 'мусорные команды не ходят ни в B24, ни в конвейер');
  assert.equal(pult.sends().length, 6);
  for (const sent of pult.sends()) assert.match(sent.body.text, /Не понял/u);
});

test('/help описывает пульт как просмотр и решения, без снятых команд', async (t) => {
  const pult = await fixture(t);
  await pult.say('/help');
  const help = pult.sends()[0].body.text;
  assert.match(help, /\/status/u);
  assert.match(help, /живую карточку прогона/u);
  for (const gone of ['/task', '/launch', '/timer', '/complete', '/renew', '/stop']) {
    assert.equal(help.includes(`${gone} `), false, `в подсказке осталась снятая команда ${gone}`);
  }
});

// --------------------------------------- один экран навигации (t91001)

test('повторный /status правит тот же экран, второго сообщения нет', async (t) => {
  const f = await fixture(t);
  await f.say('/status');
  await f.say('/status');
  assert.equal(f.sends().length, 1, 'экран навигации один на пульт');
  assert.equal(f.edits().length, 1, 'второй показ — правка на месте');
  assert.equal(f.edits()[0].body.message_id, 901, 'правится тот же message_id');
});

test('удалённый человеком экран пересоздаётся молча, без ошибки в чат', async (t) => {
  const f = await fixture(t);
  await f.say('/status');
  f.setFailEdits(true); // человек удалил сообщение: Telegram отвечает not found
  await f.say('/status');
  assert.equal(f.sends().length, 2, 'не поправилось — молча создан новый экран');
  assert.equal(f.sends().every((m) => !/⚠|не удалось|ошибка/iu.test(m.body.text)), true,
    'ошибка человеку не показывается');
  const state = await f.store.read();
  assert.equal(state.screen?.messageId, 902, 'в state запомнен новый id вместо старого');
});

test('кнопка «✕ Закрыть» удаляет экран из чата и забывает его', async (t) => {
  const f = await fixture(t);
  await f.say('/status');
  await f.tap('sc', 901);
  assert.deepEqual(f.deletes().map((c) => c.body.message_id), [901], 'экран удалён из чата');
  assert.equal((await f.store.read()).screen, null, 'экран забыт в state');
  assert.equal(f.answers().length, 1, 'callback отвечен');
});

test('экран с чужим ownerKey игнорируется: создаётся свой', async (t) => {
  const f = await fixture(t);
  await f.store.write({ screen: { messageId: 77, at: T0, ownerKey: `${f.accountRef}:${T0 - 1}:${OWNER_CHAT}` } });
  await f.say('/status');
  assert.equal(f.edits().length, 0, 'чужой экран не правим: message_id имеет смысл только у владельца');
  assert.equal(f.sends().length, 1, 'создан свой экран');
  assert.equal((await f.store.read()).screen?.messageId, 901, 'запомнен свой экран вместо чужого');
});

test('/help живёт на том же экране и несёт кнопку закрытия', async (t) => {
  const f = await fixture(t);
  await f.say('/status');
  await f.say('/help');
  assert.equal(f.sends().length, 1, 'подсказка правит экран, а не шлёт новое сообщение');
  const edit = f.edits()[0];
  assert.equal(edit.body.message_id, 901);
  assert.match(edit.body.text, /\/status/u);
  assert.equal(
    edit.body.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'sc'),
    true,
    'у экрана есть кнопка закрытия',
  );
});

test('кнопка задачи sd: правит существующий экран, нового сообщения нет', async (t) => {
  const f = await fixture(t);
  await f.say('/status'); // экран создан: message_id 901
  await f.tap('sd:4187:0', 901);
  assert.equal(f.sends().length, 1, 'второго сообщения не появилось');
  assert.equal(f.edits().length, 1, 'карточка задачи — правка экрана на месте');
  assert.equal(f.edits()[0].body.message_id, 901, 'правится тот же экран');
  assert.match(f.edits()[0].body.text, /Маршрут: feature/u);
  assert.equal((await f.store.read()).screen?.messageId, 901, 'экран по-прежнему записан в state');
});

test('кнопка плана po: правит существующий экран, нового сообщения нет', async (t) => {
  const f = await fixture(t);
  f.routes.set('GET /api/tasks/4187/doc/plan', { statusCode: 200, body: { text: '# Цель\nТекст плана.' } });
  await f.say('/status'); // экран создан: message_id 901
  await f.tap('po:4187', 4242); // нажатие пришло с ЖИВОЙ карточки
  assert.equal(f.sends().length, 1, 'страница плана не шлёт новое сообщение');
  const edit = f.edits()[0];
  assert.equal(edit.body.message_id, 901, 'план правит сохранённый экран, а не живую карточку 4242');
  assert.match(edit.body.text, /📄 План #4187/u);
});
