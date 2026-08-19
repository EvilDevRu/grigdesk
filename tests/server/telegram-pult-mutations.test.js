// Срез M телеграм-пульта: мутации (план, §4 «M» и §5.3 «Мутации (фаза 3)»).
//
// Три правила мутаций:
//  - всё, что стоит времени/денег, подтверждается ВТОРЫМ тапом с TTL 10 минут;
//    протухшее подтверждение — «запрос устарел», inject-а нет;
//  - индекс в callback_data — не источник истины: снимок списка живёт на сервере,
//    перед inject сверяется с живым состоянием (catalogHash, состав active);
//  - /task создаёт задачу только после предпросмотра; «Отмена» — ноль вызовов B24.
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

test('resume: первый тап — вопрос без inject, «Да» — inject, итог в карточке', async () => {
  const f = await fixture();
  await f.tap('r:4187');
  assert.equal(f.cockpit.calls.length, 0, 'первый тап ничего не запускает');
  assert.match(f.edits()[0].body.text, /Точно продолжить #4187/u);
  const buttons = f.edits()[0].body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(buttons, ['r:4187:y', 'x']);

  f.cockpit.set('POST', '/api/tasks/4187/resume', { statusCode: 200, body: { ok: true, outcome: 'launched' } });
  await f.tap('r:4187:y');
  assert.deepEqual(f.cockpit.calls[0], { method: 'POST', url: '/api/tasks/4187/resume', payload: {} });
  assert.match(f.edits()[1].body.text, /прогон продолжен/u);
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
});

test('«Отмена» на подтверждении гасит его: последующее «Да» уже не запускает', async () => {
  const f = await fixture();
  await f.tap('r:4187');
  await f.tap('x');
  assert.match(f.edits()[1].body.text, /Отменено/u);
  await f.tap('r:4187:y');
  assert.equal(f.cockpit.calls.length, 0);
});

// -------------------------------------------------------------- sandbox retry

test('sandbox retry: подтверждение → inject, downOutput доезжает текстом', async () => {
  const f = await fixture();
  await f.tap('sb:4188');
  assert.match(f.edits()[0].body.text, /снести остатки песочницы #4188/iu);
  f.cockpit.set('POST', '/api/tasks/4188/sandbox/retry', {
    statusCode: 200,
    body: { ok: true, retried: true, downOutput: 'схема db_t4188 удалена\nworktree снят' },
  });
  await f.tap('sb:4188:y');
  assert.equal(f.cockpit.calls[0].url, '/api/tasks/4188/sandbox/retry');
  assert.match(f.edits()[1].body.text, /остатки снесены, прогон продолжен/u);
  assert.match(f.edits()[1].body.text, /схема db_t4188 удалена/u);
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
});

// --------------------------------------------------------------------- /task

test('/task: предпросмотр, «Создать» — inject в B24, ответ с номером', async () => {
  const f = await fixture();
  await f.say('/task Починить экспорт CSV\nВыгрузка падает на файлах больше 10 МБ, в консоли TypeError');
  assert.equal(f.cockpit.calls.length, 0, 'предпросмотр не ходит в B24');
  const preview = f.sends()[0].body;
  assert.match(preview.text, /«Починить экспорт CSV»/u);
  assert.match(preview.text, /Создать\?/u);

  f.cockpit.set('POST', '/api/b24/tasks', { statusCode: 200, body: { id: 4201 } });
  await f.tap('tk:y', { messageId: 901 });
  assert.deepEqual(f.cockpit.calls[0].payload, {
    title: 'Починить экспорт CSV',
    description: 'Выгрузка падает на файлах больше 10 МБ, в консоли TypeError',
    priority: 1,
  });
  assert.match(f.edits()[0].body.text, /✓ Задача #4201 создана/u);
});

test('/task: «Отмена» — ни одного вызова B24', async () => {
  const f = await fixture();
  await f.say('/task Черновик недописанного');
  await f.tap('tk:n', { messageId: 901 });
  assert.equal(f.cockpit.calls.length, 0);
  assert.match(f.edits()[0].body.text, /не создана/u);
});

test('/task без заголовка — подсказка формата, без предпросмотра', async () => {
  const f = await fixture();
  await f.say('/task');
  assert.equal(f.sends().length, 1);
  assert.match(f.sends()[0].body.text, /Заголовок/u);
  assert.equal(f.cockpit.calls.length, 0);
});

// -------------------------------------------------------------------- /launch

const LAUNCH_OPTIONS = {
  statusCode: 200,
  body: {
    task: '4201',
    profile: 'proj',
    onConveyor: false,
    running: false,
    routes: ['feature', 'hunt'],
    defaultRoute: 'feature',
    catalogHash: 'hash-1',
  },
};

test('/launch: маршруты из опубликованного каталога, выбор по индексу сверяется со снимком', async () => {
  const f = await fixture();
  f.cockpit.set('GET', '/api/tasks/4201/launch-options', LAUNCH_OPTIONS);
  await f.say('/launch 4201');
  const menu = f.sends()[0].body;
  assert.match(menu.text, /каким маршрутом/u);
  const routeButtons = menu.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(routeButtons, ['l:4201:0', 'l:4201:1', 'x']);

  await f.tap('l:4201:1', { messageId: 901 });
  assert.match(f.edits()[0].body.text, /Запустить #4201 маршрутом hunt\?/u);
  assert.match(f.edits()[0].body.text, /20–25 минут/u);

  f.cockpit.set('GET', '/api/b24/task/4201', {
    statusCode: 200,
    body: { title: 'Починить экспорт CSV', description: '<p>Выгрузка падает</p>' },
  });
  f.cockpit.set('POST', '/api/tasks/4201/launch', (payload) => ({
    statusCode: 200, body: { outcome: 'launched', profile: payload.profile, route: payload.route },
  }));
  await f.tap('l:4201:1:y', { messageId: 901 });
  const launch = f.cockpit.posts().at(-1);
  assert.equal(launch.url, '/api/tasks/4201/launch');
  assert.equal(launch.payload.route, 'hunt');
  assert.equal(launch.payload.profile, 'proj');
  assert.equal(launch.payload.title, 'Починить экспорт CSV');
  assert.equal(launch.payload.description, 'Выгрузка падает');
  assert.match(f.edits().at(-1).body.text, /запущено маршрутом hunt/u);
});

test('/launch: разъехавшийся каталог — «изменился, открой заново», inject-а нет', async () => {
  const f = await fixture();
  f.cockpit.set('GET', '/api/tasks/4201/launch-options', LAUNCH_OPTIONS);
  await f.say('/launch 4201');
  await f.tap('l:4201:1', { messageId: 901 });

  // Между подтверждением и запуском каталог переиздали: hash сменился.
  f.cockpit.set('GET', '/api/tasks/4201/launch-options', {
    statusCode: 200,
    body: { ...LAUNCH_OPTIONS.body, routes: ['bug', 'feature', 'hunt'], catalogHash: 'hash-2' },
  });
  await f.tap('l:4201:1:y', { messageId: 901 });
  assert.equal(f.cockpit.posts().length, 0, 'запуск не случился');
  assert.match(f.edits().at(-1).body.text, /каталог маршрутов изменился/iu);
});

test('/launch по задаче уже на конвейере — честный отказ без списка', async () => {
  const f = await fixture();
  f.cockpit.set('GET', '/api/tasks/4201/launch-options', {
    statusCode: 200, body: { ...LAUNCH_OPTIONS.body, onConveyor: true, running: true },
  });
  await f.say('/launch 4201');
  assert.match(f.sends()[0].body.text, /уже на конвейере/u);
});

// ---------------------------------------------------------------------- /stop

test('/stop: список из chat/active, выбор через снимок, подтверждение — стоп', async () => {
  const f = await fixture();
  f.cockpit.set('GET', '/api/chat/active', {
    statusCode: 200,
    body: { active: [{ chatKey: 'chat-alpha-1', startedAt: T0, tokens: 1500 }] },
  });
  await f.say('/stop');
  const menu = f.sends()[0].body;
  assert.match(menu.text, /Какой ход остановить/u);
  assert.equal(menu.reply_markup.inline_keyboard[0][0].callback_data, 'st:0');

  await f.tap('st:0', { messageId: 901 });
  assert.match(f.edits()[0].body.text, /Остановить ход агента/u);

  f.cockpit.set('POST', '/api/chat/stop', { statusCode: 200, body: { ok: true } });
  await f.tap('st:0:y', { messageId: 901 });
  const stop = f.cockpit.posts().at(-1);
  assert.equal(stop.url, '/api/chat/stop');
  assert.deepEqual(stop.payload, { chatKey: 'chat-alpha-1' });
  assert.match(f.edits().at(-1).body.text, /⏹/u);
});

test('/stop: ход успел завершиться — «уже завершился», стоп не уезжает', async () => {
  const f = await fixture();
  f.cockpit.set('GET', '/api/chat/active', {
    statusCode: 200,
    body: { active: [{ chatKey: 'chat-alpha-1', startedAt: T0, tokens: 1500 }] },
  });
  await f.say('/stop');
  await f.tap('st:0', { messageId: 901 });
  f.cockpit.set('GET', '/api/chat/active', { statusCode: 200, body: { active: [] } });
  await f.tap('st:0:y', { messageId: 901 });
  assert.equal(f.cockpit.posts().length, 0);
  assert.match(f.edits().at(-1).body.text, /уже завершился/u);
});

test('/stop при пустом списке — «сейчас никто не идёт»', async () => {
  const f = await fixture();
  f.cockpit.set('GET', '/api/chat/active', { statusCode: 200, body: { active: [] } });
  await f.say('/stop');
  assert.match(f.sends()[0].body.text, /ни один агент.*не идёт/iu);
});

// ------------------------------------------------------------- таймер и B24

test('/timer, /complete, /renew: парсинг и inject в ручки B24; ошибка — словами', async () => {
  const f = await fixture();
  f.cockpit.set('POST', '/api/b24/task/4201/timer/start', { statusCode: 200, body: { ok: true } });
  await f.say('/timer 4201 start');
  assert.equal(f.cockpit.posts()[0].url, '/api/b24/task/4201/timer/start');
  assert.match(f.sends()[0].body.text, /✓ #4201: таймер — start/u);

  await f.say('/timer 4201 dance');
  assert.match(f.sends()[1].body.text, /start\|pause\|stop/u);

  f.cockpit.set('POST', '/api/b24/task/4201/complete', {
    statusCode: 502, body: { error: 'telegram_unreachable', message: 'портал не ответил' },
  });
  await f.say('/complete 4201');
  assert.match(f.sends()[2].body.text, /⚠ #4201: портал не ответил/u);

  f.cockpit.set('POST', '/api/b24/task/4201/renew', { statusCode: 200, body: { ok: true } });
  await f.say('/renew 4201');
  assert.match(f.sends()[3].body.text, /возобновлена/u);
});

// ----------------------------------------------------------------- owner-гейт

test('мутация от не-владельца — молча ноль вызовов (общий owner-гейт)', async () => {
  const f = await fixture();
  await f.tap('r:4187:y', { from: { id: 999, name: 'Некто', username: '' } });
  await f.say('/task Чужая задача', { from: { id: 999, name: 'Некто', username: '' } });
  assert.equal(f.cockpit.calls.length, 0);
  assert.equal(f.botCalls.length, 0);
});
