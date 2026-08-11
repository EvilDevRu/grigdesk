// Встройка разворота в карточку задачи B24.
//
// Развернуть ссылку умеет модуль telegram, а нужно это чужим местам: карточке
// задачи, тикету конвейера, чату агента и триажу. Связь между ними — декоратор
// `fastify.telegramDiscussion(text, {project})`, и объявляет его именно telegram:
// там живут гейт плагина, токен и правила. Иначе модулю b24 пришлось бы знать
// про креды Телеграма, а выключенный плагин отвечал бы 404 посреди чужого роута.
//
// Три обещания, которые здесь и проверяются:
//
//  • разворот — ДОПОЛНЕНИЕ. Тело задачи не меняется ни на байт: человек читает
//    описание из портала, а не нашу версию описания;
//  • разворот не имеет права ронять карточку. Сломанный архив, недоступный
//    Телеграм, кривая ссылка — задача обязана открыться, просто без обсуждения;
//  • граница едет вместе с содержимым: чужой чат в описании задачи даёт причину
//    и ни строчки переписки, ровно как в самом `POST /api/telegram/expand`.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TelegramArchiveStore } from '../../server/src/lib/telegram/archive-store.js';
import { TelegramRulesStore } from '../../server/src/lib/telegram/rules-store.js';
import b24Module from '../../server/src/modules/b24/index.js';
import telegramModule from '../../server/src/modules/telegram/index.js';
import {
  TelegramModuleCredentials,
  telegramModuleConnection,
} from './helpers/telegram-account-module.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const TOKEN = '8123456789:AAHrEaLLyLoNgSeCrEtPaRt_x1y2z3w4v5u6';
const BUGS = -1001234567890;   // рабочий чат, привязан к проекту alpha
const OTHER = -1009999999999;  // чужой чат, правила нет
const T0 = Date.UTC(2026, 7, 1, 9, 0, 0) / 1000;

const ME = {
  id: 8123456789,
  username: 'example_inbox_bot',
  firstName: 'Кокпит · входящие',
  canJoinGroups: true,
  canReadAllGroupMessages: true,
};

const SECRET = 'у нас падает оплата на проде, платёж 4412';
const link = (chatId, id) => `https://t.me/c/${String(chatId).replace('-100', '')}/${id}`;

const msg = (over = {}) => ({
  chatId: BUGS,
  chatUsername: '',
  chatTitle: 'Кокпит · баги',
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

// Задача портала: поля отдаются как есть, разбирать их кокпит не берётся.
const TASK = {
  id: 4821,
  title: 'Касса не пробивает чек',
  description: `<p>Обсуждение: ${link(BUGS, 100)}</p>`,
  status_label: 'Выполняется',
  priority_label: 'Высокий',
  responsible: { id: 1, name: 'Тестовый пользователь' },
};

const logStub = () => ({ warn() {}, error() {}, info() {}, debug() {} });

async function build(t, { enabled = true, messages = [], task = TASK, archive } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-task-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const creds = new TelegramModuleCredentials();
  creds.write({ token: TOKEN, bot: ME });

  const store = new TelegramArchiveStore({ dir: path.join(dir, 'archive'), log: logStub() });
  for (const m of messages) await store.append(m);

  const rules = new TelegramRulesStore({ dir: path.join(dir, 'rules'), log: logStub() });
  await rules.write([{ project: 'alpha', chatId: BUGS }], { projects: ['alpha'] });

  const calls = [];
  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', () => enabled);
  // Порядок регистрации — как в app.js: b24 раньше telegram. Декоратор нужен
  // не при сборке роута, а в момент запроса, и порядок на это влиять не должен.
  app.register(b24Module, {
    b24: {
      taskDetail: async (id) => { calls.push(id); return task; },
      getDashboard: async () => ({}),
      findUsers: async () => [],
    },
  });
  const nativeBotApi = {
    getMe: async () => ME,
    callBotApi: async () => { throw new Error('сеть в тесте не нужна'); },
  };
  const connection = telegramModuleConnection({
    creds, archive: archive ?? store, rules, botApi: nativeBotApi,
  });
  app.register(telegramModule, {
    connection,
    botApi: nativeBotApi,
    listProjects: async () => ['alpha'],
  });
  await app.ready();
  t.after(() => app.close());

  return {
    app,
    calls,
    discussion: (text, opts) => app.telegramDiscussion(text, opts),
    task: () => app.inject({ method: 'GET', url: `/api/b24/task/${task.id}` }),
  };
}

test('декоратор объявлен модулем telegram и отдаёт готовый блок', async (t) => {
  const { discussion } = await build(t, {
    messages: [msg({ messageId: 99, text: 'до' }), msg(), msg({ messageId: 101, text: 'после' })],
  });

  const view = await discussion(`см. ${link(BUGS, 100)}`, { project: 'alpha' });

  // Именно блок, а не сырые вердикты: у потребителей текст обязан быть один,
  // иначе агент и человек читают разные версии обсуждения.
  assert.equal(view.links.length, 1);
  assert.equal(view.links[0].ok, true);
  assert.equal(view.quotes, 3);
  assert.match(view.text, /Кокпит · баги/);
  assert.match(view.text, new RegExp(SECRET));
  assert.match(view.text, /← ссылка/);
});

test('выключенный плагин даёт пустой разворот, а не отказ посреди чужого роута', async (t) => {
  const { discussion, task } = await build(t, { enabled: false, messages: [msg()] });

  const view = await discussion(link(BUGS, 100), { project: 'alpha' });
  assert.deepEqual(view.links, []);
  assert.equal(view.text, '');

  // И карточка задачи открывается обычным образом — без поля и без 404.
  const res = await task();
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().telegram, undefined);
  assert.equal(res.json().title, TASK.title);
});

test('карточка задачи получает разворот, не меняя тело задачи', async (t) => {
  const { task } = await build(t, { messages: [msg()] });

  const res = await task();
  assert.equal(res.statusCode, 200);
  const body = res.json();

  // Тело — побайтово то, что отдал портал. Описание правим только глазами
  // человека: подменять его нашей версией нельзя.
  const { telegram, ...rest } = body;
  assert.deepEqual(rest, TASK);

  assert.equal(telegram.links.length, 1);
  assert.equal(telegram.links[0].ok, true);
  assert.equal(telegram.links[0].chat.title, 'Кокпит · баги');
  assert.equal(telegram.links[0].quotes[0].text, SECRET);
  assert.equal(telegram.links[0].quotes[0].author, 'Аня');
  assert.match(telegram.text, new RegExp(SECRET));
});

test('задача без ссылок остаётся ровно такой же, какой пришла', async (t) => {
  const { task } = await build(t, { task: { ...TASK, description: '<p>Просто описание</p>' } });

  const body = (await task()).json();
  assert.equal(body.telegram, undefined, 'пустой блок в ответе — лишний шум');
  assert.deepEqual(body, { ...TASK, description: '<p>Просто описание</p>' });
});

test('ссылка в заголовке и в описании — один блок', async (t) => {
  const { task } = await build(t, {
    messages: [msg()],
    task: { ...TASK, title: `Касса ${link(BUGS, 100)}` },
  });

  const { telegram } = (await task()).json();
  assert.equal(telegram.links.length, 1, 'ссылку любят вписать и в заголовок, и в описание');
});

test('чужой чат в описании: причина есть, переписки нет', async (t) => {
  const { task } = await build(t, {
    // Сообщение в архиве ЕСТЬ — значит отказ является решением, а не следствием
    // того, что текст всё равно негде взять.
    messages: [msg({ chatId: OTHER, chatTitle: 'Чужой чат', messageId: 7 })],
    task: { ...TASK, description: `<p>${link(OTHER, 7)}</p>` },
  });

  const body = (await task()).json();
  const [one] = body.telegram.links;
  assert.equal(one.ok, false);
  assert.equal(one.reason, 'not_allowed');
  assert.match(one.message, /не привязан/i);
  assert.equal(one.chat, undefined);
  assert.equal(one.quotes, undefined);
  assert.ok(!JSON.stringify(body).includes(SECRET), 'текст чужого чата уехал в карточку задачи');
  assert.ok(!JSON.stringify(body).includes('Чужой чат'), 'имя чужого чата уехало в карточку задачи');
});

test('сломанный разворот не роняет карточку задачи', async (t) => {
  // Диск отвалился, архив битый, Телеграм отвечает мусором — карточка обязана
  // открыться. Обсуждение — украшение задачи, а не её часть.
  const { task, calls } = await build(t, {
    archive: {
      chats: async () => [],
      chatIdOf: async () => { throw new Error('архив недоступен'); },
      branch: async () => { throw new Error('архив недоступен'); },
      append: async () => {},
    },
  });

  const res = await task();
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().title, TASK.title);
  assert.equal(res.json().telegram, undefined);
  assert.deepEqual(calls, ['4821'], 'задача всё же спрошена у портала');
});
