// Срез W телеграм-пульта: вотчер «требует человека» (docs/plans/telegram-pult-plan.md, §5.2).
//
// Обещания:
//  - оповещение только на переходе «не ждала → ждёт»: одна карточка на повод,
//    повторный обход без изменений — ноль отправок;
//  - первый снимок после старта — silent: уже ждущие ворота state заполняют,
//    но карточек не порождают (правило notify-watch в web);
//  - «рестарт» (новый инстанс + сохранённый pult-state.json) не шлёт повторно,
//    а карточку ушедшего повода редактирует по СОХРАНЁННОМУ message_id;
//  - молчание ключуется задача:этап — следующий зависший этап это новая беда;
//  - чат: карточки вопросов/разрешений строятся из /api/chat/waiting; фантомы
//    (после рестарта сервера pendingPerms умирают) закрываются тем же путём;
//  - отказ Telegram не роняет вотчер и не портит state: карточка уйдёт следующим
//    обходом;
//  - порог молчания берётся из ответа /api/tasks (silenceWindow), не из константы;
//  - вотчер и /status считают одним правилом (pipeline-wait/agent-activity).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CARD_UI_VERSION, TelegramPultWatch } from '../../server/src/lib/telegram/pult/watch.js';
import { TelegramPultStateStore } from '../../server/src/lib/telegram/pult/state-store.js';
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

const gateGraph = () => ({
  route: 'feature',
  pos: { plan: [0, 0], gate_plan: [1, 0] },
  statuses: { plan: 'done', gate_plan: 'wait' },
  nodes: { gate_plan: ['human', '📝 Ворота плана', ''] },
  keys: { gate_plan: 'GATE_PLAN' },
});

/** Идущий маршрут: есть текущий узел, прогресс и замер работы. */
const runningGraph = (overrides = {}) => ({
  route: 'feature',
  pos: { plan: [0, 0], build: [1, 0] },
  statuses: { plan: 'done', build: 'run' },
  nodes: { plan: ['agent', '📋 План', ''], build: ['agent', '🔨 Сборка', ''] },
  keys: {},
  progress: { done: 1, total: 2, current: 'build' },
  timing: { workSec: 4_200, approximate: true },
  ...overrides,
});

/** Идущая задача в ответе /api/tasks: attempt обязателен — по нему ключуется карточка. */
const runningTask = (overrides = {}) => ({
  task: 4190,
  title: 'Экспорт CSV',
  daemonAlive: true,
  attempt: 'a_0123456789abcdef',
  silence: { stage: 'BUILD', sec: 12, tool: null },
  ...overrides,
});

/** Мутируемая картина мира: тесты меняют поля между обходами. */
function worldOf() {
  return {
    tasks: [],
    silenceWindow: 900,
    graphs: {},
    waiting: [],
  };
}

function fakeApi(world) {
  const calls = [];
  return {
    calls,
    callApi: async (method, url, payload) => {
      calls.push({ method, url, payload });
      if (url === '/api/tasks') {
        return { statusCode: 200, body: { tasks: world.tasks, silenceWindow: world.silenceWindow } };
      }
      const graph = url.match(/^\/api\/tasks\/(\d+)\/graph$/u);
      if (graph) {
        const body = world.graphs[graph[1]] || {};
        if (body.__statusCode) return { statusCode: body.__statusCode, body: { error: 'not_found' } };
        return { statusCode: 200, body };
      }
      if (url === '/api/chat/waiting') return { statusCode: 200, body: { waiting: world.waiting } };
      return { statusCode: 404, body: { error: 'not_found' } };
    },
  };
}

async function fixture(t, { confirmed = true, stateFile = null, liveEditMinMs } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-pult-watch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const sends = [];
  let failSends = false;
  let unchangedEdits = false;
  let failDeletes = false;
  let notFoundDeletes = false;
  const botApi = {
    getMe: async () => ({ id: BOT_ID, username: 'example_pult_bot' }),
    callBotApi: async (token, method, body) => {
      if (failSends) throw Object.assign(new Error('telegram down'), { kind: 'transport' });
      sends.push({ token, method, body });
      if (unchangedEdits && method === 'editMessageText') {
        throw Object.assign(new Error('Bad Request: message is not modified'), { kind: 'telegram' });
      }
      if (notFoundDeletes && method === 'deleteMessage') {
        throw Object.assign(new Error('Bad Request: message to delete not found'), { kind: 'telegram' });
      }
      if (failDeletes && method === 'deleteMessage') {
        throw Object.assign(new Error('telegram down'), { kind: 'transport' });
      }
      return { message_id: 100 + sends.length };
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
    await seed.context.botSettings.setPult({
      chatId: OWNER_CHAT, userId: OWNER_CHAT, confirmedAtMs: T0,
    });
  }
  await seed.release();

  let clock = T0;
  const world = worldOf();
  const api = fakeApi(world);
  const file = stateFile || path.join(dir, 'pult-state.json');
  const store = new TelegramPultStateStore({ file, log: silent });
  const watch = new TelegramPultWatch({
    acquireLease: () => connection.acquireLease(),
    isEnabled: () => true,
    callApi: api.callApi,
    stateStoreFor: () => store,
    queue: new PultSendQueue({ pauseMs: 0 }),
    now: () => clock,
    log: silent,
    ...(liveEditMinMs === undefined ? {} : { liveEditMinMs }),
  });

  return {
    world,
    watch,
    store,
    file,
    connection,
    ownerKey: `${accountRef}:${T0}:${OWNER_CHAT}`,
    accountRef,
    sends,
    advance: (ms) => { clock += ms; },
    setFailSends: (value) => { failSends = value; },
    setUnchangedEdits: (value) => { unchangedEdits = value; },
    setFailDeletes: (value) => { failDeletes = value; },
    setNotFoundDeletes: (value) => { notFoundDeletes = value; },
    messages: () => sends.filter((c) => c.method === 'sendMessage'),
    edits: () => sends.filter((c) => c.method === 'editMessageText'),
    deletes: () => sends.filter((c) => c.method === 'deleteMessage'),
  };
}

test('переход «не ждала → ждёт»: ровно одна карточка, повтор без изменений — ноль', async (t) => {
  const { world, watch, store, messages } = await fixture(t);
  await watch.check(); // первый снимок пустого мира — silent и пустой
  assert.equal(messages().length, 0);

  world.tasks = [{ task: 4187, daemonAlive: false }];
  world.graphs['4187'] = gateGraph();
  await watch.check();
  assert.equal(messages().length, 1);
  const card = messages()[0].body;
  assert.equal(card.chat_id, OWNER_CHAT);
  assert.match(card.text, /#4187 ждёт тебя/u);
  assert.match(card.text, /утвердить план работ/u);
  assert.equal('parse_mode' in card, false);
  const buttons = (card.reply_markup?.inline_keyboard || []).flat();
  assert.deepEqual(buttons.map((b) => b.callback_data), [
    'po:4187', 'g:4187:GATE_PLAN:a', 'g:4187:GATE_PLAN:r',
  ]);
  assert.deepEqual((await store.read()).cards['wait:4187'].replyAction, {
    kind: 'gate-reject', taskId: '4187', gateKey: 'GATE_PLAN',
  });

  await watch.check();
  await watch.check();
  assert.equal(messages().length, 1, 'повторные обходы не спамят');
});

test('первый снимок silent: уже ждущие ворота заполняют state без отправок', async (t) => {
  const { world, watch, store, messages } = await fixture(t);
  world.tasks = [{ task: 4187, daemonAlive: false }];
  world.graphs['4187'] = gateGraph();
  await watch.check();
  assert.equal(messages().length, 0);
  const saved = await store.read();
  assert.equal('wait:4187' in saved.cards, true);
  assert.equal(saved.cards['wait:4187'].messageId, null);
});

test('рестарт: новый инстанс не шлёт повторно, а карточка ушедшего повода удаляется по сохранённому message_id', async (t) => {
  const first = await fixture(t);
  await first.watch.check(); // прайм пустого мира
  first.world.tasks = [{ task: 4187, daemonAlive: false }];
  first.world.graphs['4187'] = gateGraph();
  await first.watch.check();
  assert.equal(first.messages().length, 1);
  const sentId = 101; // первый message_id фейка

  // «Рестарт»: новый вотчер на том же файле состояния, та же картина мира.
  const second = await fixture(t, { stateFile: first.file });
  second.world.tasks = [{ task: 4187, daemonAlive: false }];
  second.world.graphs['4187'] = gateGraph();
  await second.watch.check();
  assert.equal(second.messages().length, 0, 'о воротах уже сказано до рестарта');

  // Повод ушёл (решили из браузера) — карточка удаляется по сохранённому message_id.
  second.world.graphs['4187'] = { ...gateGraph(), statuses: { plan: 'done', gate_plan: 'done' } };
  await second.watch.check();
  const deletes = second.deletes();
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].body.message_id, sentId);
  assert.equal(deletes[0].body.chat_id, OWNER_CHAT);
  assert.equal(second.edits().length, 0, 'карточка не правится в «✓ решено» — она удаляется');
});

test('молчание ключуется задача:этап и подчиняется порогу из ответа /api/tasks', async (t) => {
  const { world, watch, messages, deletes } = await fixture(t);
  await watch.check();

  // Ниже порога — карточки нет.
  world.tasks = [{ task: 4189, daemonAlive: true, silence: { sec: 500, stage: 'BUILD', tool: null } }];
  await watch.check();
  assert.equal(messages().length, 0);

  // Порог сервера ужали — та же цифра стала бедой.
  world.silenceWindow = 300;
  await watch.check();
  assert.equal(messages().length, 1);
  assert.match(messages()[0].body.text, /💤 #4189/u);

  // Тот же этап молчит дальше — карточка одна.
  world.tasks = [{ task: 4189, daemonAlive: true, silence: { sec: 900, stage: 'BUILD', tool: null } }];
  await watch.check();
  assert.equal(messages().length, 1);

  // Следующий этап завис — это новая беда: старая карточка удаляется, приходит новая.
  world.tasks = [{ task: 4189, daemonAlive: true, silence: { sec: 400, stage: 'TESTS', tool: 'Bash' } }];
  await watch.check();
  assert.equal(messages().length, 2);
  assert.match(messages()[1].body.text, /tests/u);
  assert.equal(deletes().length, 1, 'карточка BUILD удалена, а не отредактирована в решено');
});

test('затык даёт карточку с кнопкой восстановления по виду затыка', async (t) => {
  const { world, watch, messages } = await fixture(t);
  await watch.check();
  world.tasks = [
    { task: 4188, daemonAlive: false, stall: { kind: 'crashed', stage: 'SANDBOX', title: 'подъём песочницы упал' } },
    { task: 4187, daemonAlive: false, stall: { kind: 'crashed', stage: 'BUILD', title: 'оркестратор оборвался' } },
  ];
  await watch.check();
  assert.equal(messages().length, 2);
  const byTask = Object.fromEntries(messages().map((m) => [m.body.text.match(/#(\d+)/u)[1], m.body]));
  assert.match(byTask['4188'].text, /песочницы/u);
  assert.equal(byTask['4188'].reply_markup.inline_keyboard[0][0].callback_data, 'sb:4188');
  assert.equal(byTask['4187'].reply_markup.inline_keyboard[0][0].callback_data, 'r:4187');
});

test('чат: вопрос из /api/chat/waiting даёт карточку с вариантами, фантом удаляется', async (t) => {
  const { world, watch, store, messages, deletes } = await fixture(t);
  await watch.check();
  world.waiting = [{
    pid: 'p1abc',
    chatKey: 'c1',
    at: T0,
    questions: [{
      question: 'Какой способ миграции выбрать?',
      header: 'Миграция',
      multiSelect: false,
      options: [{ label: 'Одним скриптом' }, { label: 'Поэтапно' }],
    }],
  }];
  await watch.check();
  assert.equal(messages().length, 1);
  const card = messages()[0].body;
  assert.match(card.text, /Какой способ миграции выбрать\?/u);
  const rows = card.reply_markup.inline_keyboard;
  assert.deepEqual(rows.map((r) => r[0].callback_data), ['q:p1abc:0', 'q:p1abc:1', 'q:p1abc:txt']);
  assert.deepEqual((await store.read()).cards['q:p1abc'].replyAction, {
    kind: 'question-text', pid: 'p1abc',
  });

  // Ответили из браузера (или сервер рестартовал и pendingPerms умерли) — карточка удаляется.
  world.waiting = [];
  await watch.check();
  assert.equal(deletes().length, 1);
  assert.equal(deletes()[0].body.message_id, 101, 'удаляется карточка вопроса по сохранённому message_id');
});

test('чат: запрос разрешения показывает инструмент и превью команды', async (t) => {
  const { world, watch, store, messages } = await fixture(t);
  await watch.check();
  world.waiting = [{
    pid: 'p2xyz', chatKey: 'c1', at: T0, tool: 'Bash', input: { command: 'npm run build && bash tests/run-all.sh' },
  }];
  await watch.check();
  assert.equal(messages().length, 1);
  const card = messages()[0].body;
  assert.match(card.text, /Bash: npm run build/u);
  const flat = card.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(flat, ['p:p2xyz:a', 'p:p2xyz:d', 'p:p2xyz:c']);
  assert.deepEqual((await store.read()).cards['perm:p2xyz'].replyAction, {
    kind: 'perm-deny', pid: 'p2xyz',
  });
});

test('чат: structured form и external URL в Telegram только зовут в Cockpit', async (t) => {
  const { world, watch, store, messages } = await fixture(t);
  await watch.check();
  world.waiting = [
    {
      pid: 'form-private',
      chatKey: 'c1',
      chatTitle: 'Настройка деплоя',
      at: T0,
      structured: true,
      source: 'MCP · deploy',
      prompt: 'Заполни параметры окружения',
      questions: [{
        key: 'secret_mode',
        question: 'Скрытый параметр',
        options: [{ value: 'private-value', label: 'Секретный вариант' }],
      }],
    },
    {
      pid: 'url-private',
      chatKey: 'c1',
      chatTitle: 'Установка инструмента',
      at: T0,
      tool: 'MCP · installer',
      canRemember: false,
      input: {
        kind: 'external_url',
        description: 'Заверши установку во внешнем сервисе.',
        url: 'https://example.test/install?token=private-token',
      },
    },
  ];

  await watch.check();

  assert.equal(messages().length, 2);
  for (const message of messages()) {
    assert.match(message.body.text, /Заверши в Cockpit\./u);
    assert.equal('reply_markup' in message.body, false);
  }
  const allText = messages().map((message) => message.body.text).join('\n');
  assert.equal(allText.includes('Секретный вариант'), false);
  assert.equal(allText.includes('private-token'), false);

  const cards = (await store.read()).cards;
  assert.equal(cards['q:form-private'].replyAction, undefined);
  assert.equal(cards['perm:url-private'].replyAction, undefined);
});

test('Telegram-вотчер fail-closed не показывает SSH-подтверждение даже из грязного snapshot', async (t) => {
  const { world, watch, store, messages } = await fixture(t);
  await watch.check();
  world.waiting = [{
    pid: 'ssh-private-pid',
    origin: 'ssh',
    chatKey: 'chat-a',
    at: T0,
    server: { label: 'Боевой код', host: 'SSH_PRIVATE_HOST_91006', port: 22 },
    user: 'SSH_PRIVATE_USER_91006',
    command: 'SSH_PRIVATE_COMMAND_91006',
  }];
  await watch.check();

  assert.deepEqual({
    messages: messages().length,
    cards: Object.keys((await store.read()).cards),
  }, {
    messages: 0,
    cards: [],
  });
});

test('отказ Telegram не роняет вотчер и не портит state: карточка уходит следующим обходом', async (t) => {
  const { world, watch, store, messages, setFailSends } = await fixture(t);
  await watch.check();
  world.tasks = [{ task: 4187, daemonAlive: false }];
  world.graphs['4187'] = gateGraph();

  setFailSends(true);
  await watch.check(); // не бросает
  assert.equal(messages().length, 0);
  assert.deepEqual((await store.read()).cards, {}, 'неотправленное не записано как отправленное');

  setFailSends(false);
  await watch.check();
  assert.equal(messages().length, 1, 'после восстановления связи карточка ушла');
});

test('неподтверждённый пульт: вотчер молчит и не ходит в API кокпита', async (t) => {
  const { world, watch, messages } = await fixture(t, { confirmed: false });
  world.tasks = [{ task: 4187, daemonAlive: false }];
  world.graphs['4187'] = gateGraph();
  await watch.check();
  await watch.check();
  assert.equal(messages().length, 0);
});

test('/status: сводка поимённо тем же правилом, что чип навигации', async (t) => {
  const { world, watch } = await fixture(t);
  await watch.check();
  world.tasks = [
    { task: 4187, daemonAlive: false },
    { task: 4188, daemonAlive: false, stall: { kind: 'crashed', stage: 'BUILD', title: 'оркестратор оборвался' } },
    { task: 4190, daemonAlive: true },
  ];
  world.graphs['4187'] = gateGraph();
  const text = await watch.statusSummary();
  assert.match(text, /⏳ ждут твоего решения: 1/u);
  assert.match(text, /#4187: утвердить план работ/u);
  assert.match(text, /🛑 встали: 1/u);
  assert.match(text, /#4188/u);
  assert.match(text, /🔵 в работе: 1/u);

  const snapshot = await watch.statusSnapshot();
  assert.equal(snapshot.tasks.length, 3);
  assert.equal(snapshot.tasks[0].task, '4187');
  assert.equal(snapshot.tasks[0].graph.progress, undefined, 'fixture graph без progress остаётся честно неполным');

  world.tasks = [];
  world.graphs = {};
  const calm = await watch.statusSummary();
  assert.match(calm, /спокойно/iu);
});

test('структурированный status сохраняет title/graph, а ошибка graph не выкидывает задачу', async (t) => {
  const { world, watch } = await fixture(t);
  world.tasks = [
    { task: 4187, title: 'Починить экспорт CSV', daemonAlive: true },
    { task: 4188, title: 'Повреждённый pin', daemonAlive: false },
  ];
  world.graphs['4187'] = {
    ...gateGraph(),
    progress: { done: 1, total: 2, current: 'gate_plan' },
  };
  world.graphs['4188'] = { __statusCode: 404 };
  const snapshot = await watch.statusSnapshot();
  assert.equal(snapshot.tasks.length, 2);
  assert.equal(snapshot.tasks[0].title, 'Починить экспорт CSV');
  assert.deepEqual(snapshot.tasks[0].graph.progress, { done: 1, total: 2, current: 'gate_plan' });
  assert.equal(snapshot.tasks[1].graph, null, 'ошибка graph не удаляет задачу из обзора');
});

test('старая сохранённая карточка получает новые кнопки без повторного сообщения', async (t) => {
  const { world, watch, store, messages, edits, ownerKey } = await fixture(t);
  await store.write({
    cards: {
      'wait:4187': { messageId: 77, kind: 'gate', subject: '#4187', at: T0, ownerKey },
    },
  });
  world.tasks = [{ task: 4187, title: 'План миграции', daemonAlive: false }];
  world.graphs['4187'] = gateGraph();
  await watch.check();
  assert.equal(messages().length, 0);
  assert.equal(edits().length, 1);
  assert.equal(edits()[0].body.message_id, 77);
  assert.deepEqual(
    edits()[0].body.reply_markup.inline_keyboard.flat().map((button) => button.callback_data),
    ['po:4187', 'g:4187:GATE_PLAN:a', 'g:4187:GATE_PLAN:r'],
  );
  assert.equal((await store.read()).cards['wait:4187'].uiVersion, CARD_UI_VERSION);
});

test('неизменившаяся старая карточка помечается обновлённой и не ретраится вечно', async (t) => {
  const { world, watch, store, edits, setUnchangedEdits, ownerKey } = await fixture(t);
  await store.write({
    cards: {
      'wait:4187': { messageId: 77, kind: 'gate', subject: '#4187', at: T0, ownerKey },
    },
  });
  world.tasks = [{ task: 4187, daemonAlive: false }];
  world.graphs['4187'] = gateGraph();
  setUnchangedEdits(true);

  await watch.check();
  assert.equal(edits().length, 1);
  assert.equal((await store.read()).cards['wait:4187'].uiVersion, CARD_UI_VERSION);

  await watch.check();
  assert.equal(edits().length, 1, 'версия сохранена, повторной миграции нет');
});

test('смена привязки не редактирует message_id из лички прежнего владельца', async (t) => {
  const { world, watch, store, edits, connection, ownerKey, accountRef } = await fixture(t);
  await store.write({
    cards: {
      'wait:4187': {
        messageId: 77, kind: 'gate', subject: '#4187', at: T0, ownerKey, uiVersion: CARD_UI_VERSION,
      },
    },
  });
  world.tasks = [{ task: 4187, daemonAlive: false }];
  world.graphs['4187'] = gateGraph();

  const reboundChat = OWNER_CHAT + 1;
  const reboundAt = T0 + 1;
  const lease = connection.acquireLease();
  await lease.context.botSettings.setPult({
    chatId: reboundChat, userId: reboundChat, confirmedAtMs: reboundAt,
  });
  await lease.release();

  await watch.check();
  assert.equal(edits().length, 0, 'старое сообщение в новом chat_id не трогаем');
  const card = (await store.read()).cards['wait:4187'];
  assert.equal(card.messageId, null, 'для новой привязки это silent-снимок');
  assert.equal(card.ownerKey, `${accountRef}:${reboundAt}:${reboundChat}`);
});

// --------------------------------------------------- живая карточка и исход прогона

test('живая карточка прогона: тихое сообщение с узлом, прогрессом и активностью', async (t) => {
  const { world, watch, messages } = await fixture(t);
  await watch.check(); // первый снимок пустого мира — silent

  world.tasks = [runningTask()];
  world.graphs['4190'] = runningGraph();
  await watch.check();

  assert.equal(messages().length, 1, 'идущий прогон даёт ровно одну карточку');
  const card = messages()[0].body;
  assert.equal(card.disable_notification, true, 'живая карточка не будит телефон');
  assert.equal('parse_mode' in card, false);
  assert.match(card.text, /🔵 #4190 — Экспорт CSV/u);
  assert.match(card.text, /Сейчас: 🔨 Сборка · выполняется/u);
  assert.match(card.text, /Прогресс маршрута: 1\/2 · 50%/u);
  assert.match(card.text, /Агент: агент пишет/u, 'свежий журнал читается как работа');
  assert.match(card.text, /Работа: ≈1 ч 10 мин/u);
  assert.deepEqual(
    card.reply_markup.inline_keyboard.flat().map((b) => b.callback_data),
    ['sm:4190', 'po:4190'],
    'узлы и план открываются новым сообщением: живую карточку правит вотчер',
  );
});

test('живая карточка: смена узла правит на месте, неизменное состояние молчит', async (t) => {
  const { world, watch, messages, edits } = await fixture(t);
  await watch.check();
  world.tasks = [runningTask()];
  world.graphs['4190'] = runningGraph();
  await watch.check();
  assert.equal(messages().length, 1);

  await watch.check();
  assert.equal(edits().length, 0, 'ничего не изменилось — правки нет');

  world.graphs['4190'] = runningGraph({
    statuses: { plan: 'done', build: 'done', verify: 'run' },
    pos: { plan: [0, 0], build: [1, 0], verify: [2, 0] },
    nodes: {
      plan: ['agent', '📋 План', ''],
      build: ['agent', '🔨 Сборка', ''],
      verify: ['agent', '🔍 Проверка', ''],
    },
    progress: { done: 2, total: 3, current: 'verify' },
  });
  await watch.check();
  assert.equal(edits().length, 1, 'смена узла правится немедленно, не дожидаясь таймера');
  assert.equal(messages().length, 1, 'второго сообщения не появилось');
  assert.match(edits()[0].body.text, /Сейчас: 🔍 Проверка/u);
});

test('живая карточка: тикающие минуты молчания правятся не чаще остывания', async (t) => {
  const { world, watch, edits, advance } = await fixture(t, { liveEditMinMs: 60_000 });
  await watch.check();
  world.tasks = [runningTask()];
  world.graphs['4190'] = runningGraph();
  await watch.check();

  // Узел тот же, изменилась только цифра молчания — правка ждёт остывания.
  world.tasks = [runningTask({ silence: { stage: 'BUILD', sec: 300, tool: 'Bash' } })];
  await watch.check();
  assert.equal(edits().length, 0, 'пока таймер не остыл, в Telegram не ходим');

  advance(61_000);
  await watch.check();
  assert.equal(edits().length, 1, 'после остывания карточка догоняет реальность');
  assert.match(edits()[0].body.text, /Агент: нет событий 5 мин \(Bash\)/u);
});

test('исход прогона: done звонит отдельным сообщением, живая карточка удаляется', async (t) => {
  const { world, watch, messages, edits, deletes } = await fixture(t);
  await watch.check();
  world.tasks = [runningTask()];
  world.graphs['4190'] = runningGraph();
  await watch.check();
  assert.equal(messages().length, 1);
  const liveId = 101; // первый message_id фейка — живая карточка

  world.tasks = [runningTask({
    daemonAlive: false,
    result: 'completed',
    silence: null,
  })];
  world.graphs['4190'] = runningGraph({
    statuses: { plan: 'done', build: 'done' },
    progress: { done: 2, total: 2, current: null },
  });
  await watch.check();

  const finish = messages()[1];
  assert.ok(finish, 'исход приходит новым сообщением: правка push не даёт');
  assert.equal(finish.body.disable_notification, undefined, 'доехавший маршрут звонит');
  assert.match(finish.body.text, /✅ #4190 — Экспорт CSV: маршрут завершён/u);
  assert.match(finish.body.text, /Прошло узлов: 2\/2 · 100%/u);

  assert.deepEqual(deletes().map((c) => c.body.message_id), [liveId],
    'живая карточка удаляется: рядом уже стоит done: с тем же итогом');
  assert.equal(edits().length, 0, 'живая карточка не правится в исход — она удаляется');
  assert.equal(deletes().some((c) => c.body.message_id === 102), false,
    'карточка исхода done: неприкосновенна');
});

test('служебный исход не будит: recovered и human-rewind приходят тихо', async (t) => {
  const { world, watch, messages } = await fixture(t);
  await watch.check();
  world.tasks = [runningTask()];
  world.graphs['4190'] = runningGraph();
  await watch.check();

  world.tasks = [runningTask({ daemonAlive: false, result: 'human-rewind', silence: null })];
  await watch.check();
  const finish = messages()[1];
  assert.equal(finish.body.disable_notification, true, 'возврат сделал сам человек — звонить незачем');
  assert.match(finish.body.text, /возврат человеком/u);
});

test('архивация задачи не затирает исход общим «✓ решено»', async (t) => {
  const { world, watch, edits, deletes, store } = await fixture(t);
  await watch.check();
  world.tasks = [runningTask({ daemonAlive: false, result: 'completed', silence: null })];
  world.graphs['4190'] = runningGraph({ progress: { done: 2, total: 2, current: null } });
  await watch.check();
  const afterFinish = edits().length;
  const deletesAfterFinish = deletes().length;

  world.tasks = [];
  world.graphs = {};
  await watch.check();
  assert.equal(edits().length, afterFinish, 'липкие карточки просто забываются');
  assert.equal(deletes().length, deletesAfterFinish, 'архивация ничего не удаляет: done: остаётся в чате');
  const saved = await store.read();
  assert.equal(Object.keys(saved.cards).length, 0, 'ушедшая задача не копится в state');
});

test('прогон без attempt живой карточки не получает: ключевать её нечем', async (t) => {
  const { world, watch, messages } = await fixture(t);
  await watch.check();
  world.tasks = [{ task: 4187, title: 'Исторический реестр', daemonAlive: true }];
  world.graphs['4187'] = runningGraph();
  await watch.check();
  assert.equal(messages().length, 0);
});

test('карточка вопроса называет чат и раскрывает варианты, а не голое «чат»', async (t) => {
  const { world, watch, messages } = await fixture(t);
  await watch.check();
  world.waiting = [{
    pid: 'p9zz',
    chatKey: 'c9',
    chatTitle: 'Телеграм-пульт мусор',
    taskId: null,
    at: T0,
    questions: [{
      header: 'Объём',
      question: 'Что именно выпиливаем?',
      multiSelect: false,
      options: [
        { label: 'Контракт + фикстуры', description: 'План оставить как есть.' },
        { label: 'Всё, включая план' },
      ],
    }],
  }];
  await watch.check();

  const card = messages()[0].body;
  assert.match(card.text, /❓ Телеграм-пульт мусор — вопрос агента/u, 'без имени чата вопрос неотвечаем');
  assert.match(card.text, /Тема: Объём/u);
  assert.match(card.text, /1\) Контракт \+ фикстуры\n {3}План оставить как есть\./u);
  assert.equal(card.reply_markup.inline_keyboard[0][0].text.startsWith('1) '), true);
});

test('карточка разрешения тоже называет чат, а задача — номером', async (t) => {
  const { world, watch, messages } = await fixture(t);
  await watch.check();
  world.waiting = [{
    pid: 'p8yy',
    chatKey: 'c8',
    chatTitle: 'Починить экспорт',
    taskId: '4187',
    at: T0,
    tool: 'Bash',
    input: { command: 'rm -rf dist' },
  }];
  await watch.check();
  assert.match(messages()[0].body.text, /🔐 #4187 — Починить экспорт — агент просит разрешение/u);
});

// ------------------------------------- удаление решённых карточек и live/done (t91001)

test('отказ deleteMessage ушедшего повода не роняет обход: ключ сохраняется до следующего', async (t) => {
  const { world, watch, store, deletes, setFailDeletes } = await fixture(t);
  await watch.check();
  world.tasks = [{ task: 4187, daemonAlive: false }];
  world.graphs['4187'] = gateGraph();
  await watch.check();

  world.graphs['4187'] = { ...gateGraph(), statuses: { plan: 'done', gate_plan: 'done' } };
  setFailDeletes(true);
  await watch.check(); // не бросает
  assert.equal(deletes().length, 1, 'попытка удаления была');
  assert.equal('wait:4187' in (await store.read()).cards, true,
    'не удалено — не записано как успех: карточка остаётся в state для повтора');

  setFailDeletes(false);
  await watch.check();
  assert.equal('wait:4187' in (await store.read()).cards, false, 'после удаления ключ забыт');
});

test('удаление «message to delete not found» — человек уже удалил сам: ключ забывается', async (t) => {
  const { world, watch, store, deletes, setNotFoundDeletes } = await fixture(t);
  await watch.check();
  world.tasks = [{ task: 4187, daemonAlive: false }];
  world.graphs['4187'] = gateGraph();
  await watch.check();

  world.graphs['4187'] = { ...gateGraph(), statuses: { plan: 'done', gate_plan: 'done' } };
  setNotFoundDeletes(true);
  await watch.check();
  assert.equal(deletes().length, 1);
  assert.equal('wait:4187' in (await store.read()).cards, false, 'повторно удалять нечего — ключ забыт');
});

test('после удаления живая карточка не воскресает: в чате ровно одно итоговое сообщение', async (t) => {
  const { world, watch, store, messages, deletes } = await fixture(t);
  await watch.check();
  world.tasks = [runningTask()];
  world.graphs['4190'] = runningGraph();
  await watch.check();

  world.tasks = [runningTask({ daemonAlive: false, result: 'completed', silence: null })];
  world.graphs['4190'] = runningGraph({
    statuses: { plan: 'done', build: 'done' },
    progress: { done: 2, total: 2, current: null },
  });
  await watch.check();
  const sendsAfterFinish = messages().length;
  const saved = await store.read();
  assert.equal(saved.cards['live:4190:a_0123456789abcdef'].messageId, null,
    'удалённая живая карточка хранится надгробием без message_id');

  await watch.check();
  assert.equal(messages().length, sendsAfterFinish, 'повторной отправки live нет');
  assert.equal(deletes().length, 1, 'и повторного удаления нет');
});

test('прогон доехал, пока сервер лежал: silent done не удаляет живую карточку — она правится в исход', async (t) => {
  const first = await fixture(t);
  await first.watch.check();
  first.world.tasks = [runningTask()];
  first.world.graphs['4190'] = runningGraph();
  await first.watch.check();
  assert.equal(first.messages().length, 1, 'живая карточка отправлена до «падения»');

  // «Сервер лежал»: прогон доехал без вотчера. Новый инстанс на том же state,
  // первый обход — silent-снимок: done: известен только ключом, сообщения нет.
  const second = await fixture(t, { stateFile: first.file });
  second.world.tasks = [runningTask({ daemonAlive: false, result: 'completed', silence: null })];
  second.world.graphs['4190'] = runningGraph({
    statuses: { plan: 'done', build: 'done' },
    progress: { done: 2, total: 2, current: null },
  });
  await second.watch.check();
  assert.equal(second.deletes().length, 0,
    'done: не отправлен (messageId: null) — живую карточку удалять нельзя, она единственная запись об исходе');
  assert.equal(second.messages().length, 0, 'silent-снимок ничего не отправляет');
  assert.equal(second.edits().length, 1,
    'но живая карточка правится в исход: замороженное «прогон идёт» исходом не считается');
  const edit = second.edits()[0].body;
  assert.equal(edit.message_id, 101);
  assert.match(edit.text, /✅ #4190 — Экспорт CSV: маршрут завершён/u);
  assert.deepEqual(edit.reply_markup.inline_keyboard, [], 'кнопок у исхода нет');
  const saved = await second.store.read();
  assert.equal(saved.cards['live:4190:a_0123456789abcdef'].messageId, 101,
    'живая карточка сохраняет свой message_id');

  await second.watch.check();
  assert.equal(second.edits().length, 1, 'следующий обход не правит исход повторно');
});

test('отказ deleteMessage для live не роняет обход: повтор следующим обходом', async (t) => {
  const { world, watch, store, deletes, setFailDeletes } = await fixture(t);
  await watch.check();
  world.tasks = [runningTask()];
  world.graphs['4190'] = runningGraph();
  await watch.check();

  world.tasks = [runningTask({ daemonAlive: false, result: 'completed', silence: null })];
  world.graphs['4190'] = runningGraph({
    statuses: { plan: 'done', build: 'done' },
    progress: { done: 2, total: 2, current: null },
  });
  setFailDeletes(true);
  await watch.check(); // не бросает
  assert.equal(deletes().length, 1, 'попытка удаления live была');
  assert.equal((await store.read()).cards['live:4190:a_0123456789abcdef'].messageId, 101,
    'не удалено — live остаётся нетронутым');

  setFailDeletes(false);
  await watch.check();
  assert.equal(deletes().length, 2, 'следующий обход повторил удаление');
  assert.equal((await store.read()).cards['live:4190:a_0123456789abcdef'].messageId, null);
});
