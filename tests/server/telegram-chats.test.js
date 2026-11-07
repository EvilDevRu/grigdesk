// HTTP-часть фазы 1: список чатов, которые бот уже слышит, и состояние опроса.
//
// Зачем это отдельный роут, а не поле статуса: список чатов — единственное, из
// чего потом собирается привязка «чат/тема → проект» (вкладка «Правила»). Пока
// его нет, настраивать нечего: имя чата человеку неоткуда взять, кроме как из
// того, что бот реально услышал.
//
// Второе обещание тестов — опрос заводится и глохнет вместе с ботом. Иначе
// после «Подключить» пришлось бы ждать паузу цикла, а после «Отключить» бот
// продолжал бы стучаться в Телеграм с уже стёртым токеном.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TelegramArchiveStore } from '../../server/src/lib/telegram/archiveStore.ts';
import telegramModule from '../../server/src/modules/telegram/index.ts';
import {
  TelegramModuleCredentials,
  telegramModuleConnection,
} from './helpers/telegram-account-module.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const TOKEN = '8123456789:AAHrEaLLyLoNgSeCrEtPaRt_x1y2z3w4v5u6';
const CHAT = -1001000000042;
const T0 = Date.UTC(2026, 7, 7, 10, 0, 0) / 1000;

const ME = {
  id: 8123456789,
  username: 'example_inbox_bot',
  firstName: 'GrigDesk · входящие',
  canJoinGroups: true,
  canReadAllGroupMessages: true,
};

const msg = (over = {}) => ({
  chatId: CHAT,
  chatTitle: 'Команда Альфа · разработка',
  chatType: 'supergroup',
  isForum: true,
  messageId: 1,
  threadId: null,
  replyToMessageId: null,
  date: T0,
  editedAt: null,
  from: { id: 7, name: 'Аня', username: 'anya' },
  text: 'кнопка не нажимается',
  media: [],
  ...over,
});

/** Поллер-заглушка: роутам от него нужны ровно `status`, `start` и `stop`. */
function pollerStub(over = {}) {
  return {
    started: 0,
    stopped: 0,
    start() { this.started += 1; },
    stop() { this.stopped += 1; },
    status: () => ({
      running: false, offset: 0, lastPollAt: null, lastMessageAt: null, lastError: null, conflict: false, ...over,
    }),
  };
}

async function build(t, { enabled = true, archive = null, poller = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-chats-'));
  const creds = new TelegramModuleCredentials();
  const nativeArchive = archive ?? { chats: async () => [], topics: async () => [] };
  const rules = { read: async () => [], write: async (value) => value };
  const botApi = {
    getMe: async () => ME,
    callBotApi: async () => { throw new Error('network not expected'); },
  };
  const connection = telegramModuleConnection({
    creds, archive: nativeArchive, rules, botApi, poller,
  });

  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', () => enabled);
  app.register(telegramModule, { connection, poller, botApi });
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  return {
    dir,
    creds,
    chats: () => app.inject({ method: 'GET', url: '/api/telegram/chats' }),
    topics: (chatId) => app.inject({ method: 'GET', url: `/api/telegram/chats/${chatId}/topics` }),
    status: () => app.inject({ method: 'GET', url: '/api/telegram/status' }),
    connect: () => app.inject({ method: 'POST', url: '/api/telegram/connect', payload: { token: TOKEN } }),
    disconnect: () => app.inject({ method: 'POST', url: '/api/telegram/disconnect' }),
  };
}

async function archiveWith(t, messages) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-chats-arch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new TelegramArchiveStore({ dir, log: { warn() {}, error() {}, info() {} } });
  for (const m of messages) await store.append(m);
  return store;
}

test('список чатов закрыт тем же гейтом плагина', async (t) => {
  const { chats } = await build(t, { enabled: false });
  const res = await chats();
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'plugin_disabled');
});

test('чаты берутся из архива: имя, счётчик и время последнего сообщения', async (t) => {
  const archive = await archiveWith(t, [
    msg({ messageId: 1 }),
    msg({ messageId: 2, date: T0 + 300 }),
    msg({ messageId: 3, date: T0 + 60, chatId: 555, chatTitle: 'Личка · Тестовый пользователь', chatType: 'private', isForum: false }),
  ]);
  const { chats } = await build(t, { archive });

  const list = (await chats()).json().chats;
  assert.equal(list.length, 2);
  // Сверху — где говорили последними: с этого чата человек и начнёт привязку.
  assert.equal(list[0].id, CHAT);
  assert.equal(list[0].title, 'Команда Альфа · разработка');
  assert.equal(list[0].isForum, true);
  assert.equal(list[0].messages, 2);
  assert.equal(list[0].lastAt, T0 + 300);
  assert.equal(list[1].id, 555);
  assert.equal(list[1].messages, 1);
});

test('темы выбранного чата отдаются из архива для автоматического селекта', async (t) => {
  const archive = await archiveWith(t, [
    msg({ messageId: 1, threadId: 42, threadTitle: 'Баги', threadTitleSource: 'root' }),
    msg({ messageId: 2, date: T0 + 60, threadId: 42, threadTitle: 'Баги', threadTitleSource: 'root' }),
    msg({ messageId: 3, date: T0 + 120, threadId: 77 }),
  ]);
  const api = await build(t, { archive });

  const res = await api.topics(CHAT);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().topics, [
    { id: 77, title: '', messages: 1, lastAt: T0 + 120 },
    { id: 42, title: 'Баги', messages: 2, lastAt: T0 + 60 },
  ]);
});

test('неверный id чата не запускает сканирование архива', async (t) => {
  const api = await build(t, { archive: { chats: async () => [], topics: async () => assert.fail('не звать') } });
  const res = await api.topics('not-a-number');
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'bad_chat_id');
});

test('бот подключён, но ещё ничего не слышал — пустой список, а не ошибка', async (t) => {
  const archive = await archiveWith(t, []);
  const { chats } = await build(t, { archive });
  const res = await chats();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().chats, []);
});

test('статус несёт состояние опроса — иначе «бот подключён» ничего не говорит о работе', async (t) => {
  const poller = pollerStub({ running: true, offset: 42, lastMessageAt: T0 });
  const { status } = await build(t, { poller });

  const body = (await status()).json();
  assert.equal(body.bot.configured, false, 'подключение бота и работа опроса — разные вещи');
  assert.equal(body.poll.running, true);
  assert.equal(body.poll.offset, 42);
  assert.equal(body.poll.lastMessageAt, T0);
});

test('конфликт двух читателей доезжает до статуса словами, а не кодом', async (t) => {
  const poller = pollerStub({
    conflict: true,
    lastError: { code: 'poll_conflict', message: 'Апдейты этого бота уже читает другой экземпляр…' },
  });
  const { status } = await build(t, { poller });

  const poll = (await status()).json().poll;
  assert.equal(poll.conflict, true);
  assert.equal(poll.lastError.code, 'poll_conflict');
  assert.match(poll.lastError.message, /другой|второй/i);
});

test('подключение бота заводит опрос, отключение — гасит', async (t) => {
  const poller = pollerStub();
  const { connect, disconnect } = await build(t, { poller });

  await connect();
  assert.equal(poller.started, 1, 'после «Подключить» ждать паузу цикла человек не должен');

  await disconnect();
  assert.equal(poller.stopped, 1, 'со стёртым токеном стучаться в Телеграм незачем');
});

test('пустой account namespace без poller остаётся читаемым offline', async (t) => {
  const { chats, status } = await build(t);
  assert.deepEqual((await chats()).json().chats, []);
  assert.equal((await status()).json().poll, null, 'опроса нет — так и говорим, а не выдумываем running:false');
});
