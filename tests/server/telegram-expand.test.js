// Хук на чтение по HTTP: `POST /api/telegram/expand` — что стоит за ссылками
// в тексте задачи.
//
// Резолв как таковой проверяет `telegram-resolve.test.js`; здесь обещания
// границы, а они все про «что уедет наружу»:
//
//  • отказ ОТДАЁТСЯ, но без содержимого. Нераскрытая ссылка обязана объяснить
//    причину, и при этом ни строчки чужой переписки в ответе быть не должно —
//    иначе allowlist защищал бы только вид, а не данные;
//  • служебным чатом можно назначить ТОЛЬКО личку, которую бот уже слышал.
//    Произвольный id в этом поле значит «пересылай рабочую переписку туда,
//    куда я скажу» — тихий канал утечки в одну строку настройки;
//  • служебный чат живёт вместе с токеном: отключили бота — стёрся и он.
//    Иначе следующий бот унаследовал бы чужой адрес пересылки.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TelegramArchiveStore } from '../../server/src/lib/telegram/archive-store.js';
import { TelegramRulesStore } from '../../server/src/lib/telegram/rules-store.js';
import telegramModule from '../../server/src/modules/telegram/index.js';
import {
  TelegramModuleCredentials,
  telegramModuleConnection,
} from './helpers/telegram-account-module.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const TOKEN = '8123456789:AAHrEaLLyLoNgSeCrEtPaRt_x1y2z3w4v5u6';
const BUGS = -1001234567890;      // рабочий чат, привязан к проекту alpha
const OTHER = -1009999999999;     // чужой чат, правила нет
const OWNER = 555000111;          // личка хозяина — она же служебный чат
const T0 = Date.UTC(2026, 7, 1, 9, 0, 0) / 1000;

const ME = {
  id: 8123456789,
  username: 'example_inbox_bot',
  firstName: 'Кокпит · входящие',
  canJoinGroups: true,
  canReadAllGroupMessages: true,
};

const SECRET = 'у нас падает оплата на проде, платёж 4412';

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

const logStub = () => ({ warn() {}, error() {}, info() {}, debug() {} });

/** Вызовы Bot API считаем поимённо: «в сеть не ходили» — тоже обещание. */
function botCalls(handlers = {}) {
  const calls = [];
  const call = async (method, body) => {
    calls.push({ method, body });
    const h = handlers[method];
    if (h === undefined) throw new Error(`в тесте не задан ответ на ${method}`);
    if (h instanceof Error) throw h;
    return typeof h === 'function' ? h(body) : h;
  };
  return { calls, call, methods: () => calls.map((c) => c.method) };
}

async function build(t, {
  enabled = true, connected = true, messages = [], ruleList = null, handlers = {},
} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-expand-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const creds = new TelegramModuleCredentials();
  if (connected) creds.write({ token: TOKEN, bot: ME });

  const archive = new TelegramArchiveStore({ dir: path.join(dir, 'archive'), log: logStub() });
  for (const m of messages) await archive.append(m);

  const rules = new TelegramRulesStore({ dir: path.join(dir, 'rules'), log: logStub() });
  await rules.write(ruleList ?? [{ project: 'alpha', chatId: BUGS }], { projects: ['alpha', 'beta'] });

  const bot = botCalls(handlers);
  const nativeBotApi = {
    getMe: async () => ME,
    callBotApi: (token, method, body) => bot.call(method, body),
  };
  const connection = telegramModuleConnection({
    creds, archive, rules, botApi: nativeBotApi, initiallyConnected: connected,
  });
  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', () => enabled);
  app.register(telegramModule, {
    connection,
    botApi: nativeBotApi,
    listProjects: async () => ['alpha', 'beta'],
  });
  await app.ready();
  t.after(() => app.close());

  return {
    creds,
    bot,
    expand: (payload) => app.inject({ method: 'POST', url: '/api/telegram/expand', payload }),
    setService: (payload) => app.inject({
      method: 'POST',
      url: '/api/telegram/service-chat',
      payload: { botId: ME.id, ...payload },
    }),
    setServiceRaw: (payload) => app.inject({
      method: 'POST', url: '/api/telegram/service-chat', payload,
    }),
    putRules: (payload) => app.inject({ method: 'PUT', url: '/api/telegram/rules', payload }),
    status: () => app.inject({ method: 'GET', url: '/api/telegram/status' }),
    disconnect: () => app.inject({ method: 'POST', url: '/api/telegram/disconnect' }),
  };
}

const linkTo = (chatId, id) => `https://t.me/c/${String(chatId).replace('-100', '')}/${id}`;

test('разворот закрыт тем же гейтом плагина', async (t) => {
  const { expand, setService } = await build(t, { enabled: false });
  for (const res of [await expand({ text: 'привет' }), await setService({ chatId: OWNER })]) {
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'plugin_disabled');
  }
});

test('текста без ссылок хватает, чтобы не трогать ни архив, ни сеть', async (t) => {
  const { expand, bot } = await build(t);
  const res = await expand({ text: 'обычное описание задачи без единой ссылки' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().links, []);
  assert.equal(res.json().text, '');
  assert.deepEqual(bot.methods(), []);
});

test('ссылка в привязанный чат раскрывается из архива, сеть не нужна', async (t) => {
  const { expand, bot } = await build(t, {
    messages: [msg({ messageId: 99, text: 'до' }), msg({ messageId: 100 }), msg({ messageId: 101, text: 'после' })],
  });

  const res = await expand({ text: `см. ${linkTo(BUGS, 100)}`, project: 'alpha' });
  const body = res.json();
  const [one] = body.links;
  // Роут отдаёт СОБРАННЫЙ блок, а не сырые вердикты: у сырых внутри лежат
  // `fileId` вложений, а потребителям нужен один и тот же текст обсуждения —
  // и человеку в карточке, и агенту в тикете.
  assert.equal(one.ok, true);
  assert.equal(one.chat.title, 'Кокпит · баги');
  assert.equal(one.quotes.length, 3, 'ветка отдаётся целиком, а не одним сообщением');
  assert.ok(one.quotes.some((q) => q.target && q.text === SECRET), 'нет цитаты, ради которой дали ссылку');
  assert.match(body.text, new RegExp(SECRET));
  // Сеть не понадобилась — значит взято из архива.
  assert.deepEqual(bot.methods(), []);
});

test('чужой чат: причина есть, а переписки в ответе нет', async (t) => {
  const { expand, bot } = await build(t, {
    // Сообщение в архиве ЕСТЬ — то есть отказ обязан быть решением, а не
    // следствием того, что текста всё равно негде взять.
    messages: [msg({ chatId: OTHER, chatTitle: 'Чужой чат', messageId: 7 })],
  });

  const res = await expand({ text: linkTo(OTHER, 7), project: 'alpha' });
  const [one] = res.json().links;
  assert.equal(one.ok, false);
  assert.equal(one.reason, 'not_allowed');
  assert.match(one.message, /не привязан/i);
  // Полей содержимого у отказа нет вовсе — не пустые, а отсутствующие.
  assert.equal(one.chat, undefined, 'даже имя чужого чата наружу не уезжает');
  assert.equal(one.quotes, undefined);
  assert.ok(!JSON.stringify(res.json()).includes(SECRET), 'текст чужого чата попал в ответ');
  assert.ok(!JSON.stringify(res.json()).includes('Чужой чат'));
  assert.deepEqual(bot.methods(), []);
});

test('без служебного чата пересылать некуда — так и сказано', async (t) => {
  const { expand, bot } = await build(t);
  const [one] = (await expand({ text: linkTo(BUGS, 100), project: 'alpha' })).json().links;
  assert.equal(one.reason, 'no_service_chat');
  assert.match(one.message, /служебн/i);
  assert.deepEqual(bot.methods(), []);
});

test('бот не подключён — до причин пересылки дело не доходит', async (t) => {
  const { expand } = await build(t, { connected: false });
  const [one] = (await expand({ text: linkTo(BUGS, 100), project: 'alpha' })).json().links;
  assert.equal(one.reason, 'not_connected');
});

test('назначенный служебный чат используется пересылкой, копия убирается', async (t) => {
  const forwarded = {
    message_id: 9001,
    chat: { id: OWNER, type: 'private' },
    date: T0 + 86400,
    forward_origin: { type: 'user', sender_user: { id: 7, first_name: 'Аня' }, date: T0 },
    text: SECRET,
  };
  const { expand, setService, bot } = await build(t, {
    messages: [msg({ chatId: OWNER, chatType: 'private', chatTitle: 'Тестовый пользователь', isForum: false, messageId: 1, text: '/start' })],
    handlers: { forwardMessage: forwarded, deleteMessage: true },
  });

  assert.equal((await setService({ chatId: OWNER })).statusCode, 200);

  const [one] = (await expand({ text: linkTo(BUGS, 100), project: 'alpha' })).json().links;
  assert.equal(one.ok, true);
  assert.equal(one.quotes.length, 1, 'пересылка достаёт ровно одно сообщение, ветки у неё нет');
  assert.equal(one.quotes[0].text, SECRET);
  assert.equal(one.quotes[0].target, true);
  // Каким путём достали — видно по вызовам: в архиве этого сообщения нет,
  // значит сработала пересылка себе, и копия убрана следом.
  assert.deepEqual(bot.methods(), ['forwardMessage', 'deleteMessage']);
  assert.equal(bot.calls[0].body.chat_id, OWNER);
  assert.equal(bot.calls[1].body.message_id, 9001);
});

test('служебным чатом можно назначить только личку, которую бот слышал', async (t) => {
  const { setService } = await build(t, {
    messages: [msg({ messageId: 1 })], // групповой чат, лички бот ещё не слышал
  });

  // Произвольный id — тихий канал утечки: бот пересылал бы рабочую переписку
  // тому, кто вписал сюда свой номер.
  const stranger = await setService({ chatId: 777000222 });
  assert.equal(stranger.statusCode, 400);
  assert.equal(stranger.json().error, 'bad_service_chat');
  assert.match(stranger.json().message, /личк/i);

  // Групповой чат тоже не годится: копия видна всем участникам.
  const group = await setService({ chatId: BUGS });
  assert.equal(group.statusCode, 400);
  assert.equal(group.json().error, 'bad_service_chat');
});

test('stale bot CAS не меняет service chat или rules нового account', async (t) => {
  const { setServiceRaw, putRules, status } = await build(t, {
    messages: [msg({ chatId: OWNER, chatType: 'private', messageId: 1 })],
  });
  for (const response of [
    await setServiceRaw({ botId: 999999999, chatId: OWNER }),
    await putRules({ botId: 999999999, rules: [] }),
  ]) {
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'telegram_account_changed');
  }
  assert.equal((await status()).json().bot.serviceChatId, null);
});

test('native mutations отключённого bot возвращают not_connected до store', async (t) => {
  const { setServiceRaw, putRules } = await build(t, { connected: false });
  for (const response of [
    await setServiceRaw({ botId: ME.id, chatId: null }),
    await putRules({ botId: ME.id, rules: [] }),
  ]) {
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, 'telegram_not_connected');
  }
});

test('служебный чат остаётся в offline namespace того же bot после disconnect', async (t) => {
  const { setService, status, disconnect } = await build(t, {
    messages: [msg({ chatId: OWNER, chatType: 'private', chatTitle: 'Тестовый пользователь', isForum: false, messageId: 1, text: '/start' })],
  });

  await setService({ chatId: OWNER });
  const before = (await status()).json().bot;
  assert.equal(before.serviceChatId, OWNER);
  assert.equal(before.serviceChatTitle, 'Тестовый пользователь');

  await disconnect();
  assert.equal((await status()).json().bot.serviceChatId, OWNER);
});

test('одна и та же ссылка дважды — один разворот', async (t) => {
  // Ссылку на обсуждение любят вписать и в описание, и в комментарий рядом.
  // Показывать один разговор двумя блоками незачем, поэтому дубли схлопываются
  // ещё в разборе текста (`parseTelegramLinks`), а не в UI.
  const { expand, bot } = await build(t, { messages: [msg({ messageId: 100 })] });
  const link = linkTo(BUGS, 100);
  const { links } = (await expand({ text: `${link} и ещё раз ${link}`, project: 'alpha' })).json();
  assert.equal(links.length, 1);
  assert.equal(links[0].ok, true);
  assert.deepEqual(bot.methods(), []);
});
