// Подключение бота из интерфейса: `GET /api/telegram/status` и
// `POST /api/telegram/connect`. Форма в настройках заменяет терминальный шаг
// «положи токен в файл руками», поэтому цена ошибок здесь ровно та же, что
// у файла: неправильный токен не должен сохраняться, а правильный — светиться
// в ответах, логах и текстах ошибок.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import telegramModule from '../../server/src/modules/telegram/index.ts';
import {
  TelegramModuleCredentials,
  telegramModuleConnection,
} from './helpers/telegram-account-module.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

const TOKEN = '8123456789:AAHrEaLLyLoNgSeCrEtPaRt_x1y2z3w4v5u6';
const SECRET = 'AAHrEaLLyLoNgSeCrEtPaRt';

// Форма уже нормализованная: snake_case Телеграма разбирает сам lib/telegram/api.js.
const ME = {
  id: 8123456789,
  username: 'example_inbox_bot',
  firstName: 'Кокпит · входящие',
  canJoinGroups: true,
  canReadAllGroupMessages: false,
};

/**
 * Сервер с модулем и подставным Bot API.
 * @param {{ enabled?: boolean, getMe?: Function }} opts
 */
async function build(t, { enabled = true, getMe } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-connect-'));
  const creds = new TelegramModuleCredentials();
  const calls = [];
  const botApi = {
    getMe: async (token) => {
      calls.push(token);
      try {
        if (getMe) return await getMe(token);
        return ME;
      } catch (error) {
        if (error?.code === 'ENOTFOUND') {
          throw Object.assign(error, { kind: 'transport', statusCode: 502 });
        }
        throw Object.assign(error, { kind: 'telegram', statusCode: 400 });
      }
    },
    callBotApi: async () => { throw new Error('network not expected'); },
  };
  const archive = { chats: async () => [], topics: async () => [] };
  const rules = { read: async () => [], write: async (value) => value };
  const connection = telegramModuleConnection({ creds, archive, rules, botApi });

  const app = Fastify({ logger: false });
  app.decorate('pluginEnabled', () => enabled);
  app.register(telegramModule, {
    connection,
    botApi,
  });
  await app.ready();
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const connect = (body) => app.inject({ method: 'POST', url: '/api/telegram/connect', payload: body });
  const status = () => app.inject({ method: 'GET', url: '/api/telegram/status' });
  const disconnect = () => app.inject({ method: 'POST', url: '/api/telegram/disconnect' });
  const recheck = () => app.inject({ method: 'POST', url: '/api/telegram/recheck' });
  return { app, creds, calls, connect, status, disconnect, recheck };
}

test('выключенный плагин — 404 plugin_disabled на всех роутах', async (t) => {
  const { status, connect, disconnect, recheck, calls } = await build(t, { enabled: false });
  for (const res of [await status(), await connect({ token: TOKEN }), await disconnect(), await recheck()]) {
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'plugin_disabled');
  }
  assert.deepEqual(calls, [], 'выключенный плагин в сеть не ходит');
});

test('не настроено: статус честно пустой, без выдумок', async (t) => {
  const { status } = await build(t);
  const body = (await status()).json();
  assert.equal(body.bot.configured, false);
  assert.equal(body.bot.username, '');
});

test('успешное подключение: токен сохранён, в ответе его нет', async (t) => {
  const { connect, status, creds } = await build(t);

  const res = await connect({ token: `  ${TOKEN}  ` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.bot.username, 'example_inbox_bot');
  assert.equal(body.bot.botId, 8123456789);
  assert.equal(body.bot.configured, true);
  assert.equal(body.bot.tokenHint, '…v5u6');
  assert.ok(!res.payload.includes(SECRET), 'секрет уехал в ответ');

  // Пробелы по краям срезаны — иначе сохранённый токен не совпал бы с проверенным.
  assert.equal(creds.read().token, TOKEN);
  assert.equal((await status()).json().bot.configured, true);
});

test('режим приватности виден: без него бот в группе не увидит жалоб', async (t) => {
  const { connect } = await build(t);
  const body = (await connect({ token: TOKEN })).json();
  // canReadAllGroupMessages из getMe — это и есть выключенный privacy mode.
  assert.equal(body.bot.canReadAllGroupMessages, false);
  assert.ok(body.bot.privacyHint, 'при включённой приватности нужна подсказка, что чинить');
});

test('кривая форма токена: 400 и НИ ОДНОГО запроса в сеть', async (t) => {
  const { connect, calls, creds } = await build(t);
  for (const token of ['', '   ', 'просто текст', '8123456789', '8123456789:short']) {
    const res = await connect({ token });
    assert.equal(res.statusCode, 400, `форма «${token}» принята`);
    assert.equal(res.json().error, 'telegram_bad_token');
  }
  assert.deepEqual(calls, [], 'до Телеграма дело дойти не должно');
  assert.equal(creds.has(), false);
});

test('Телеграм не принял токен — не сохраняем', async (t) => {
  const { connect, creds } = await build(t, {
    getMe: async () => { throw new Error('Unauthorized'); },
  });
  const res = await connect({ token: TOKEN });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'telegram_rejected');
  assert.equal(creds.has(), false, 'непроверенный токен сохранён');
});

test('сеть недоступна — отдельная причина, а не «токен плохой»', async (t) => {
  const { connect, creds } = await build(t, {
    getMe: async () => { throw Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' }); },
  });
  const res = await connect({ token: TOKEN });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, 'telegram_unreachable');
  assert.equal(creds.has(), false);
});

test('токен не протекает в текст ошибки, даже если Телеграм вернул его в описании', async (t) => {
  const { connect } = await build(t, {
    getMe: async () => { throw new Error(`https://api.telegram.org/bot${TOKEN}/getMe: 404 Not Found`); },
  });
  const res = await connect({ token: TOKEN });
  assert.ok(!res.payload.includes(SECRET), `секрет в ответе: ${res.payload}`);
  assert.equal(res.json().error, 'telegram_rejected');
});

test('другой bot требует явного disconnect и только после него подключается', async (t) => {
  const { connect, disconnect, status } = await build(t, {
    getMe: async (token) => (token.startsWith('8123') ? ME : { ...ME, id: 5550001111, username: 'second_bot' }),
  });
  assert.equal((await connect({ token: TOKEN })).statusCode, 200);
  const token = '5550001111:BBHrEaLLyLoNgSeCrEtPaRt_x1y2z3w4v5u6';
  const blocked = await connect({ token });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().error, 'telegram_already_configured');
  await disconnect();
  const second = await connect({ token });
  assert.equal(second.statusCode, 200);
  assert.equal((await status()).json().bot.username, 'second_bot');
});

// Перепроверка нужна ровно из-за режима приватности: его выключают в @BotFather
// ПОСЛЕ подключения, и без неё кокпит показывал бы состояние на момент, когда
// токен вставили.
test('перепроверка обновляет данные бота тем же токеном', async (t) => {
  let privacyOff = false;
  const { connect, recheck, status, calls, creds } = await build(t, {
    getMe: async () => ({ ...ME, canReadAllGroupMessages: privacyOff }),
  });
  await connect({ token: TOKEN });
  const connectedAt = creds.read().connectedAt;

  privacyOff = true; // человек сходил в @BotFather → /setprivacy → Disable
  const res = await recheck();
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().bot.canReadAllGroupMessages, true);
  assert.equal(res.json().bot.privacyHint, '', 'подсказка про приватность больше не нужна');
  assert.equal((await status()).json().bot.canReadAllGroupMessages, true);

  assert.deepEqual(calls, [TOKEN, TOKEN], 'перепроверка идёт сохранённым токеном');
  // Перепроверка — не подключение: дата подключения не съезжает на «только что».
  assert.equal(creds.read().connectedAt, connectedAt);
});

test('перепроверять нечего, пока бот не подключён', async (t) => {
  const { recheck, calls } = await build(t);
  const res = await recheck();
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'telegram_not_connected');
  assert.deepEqual(calls, [], 'без токена в сеть не ходим');
});

test('отказ на перепроверке токен НЕ стирает', async (t) => {
  let fail = false;
  const { connect, recheck, creds } = await build(t, {
    getMe: async () => {
      if (fail) throw Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' });
      return ME;
    },
  });
  await connect({ token: TOKEN });

  fail = true;
  const res = await recheck();
  assert.equal(res.statusCode, 502);
  // Удалять рабочий ключ из-за одного неудачного ответа — не решение кокпита.
  assert.equal(creds.read().token, TOKEN);
  assert.equal(res.json().error, 'telegram_unreachable');
});

test('отключение стирает токен', async (t) => {
  const { connect, disconnect, status, creds } = await build(t);
  await connect({ token: TOKEN });
  const res = await disconnect();
  assert.equal(res.statusCode, 200);
  assert.equal(creds.has(), false);
  assert.equal((await status()).json().bot.configured, false);
});
