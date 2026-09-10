// Срез S телеграм-пульта: подключение владельца (docs/plans/telegram-pult-plan.md, §5.1).
//
// Обещания:
//  - владельцем может стать только личка, которую бот уже слышал: группа —
//    pult_not_private, незнакомый чат — pult_chat_unknown;
//  - включение — только 6-значным кодом, отправленным в саму личку: код одноразовый,
//    живёт 10 минут, пятая неверная попытка его аннулирует;
//  - disable выключает, но выбор чата в namespace бота сохраняет; повторное включение
//    требует нового кода;
//  - мутации несут увиденный botId как optimistic CAS (правило service-chat);
//  - status отдаёт блок pult без сырого id — маска и заголовок чата;
//  - выключенный плагин — 404 plugin_disabled, живой гейт.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TelegramArchiveStore } from '../../server/src/lib/telegram/archiveStore.ts';
import { TelegramBotSettingsStore } from '../../server/src/lib/telegram/accountContext.ts';
import telegramModule from '../../server/src/modules/telegram/index.ts';
import {
  TelegramModuleCredentials,
  telegramModuleConnection,
} from './helpers/telegram-account-module.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const TOKEN = '8123456789:AAHrEaLLyLoNgSeCrEtPaRt_x1y2z3w4v5u6';
const BOT_ID = 8123456789;
const OWNER_CHAT = 555001;
const GROUP_CHAT = -1001000000042;
const T0 = Date.UTC(2026, 7, 19, 10, 0, 0);

const ME = {
  id: BOT_ID,
  username: 'example_pult_bot',
  firstName: 'Кокпит',
  canJoinGroups: true,
  canReadAllGroupMessages: true,
};

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
  from: { id: OWNER_CHAT, name: 'Аня', username: 'anya' },
  text: '/start',
  media: [],
  ...over,
});

function fakeBotApi() {
  const calls = [];
  return {
    calls,
    getMe: async () => ME,
    callBotApi: async (token, method, body) => {
      calls.push({ token, method, body });
      if (method === 'sendMessage') return { message_id: 100 + calls.length };
      return {};
    },
  };
}

async function build(t, { enabled = true } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-pult-'));
  const archive = new TelegramArchiveStore({ dir, log: { warn() {}, error() {}, info() {} } });
  await archive.append(msg());
  await archive.append(msg({
    chatId: GROUP_CHAT, chatTitle: 'Команда', chatType: 'supergroup', messageId: 2,
  }));

  const creds = new TelegramModuleCredentials();
  creds.write({ token: TOKEN, bot: { id: BOT_ID, username: ME.username } });
  const botApi = fakeBotApi();
  const rules = { read: async () => [], write: async (value) => value };
  const connection = telegramModuleConnection({ creds, archive, rules, botApi });

  const clock = { at: T0 };
  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', () => enabled);
  app.register(telegramModule, { connection, poller: null, botApi, now: () => clock.at });
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const post = (url, payload) => app.inject({ method: 'POST', url, payload });
  return {
    clock,
    botApi,
    status: async () => (await app.inject({ method: 'GET', url: '/api/telegram/status' })).json(),
    request: (chatId, botId = BOT_ID) => post('/api/telegram/pult', { botId, chatId }),
    confirm: (code, botId = BOT_ID) => post('/api/telegram/pult/confirm', { botId, code }),
    disable: (botId = BOT_ID) => post('/api/telegram/pult/disable', { botId }),
  };
}

/** Код достаём из текста, который бот отправил в личку, — как его увидит человек. */
function sentCode(botApi) {
  const sends = botApi.calls.filter((c) => c.method === 'sendMessage');
  assert.ok(sends.length > 0, 'бот не отправил ни одного сообщения');
  const match = String(sends.at(-1).body.text || '').match(/\b(\d{6})\b/u);
  assert.ok(match, 'в сообщении нет 6-значного кода');
  return match[1];
}

test('запрос кода: знакомая личка получает sendMessage ровно в этот чат, без parse_mode', async (t) => {
  const { botApi, request, status } = await build(t);
  const res = await request(OWNER_CHAT);
  assert.equal(res.statusCode, 200);

  const sends = botApi.calls.filter((c) => c.method === 'sendMessage');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].body.chat_id, OWNER_CHAT);
  assert.equal('parse_mode' in sends[0].body, false);
  assert.match(String(sends[0].body.text), /\d{6}/u);

  const view = (await status()).pult;
  assert.equal(view.pending, true);
  assert.equal(view.configured, false);
  assert.equal(view.confirmed, false);
});

test('группа — pult_not_private, незнакомый чат — pult_chat_unknown', async (t) => {
  const { request, botApi } = await build(t);
  const group = await request(GROUP_CHAT);
  assert.equal(group.statusCode, 400);
  assert.equal(group.json().error, 'pult_not_private');

  const unknown = await request(777333);
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.json().error, 'pult_chat_unknown');
  assert.equal(botApi.calls.filter((c) => c.method === 'sendMessage').length, 0);
});

test('верный код включает пульт; код одноразовый; status показывает маску, а не id', async (t) => {
  const { request, confirm, status, botApi } = await build(t);
  await request(OWNER_CHAT);
  const code = sentCode(botApi);

  const ok = await confirm(code);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().pult.confirmed, true);

  const view = (await status()).pult;
  assert.equal(view.configured, true);
  assert.equal(view.confirmed, true);
  assert.equal(view.pending, false);
  assert.equal(view.chatTitle, 'Аня');
  assert.equal(view.chatHint, '…5001');
  assert.equal('chatId' in view, false);
  assert.equal(JSON.stringify(view).includes(String(OWNER_CHAT)), false);

  // Тот же код второй раз не работает: он одноразовый.
  const again = await confirm(code);
  assert.equal(again.statusCode, 400);
  assert.equal(again.json().error, 'pult_code_expired');
});

test('подтверждение ставит команды и постоянную клавиатуру только в личке владельца', async (t) => {
  const { request, confirm, botApi } = await build(t);
  await request(OWNER_CHAT);
  const result = await confirm(sentCode(botApi));
  assert.equal(result.statusCode, 200);
  const calls = botApi.calls.slice(1);
  assert.deepEqual(calls.map(({ method, body }) => ({
    method,
    scope: body.scope,
    commands: body.commands?.map((command) => command.command),
    chatId: body.chat_id,
    keyboard: body.reply_markup?.keyboard,
    persistent: body.reply_markup?.is_persistent,
    resized: body.reply_markup?.resize_keyboard,
  })), [
    {
      method: 'setMyCommands',
      scope: { type: 'chat', chat_id: OWNER_CHAT },
      commands: ['start', 'status', 'help', 'clean'],
      chatId: undefined,
      keyboard: undefined,
      persistent: undefined,
      resized: undefined,
    },
    {
      method: 'sendMessage',
      scope: undefined,
      commands: undefined,
      chatId: OWNER_CHAT,
      keyboard: [
        [{ text: '📋 Конвейер' }, { text: '💬 Агент' }],
        [{ text: '📥 Задачи' }, { text: '⚙️ Ещё' }],
      ],
      persistent: true,
      resized: true,
    },
  ]);
});

test('неверный код — pult_code_mismatch; пятая неверная попытка аннулирует код', async (t) => {
  const { request, confirm, botApi } = await build(t);
  await request(OWNER_CHAT);
  const code = sentCode(botApi);

  for (let i = 0; i < 5; i += 1) {
    const res = await confirm('000000');
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'pult_code_mismatch');
  }
  // Код аннулирован: даже верный теперь отвечает «запроси новый».
  const res = await confirm(code);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'pult_code_expired');
});

test('просроченный код — pult_code_expired (TTL 10 минут)', async (t) => {
  const { request, confirm, botApi, clock } = await build(t);
  await request(OWNER_CHAT);
  const code = sentCode(botApi);
  clock.at = T0 + 10 * 60_000 + 1;
  const res = await confirm(code);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'pult_code_expired');
});

test('CAS: мутация с чужим botId отвергается', async (t) => {
  const { request, confirm, disable } = await build(t);
  for (const res of [
    await request(OWNER_CHAT, 999),
    await confirm('123456', 999),
    await disable(999),
  ]) {
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, 'telegram_account_changed');
  }
});

test('disable выключает, но выбор чата сохраняется; повторное включение требует нового кода', async (t) => {
  const { request, confirm, disable, status, botApi } = await build(t);
  await request(OWNER_CHAT);
  await confirm(sentCode(botApi));

  const off = await disable();
  assert.equal(off.statusCode, 200);
  const view = (await status()).pult;
  assert.equal(view.configured, true, 'выбор чата остался в namespace бота');
  assert.equal(view.confirmed, false);
  assert.equal(view.chatTitle, 'Аня');

  // Старый (уже использованный) код не воскресает после disable.
  const stale = await confirm(sentCode(botApi));
  assert.equal(stale.statusCode, 400);
  assert.equal(stale.json().error, 'pult_code_expired');

  // Новый запрос кода включает заново.
  await request(OWNER_CHAT);
  const ok = await confirm(sentCode(botApi));
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().pult.confirmed, true);
});

test('disable снимает команды и клавиатуру в той же личке, включая повторный вызов', async (t) => {
  const { request, confirm, disable, botApi } = await build(t);
  await request(OWNER_CHAT);
  await confirm(sentCode(botApi));
  botApi.calls.length = 0;
  assert.equal((await disable()).statusCode, 200);
  assert.equal((await disable()).statusCode, 200);
  assert.deepEqual(botApi.calls.map(({ method, body }) => ({
    method,
    scope: body.scope,
    chatId: body.chat_id,
    removeKeyboard: body.reply_markup?.remove_keyboard,
  })), [
    {
      method: 'deleteMyCommands',
      scope: { type: 'chat', chat_id: OWNER_CHAT },
      chatId: undefined,
      removeKeyboard: undefined,
    },
    {
      method: 'sendMessage',
      scope: undefined,
      chatId: OWNER_CHAT,
      removeKeyboard: true,
    },
    {
      method: 'deleteMyCommands',
      scope: { type: 'chat', chat_id: OWNER_CHAT },
      chatId: undefined,
      removeKeyboard: undefined,
    },
    {
      method: 'sendMessage',
      scope: undefined,
      chatId: OWNER_CHAT,
      removeKeyboard: true,
    },
  ]);
});

test('выключенный плагин — 404 plugin_disabled на всех ручках пульта', async (t) => {
  const { request, confirm, disable } = await build(t, { enabled: false });
  for (const res of [await request(OWNER_CHAT), await confirm('123456'), await disable()]) {
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'plugin_disabled');
  }
});

// --------------------------------------------- реальный store bot-settings.json

const ACC = 'acc_pult_store_fixture_0001';

test('bot-settings: setPult пишет поля, read их возвращает, disable гасит только подтверждение', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-pult-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new TelegramBotSettingsStore({
    file: path.join(dir, 'bot-settings.json'),
    accountRef: ACC,
    botId: String(BOT_ID),
    now: () => T0,
  });
  await store.setPult({ chatId: OWNER_CHAT, userId: OWNER_CHAT, confirmedAtMs: T0 });
  let view = await store.read();
  assert.equal(view.pultChatId, OWNER_CHAT);
  assert.equal(view.pultUserId, OWNER_CHAT);
  assert.equal(view.pultConfirmedAtMs, T0);

  await store.setPult({ chatId: OWNER_CHAT, userId: OWNER_CHAT, confirmedAtMs: null });
  view = await store.read();
  assert.equal(view.pultChatId, OWNER_CHAT);
  assert.equal(view.pultConfirmedAtMs, null);
  // Служебный чат при этом не задет.
  assert.equal(view.serviceChatId, null);
});

test('bot-settings: старый файл без полей пульта читается как «не настроено»', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-pult-store-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bot-settings.json');
  await writeFile(file, JSON.stringify({
    version: 1,
    accountRef: ACC,
    botId: BOT_ID,
    username: 'example_pult_bot',
    canReadAllGroupMessages: true,
    connectedAtMs: T0,
    serviceChatId: OWNER_CHAT,
    updatedAtMs: T0,
  }));
  const store = new TelegramBotSettingsStore({
    file, accountRef: ACC, botId: String(BOT_ID), now: () => T0 + 1,
  });
  const view = await store.read();
  assert.equal(view.serviceChatId, OWNER_CHAT);
  assert.equal(view.pultChatId, null);
  assert.equal(view.pultUserId, null);
  assert.equal(view.pultConfirmedAtMs, null);

  // Запись пульта не теряет старые поля и укладывается в строгую схему при чтении.
  await store.setPult({ chatId: OWNER_CHAT, userId: OWNER_CHAT, confirmedAtMs: T0 + 2 });
  const next = await store.read();
  assert.equal(next.serviceChatId, OWNER_CHAT);
  assert.equal(next.pultConfirmedAtMs, T0 + 2);
});
