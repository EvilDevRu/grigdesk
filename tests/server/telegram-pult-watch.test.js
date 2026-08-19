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

import { TelegramPultWatch } from '../../server/src/lib/telegram/pult/watch.js';
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

async function fixture(t, { confirmed = true, stateFile = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-pult-watch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const sends = [];
  let failSends = false;
  let unchangedEdits = false;
  const botApi = {
    getMe: async () => ({ id: BOT_ID, username: 'example_pult_bot' }),
    callBotApi: async (token, method, body) => {
      if (failSends) throw Object.assign(new Error('telegram down'), { kind: 'transport' });
      sends.push({ token, method, body });
      if (unchangedEdits && method === 'editMessageText') {
        throw Object.assign(new Error('Bad Request: message is not modified'), { kind: 'telegram' });
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
    now: () => T0,
    log: silent,
  });

  return {
    world,
    watch,
    store,
    file,
    connection,
    ownerKey: `${accountRef}:${OWNER_CHAT}:${T0}`,
    accountRef,
    sends,
    setFailSends: (value) => { failSends = value; },
    setUnchangedEdits: (value) => { unchangedEdits = value; },
    messages: () => sends.filter((c) => c.method === 'sendMessage'),
    edits: () => sends.filter((c) => c.method === 'editMessageText'),
  };
}

test('переход «не ждала → ждёт»: ровно одна карточка, повтор без изменений — ноль', async (t) => {
  const { world, watch, messages } = await fixture(t);
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

test('рестарт: новый инстанс не шлёт повторно, а ушедший повод редактирует по сохранённому message_id', async (t) => {
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

  // Повод ушёл (решили из браузера) — карточка гаснет по сохранённому message_id.
  second.world.graphs['4187'] = { ...gateGraph(), statuses: { plan: 'done', gate_plan: 'done' } };
  await second.watch.check();
  const edits = second.edits();
  assert.equal(edits.length, 1);
  assert.equal(edits[0].body.message_id, sentId);
  assert.equal(edits[0].body.chat_id, OWNER_CHAT);
  assert.match(edits[0].body.text, /✓/u);
  assert.deepEqual(edits[0].body.reply_markup, { inline_keyboard: [] }, 'кнопки сняты');
});

test('молчание ключуется задача:этап и подчиняется порогу из ответа /api/tasks', async (t) => {
  const { world, watch, messages, edits } = await fixture(t);
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

  // Следующий этап завис — это новая беда: старая карточка гаснет, приходит новая.
  world.tasks = [{ task: 4189, daemonAlive: true, silence: { sec: 400, stage: 'TESTS', tool: 'Bash' } }];
  await watch.check();
  assert.equal(messages().length, 2);
  assert.match(messages()[1].body.text, /tests/u);
  assert.equal(edits().length, 1, 'карточка BUILD отредактирована в решено');
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

test('чат: вопрос из /api/chat/waiting даёт карточку с вариантами, фантом гаснет', async (t) => {
  const { world, watch, messages, edits } = await fixture(t);
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

  // Ответили из браузера (или сервер рестартовал и pendingPerms умерли) — карточка гаснет.
  world.waiting = [];
  await watch.check();
  assert.equal(edits().length, 1);
  assert.match(edits()[0].body.text, /✓/u);
});

test('чат: запрос разрешения показывает инструмент и превью команды', async (t) => {
  const { world, watch, messages } = await fixture(t);
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
  assert.equal((await store.read()).cards['wait:4187'].uiVersion, 2);
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
  assert.equal((await store.read()).cards['wait:4187'].uiVersion, 2);

  await watch.check();
  assert.equal(edits().length, 1, 'версия сохранена, повторной миграции нет');
});

test('смена привязки не редактирует message_id из лички прежнего владельца', async (t) => {
  const { world, watch, store, edits, connection, ownerKey, accountRef } = await fixture(t);
  await store.write({
    cards: {
      'wait:4187': {
        messageId: 77, kind: 'gate', subject: '#4187', at: T0, ownerKey, uiVersion: 2,
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
  assert.equal(card.ownerKey, `${accountRef}:${reboundChat}:${reboundAt}`);
});
