// Срез O телеграм-пульта: owner-гейт приёма (docs/plans/telegram-pult-plan.md, §5.1).
//
// Главное обещание: бот — не оракул. Сообщение не от владельца, не из той лички,
// из группы, при неподтверждённом пульте или выключенном плагине не порождает
// НИ ОДНОГО исходящего вызова — бот не отвечает и не подтверждает, что пульт
// существует. Владельцу отвечают /status и /help.
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
const OWNER_ID = 555001;
const T0 = Date.UTC(2026, 7, 19, 10, 0, 0);
const silent = { warn() {}, error() {}, info() {}, debug() {} };

const ME = { id: BOT_ID, username: 'example_pult_bot', canReadAllGroupMessages: true };

const msg = (over = {}) => ({
  chatId: OWNER_CHAT,
  chatUsername: '',
  chatTitle: 'Аня',
  chatType: 'private',
  isForum: false,
  messageId: 1,
  threadId: null,
  replyToMessageId: null,
  mediaGroupId: null,
  date: Math.floor(T0 / 1000),
  editedAt: null,
  from: { id: OWNER_ID, name: 'Аня', username: 'anya' },
  text: '/status',
  media: [],
  ...over,
});

async function fixture({ confirmed = true, enabled = true, summary = null } = {}) {
  const calls = [];
  const botApi = {
    getMe: async () => ME,
    callBotApi: async (token, method, body) => {
      calls.push({ token, method, body });
      return { message_id: 100 + calls.length };
    },
  };
  const creds = new TelegramModuleCredentials();
  creds.write({ token: TOKEN, bot: { id: BOT_ID, username: ME.username } });
  const archive = { chats: async () => [], topics: async () => [] };
  const rules = { read: async () => [], write: async (value) => value };
  const connection = telegramModuleConnection({ creds, archive, rules, botApi });

  const seed = connection.acquireLease();
  if (confirmed) {
    await seed.context.botSettings.setPult({
      chatId: OWNER_CHAT, userId: OWNER_ID, confirmedAtMs: T0,
    });
  }
  await seed.release();

  const summaryCalls = { n: 0 };
  const actions = new TelegramPultActions({
    isEnabled: () => enabled,
    summary: summary ?? (async () => { summaryCalls.n += 1; return '⏳ #4187 ждёт тебя: ворота плана'; }),
    queue: new PultSendQueue({ pauseMs: 0 }),
    log: silent,
    now: () => T0,
  });

  return {
    calls,
    summaryCalls,
    deliver: async (m, type = 'message') => {
      const lease = connection.acquireLease();
      try { await actions.onMessage(m, type, lease); } finally { await lease.release(); }
    },
    tap: async (callback) => {
      const lease = connection.acquireLease();
      try { await actions.onCallback(callback, lease); } finally { await lease.release(); }
    },
  };
}

test('/status от владельца отвечает сводкой в ту же личку', async () => {
  const { calls, deliver, summaryCalls } = await fixture();
  await deliver(msg({ text: '/status' }));
  assert.equal(summaryCalls.n, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendMessage');
  assert.equal(calls[0].body.chat_id, OWNER_CHAT);
  assert.match(String(calls[0].body.text), /4187/u);
  assert.equal('parse_mode' in calls[0].body, false);
});

test('/help отвечает списком возможностей', async () => {
  const { calls, deliver } = await fixture();
  await deliver(msg({ text: '/help' }));
  assert.equal(calls.length, 1);
  assert.match(String(calls[0].body.text), /\/status/u);
});

test('чужие text, slash, кнопка, voice и Стоп — молча ноль исходящих', async () => {
  const { calls, deliver, tap, summaryCalls } = await fixture();
  // не тот пользователь в той же личке (пересланный аккаунт, чужая сессия)
  for (const [index, text] of ['/status', 'свободный текст', '💬 Агент'].entries()) {
    await deliver(msg({
      messageId: 10 + index,
      text,
      from: { id: 999, name: 'Некто', username: '' },
    }));
  }
  await deliver(msg({
    messageId: 20,
    text: '',
    media: [{ kind: 'voice', fileId: 'foreign-voice' }],
    from: { id: 999, name: 'Некто', username: '' },
  }));
  await tap({
    id: 'foreign-stop', data: 'ts:foreign',
    from: { id: 999, name: 'Некто', username: '' },
    chatId: OWNER_CHAT, chatType: 'private', messageId: 30,
  });
  // не та личка
  await deliver(msg({ chatId: 777333, from: { id: 777333, name: 'Некто', username: '' } }));
  // группа, даже со «своим» пользователем
  await deliver(msg({ chatId: -100123, chatType: 'supergroup' }));
  assert.equal(calls.length, 0);
  assert.equal(summaryCalls.n, 0);
});

test('неподтверждённый пульт и выключенный плагин молчат даже для владельца', async () => {
  const off = await fixture({ confirmed: false });
  await off.deliver(msg({ text: '/status' }));
  assert.equal(off.calls.length, 0);

  const disabled = await fixture({ enabled: false });
  await disabled.deliver(msg({ text: '/status' }));
  assert.equal(disabled.calls.length, 0);
  assert.equal(disabled.summaryCalls.n, 0);
});

test('правка сообщения (edited_message) командой не считается', async () => {
  const { calls, deliver } = await fixture();
  await deliver(msg({ text: '/status' }), 'edited_message');
  assert.equal(calls.length, 0, 'правка не должна исполнять команду повторно');
  await deliver(msg({ text: '/status' }), 'message');
  assert.equal(calls.length, 1);
});
