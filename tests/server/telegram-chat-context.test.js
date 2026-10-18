// Обсуждение из телеграма в ходе чата по задаче.
//
// Третья точка встройки разворота. Казалось бы, лишняя: тикет уже несёт секцию
// «Обсуждение в Telegram», а конверт задачи в чат подставляет описание тикета —
// значит переписка доедет сама. Не доедет, и по двум разным причинам:
//
//  • конверт режет описание по своему потолку (TICKET_DESCRIPTION_MAX), а секции
//    стоят в ХВОСТЕ описания. Обсуждение обрезалось бы первым — та же грабля, от
//    которой на конвейере спасает лимит `buildDiscussion` (раздел 5 плана);
//  • тикет — замороженный снимок постановки: `reuseTicket` его намеренно не
//    пересобирает. Разговор в чате при этом продолжается, и агенту нужен свежий
//    текст, а не то, что было в момент запуска.
//
// Отсюда обещания: чат разворачивает ссылки САМ, а закреплённую в описании
// секцию вырезает — иначе агент получит две версии одного обсуждения (старую и
// свежую) и потратит на разбор этого расхождения контекст. Граница проекта
// (профиль прогона) действует и здесь, а любой сбой разворота ход не роняет.
import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import chatModule from '../../server/src/modules/chat/index.ts';
import telegramModule from '../../server/src/modules/telegram/index.ts';
import { TelegramArchiveStore } from '../../server/src/lib/telegram/archiveStore.ts';
import { TelegramRulesStore } from '../../server/src/lib/telegram/rulesStore.ts';
import { DISCUSSION_SECTION_TITLE } from '../../server/src/lib/telegram/discussion.ts';
import {
  TelegramModuleCredentials,
  telegramModuleConnection,
} from './helpers/telegram-account-module.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const TOKEN = '8123456789:AAHrEaLLyLoNgSeCrEtPaRt_x1y2z3w4v5u6';
const BUGS = -1001234567890;   // рабочий чат, привязан к проекту demo
const OTHER = -1009999999999;  // чужой чат, правила нет
const T0 = Date.UTC(2026, 7, 1, 9, 0, 0) / 1000;

const ME = {
  id: 8123456789,
  username: 'example_inbox_bot',
  firstName: 'GrigDesk · входящие',
  canJoinGroups: true,
  canReadAllGroupMessages: true,
};

const SECRET = 'после обновления касса не пробивает чек, платёж 4412';
const STALE = 'это старая выгрузка, снятая при запуске конвейера';
const link = (chatId, id) => `https://t.me/c/${String(chatId).replace('-100', '')}/${id}`;

const msg = (over = {}) => ({
  chatId: BUGS,
  chatUsername: '',
  chatTitle: 'GrigDesk · баги',
  chatType: 'supergroup',
  isForum: false,
  messageId: 100,
  threadId: null,
  replyToMessageId: null,
  date: T0,
  editedAt: null,
  from: { id: 7, name: 'Аня', username: 'anya' },
  text: SECRET,
  media: [],
  ...over,
});

const logStub = () => ({ warn() {}, error() {}, info() {}, debug() {} });

const TICKET = {
  schema: 1,
  taskId: '44',
  title: 'Проверить обработку события',
  description: `Обсуждение: ${link(BUGS, 100)}`,
  acceptanceCriteria: ['Событие обработано'],
  sourceUrl: 'http://127.0.0.1:8140/api/tasks/44',
};

/**
 * Стенд чата из `chat-ticket-context`, плюс живой модуль telegram со своим
 * архивом и правилами. Модуль telegram регистрируется ПОСЛЕ чата — как в
 * приложении: ссылка на декоратор обязана быть ленивой.
 */
async function fixture(t, {
  ticket = TICKET,
  messages = [],
  rules: ruleList = [{ project: 'demo', chatId: BUGS }],
  profile = 'demo',
  enabled = true,
  archive: archiveStub = null,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-chat-tg-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ticketsDir = path.join(root, 'tickets');
  await fs.mkdir(ticketsDir, { recursive: true });
  if (ticket) {
    await fs.writeFile(
      path.join(ticketsDir, `t${ticket.taskId}.ticket.json`),
      JSON.stringify(ticket),
      'utf8',
    );
  }

  const creds = new TelegramModuleCredentials();
  creds.write({ token: TOKEN, bot: ME });
  const store = new TelegramArchiveStore({ dir: path.join(root, 'archive'), log: logStub() });
  for (const m of messages) await store.append(m);
  const rules = new TelegramRulesStore({ dir: path.join(root, 'rules'), log: logStub() });
  await rules.write(ruleList, { projects: ['demo', 'other'] });

  const captured = {};
  const app = Fastify({ logger: false });
  app.decorate('sse', { broadcast() {} });
  app.decorate('pluginEnabled', () => enabled);

  await app.register(chatModule, {
    config: {
      chatsDir: path.join(root, 'chats'),
      chatStoreLegacyPath: path.join(root, 'legacy.json'),
      chatBindingsDir: path.join(root, 'bindings'),
      rootDir: root,
      factoryHome: root,
      agentsDir: path.join(root, 'agents'),
      ticketsDir,
      port: 18140,
    },
    factoryState: {
      async readEnv() { return { WORKSPACE_MODE: 'isolated' }; },
      async readRegistry() {
        // Профиль прогона — он же проект для allowlist. Задача без реестра
        // (ручная, историческая) обязана вести себя как «проект неизвестен».
        if (!profile) throw new Error('реестра нет');
        return { registry: { PROFILE: profile }, mtime: 0 };
      },
    },
    prefs: {
      read() {
        return { providerSettings: {}, chatAutoCompactWindow: 0 };
      }
    },
    claudeAuth: null,
    internalToken: 'test',
    modelsRegistry: async () => ({ claude: [{ id: 'claude-test', efforts: [] }] }),
    executorResolver: async () => ({
      id: 'claude',
      async run(options) {
        captured.message = options.message;
        return { reply: 'принято', steps: [], sessionId: 's1', cost: 0 };
      },
    }),
  });

  const nativeBotApi = {
    getMe: async () => ME,
    callBotApi: async () => { throw new Error('сеть в тесте не нужна'); },
  };
  const connection = telegramModuleConnection({
    creds, archive: archiveStub ?? store, rules, botApi: nativeBotApi,
  });
  await app.register(telegramModule, {
    connection,
    botApi: nativeBotApi,
    listProjects: async () => ['demo', 'other'],
  });
  await app.ready();
  t.after(() => app.close());

  const chatKey = 'task-chat';

  await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: {
      chat: {
        id: chatKey,
        taskId: '44',
        modelRef: { provider: 'claude', model: 'claude-test' },
        messages: [],
        createdAt: Date.UTC(2026, 7, 1),
        updatedAt: Date.UTC(2026, 7, 1),
        revision: 0,
      },
    },
  });

  return {
    async send(task = 44, message = 'что там по задаче?') {
      const res = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task}/chat`,
        payload: {
          chatKey,
          modelRef: { provider: 'claude', model: 'claude-test' },
          model: 'claude-test',
          message,
        },
      });
      assert.equal(res.statusCode, 200, `ход не прошёл: ${res.body}`);
      return captured.message;
    },
  };
}

test('переписка по ссылке из задачи доезжает в ход чата', async (t) => {
  const { send } = await fixture(t, {
    messages: [msg({ messageId: 99, text: 'до' }), msg(), msg({ messageId: 101, text: 'после' })],
  });

  const sent = await send();
  assert.ok(sent.includes(DISCUSSION_SECTION_TITLE), 'секции обсуждения нет вовсе');
  assert.match(sent, new RegExp(SECRET));
  assert.match(sent, /Чат «GrigDesk · баги»/);
  // Обсуждение — часть конверта задачи, а не отдельная реплика человека.
  assert.ok(
    sent.indexOf(DISCUSSION_SECTION_TITLE) < sent.indexOf('[/Задача чата]'),
    'обсуждение вывалилось из конверта задачи',
  );
});

test('закреплённая в тикете секция не дублирует свежую', async (t) => {
  // Так выглядит тикет, собранный при запуске: секция уже вклеена в хвост
  // описания. Свежий разворот обязан её заменить, а не встать рядом.
  const { send } = await fixture(t, {
    ticket: {
      ...TICKET,
      description: `${TICKET.description}\n\n${DISCUSSION_SECTION_TITLE}\nЧат «GrigDesk · баги»\n[01.08.2026 09:00] Аня: ${STALE}`,
    },
    messages: [msg()],
  });

  const sent = await send();
  assert.equal(sent.includes(STALE), false, 'в ход уехал снимок постановки вместо свежей переписки');
  assert.match(sent, new RegExp(SECRET));
  assert.equal(
    sent.split(DISCUSSION_SECTION_TITLE).length - 1,
    1,
    'агент получил две версии одного обсуждения',
  );
});

test('потолок описания тикета не съедает обсуждение', async (t) => {
  // Ровно та грабля, ради которой разворот сделан отдельно от описания:
  // описание режется с конца, а секция стоит последней.
  const { send } = await fixture(t, {
    ticket: {
      ...TICKET,
      description: `Обсуждение: ${link(BUGS, 100)}\n${'приложенный разбор. '.repeat(600)}`,
    },
    messages: [msg()],
  });

  const sent = await send();
  assert.match(sent, /\[описание обрезано; полный текст: .*t44\.ticket\.json\]/);
  assert.match(sent, new RegExp(SECRET), 'обрезка описания унесла с собой обсуждение');
});

test('чат чужого проекта закрыт и в чате: причина есть, переписки нет', async (t) => {
  const { send } = await fixture(t, {
    profile: 'demo',
    rules: [{ project: 'other', chatId: BUGS }],
    messages: [msg()],
  });

  const sent = await send();
  assert.equal(sent.includes(SECRET), false, 'переписка чужого проекта уехала агенту');
  assert.equal(sent.includes('GrigDesk · баги'), false, 'даже имя чужого чата наружу не уезжает');
  assert.match(sent, /Ссылка не раскрыта/);
  assert.match(sent, /привязан к проекту/i);
});

test('задача без реестра: проект неизвестен, но allowlist на месте', async (t) => {
  // Профиля нет — сверять не с чем, и это не повод ни закрыть привязанный чат,
  // ни открыть непривязанный.
  const { send } = await fixture(t, {
    profile: '',
    ticket: { ...TICKET, description: `Обсуждение: ${link(BUGS, 100)} и ${link(OTHER, 7)}` },
    messages: [msg(), msg({ chatId: OTHER, chatTitle: 'Чужой чат', messageId: 7, text: 'чужое' })],
  });

  const sent = await send();
  assert.match(sent, new RegExp(SECRET));
  assert.equal(sent.includes('Чужой чат'), false);
  assert.match(sent, /Ссылка не раскрыта/);
});

test('выключенный плагин: ход идёт, а обсуждения нет и объяснений тоже', async (t) => {
  const { send } = await fixture(t, { enabled: false, messages: [msg()] });

  const sent = await send();
  assert.equal(sent.includes(DISCUSSION_SECTION_TITLE), false);
  assert.equal(sent.includes('Ссылка не раскрыта'), false, 'выключенный раздел ничего не объясняет');
  assert.match(sent, /\[Задача чата\]/, 'конверт задачи остался на месте');
});

test('сломанный архив не роняет ход чата', async (t) => {
  const { send } = await fixture(t, {
    archive: {
      chats: async () => [],
      chatIdOf: async () => { throw new Error('архив недоступен'); },
      branch: async () => { throw new Error('архив недоступен'); },
      append: async () => {},
    },
  });

  const sent = await send();
  assert.equal(sent.includes(DISCUSSION_SECTION_TITLE), false);
  assert.match(sent, /\[Задача чата\]/);
});
