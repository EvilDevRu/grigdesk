#!/usr/bin/env node
// Живой замер: какие апдейты Bot API реально доезжают до бота в ЛИЧКЕ.
//
// Главный вопрос — реакции (`message_reaction`, тот самый 👍 на сообщении).
// В документации сказано: «бот должен быть администратором чата и явно указать
// message_reaction в allowed_updates». В личной переписке администраторов нет
// вовсе, поэтому по документации не понять, приходит там реакция или нет.
// От ответа зависит проект: если реакции доезжают, «👍 на сообщение» станет
// подтверждением жалобы без единой команды; если нет — придётся обходиться
// командами, и это надо знать ДО того, как интерфейс будет на них рассчитан.
//
// Заодно меряются соседи: обычное сообщение, правка (`edited_message`),
// `message_reaction_count` и вообще всё, что придёт.
//
// Что делает: только ЧИТАЕТ (getMe, getWebhookInfo, getUpdates). Ничего не
// отправляет, вебхук не трогает, настройки бота не меняет.
//
// Токен: server/.state/telegram-creds.json (поле token) либо env TELEGRAM_BOT_TOKEN.
// В выводе токен маскируется всегда — отчёт можно показывать кому угодно.
//
// Запуск:
//   node tools/telegram-reactions-probe.mjs [--sec 180] [--report /путь/report.json]

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CREDS = path.join(ROOT, 'server', '.state', 'telegram-creds.json');

// Без явного перечисления Telegram НЕ шлёт реакции вовсе — это и проверяем.
const ALLOWED = [
  'message', 'edited_message', 'channel_post', 'edited_channel_post',
  'message_reaction', 'message_reaction_count',
  'my_chat_member', 'chat_member',
];

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const LIMIT_SEC = Number(argOf('--sec', '180'));
const REPORT = argOf('--report', '');

function readToken() {
  const env = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (env) return { token: env, from: 'env TELEGRAM_BOT_TOKEN' };
  let raw;
  try {
    raw = JSON.parse(readFileSync(CREDS, 'utf8'));
  } catch (e) {
    const why = e.code === 'ENOENT' ? 'файла нет' : e.message;
    return fail(`токен не прочитан (${CREDS}): ${why}.\n`
      + '  Положить его так (токен — из @BotFather):\n'
      + '    mkdir -p server/.state \\\n'
      + '      && printf \'{"token":"ВСТАВЬ_ТОКЕН"}\' > server/.state/telegram-creds.json \\\n'
      + '      && chmod 600 server/.state/telegram-creds.json');
  }
  const token = String(raw.token || '').trim();
  if (token) return { token, from: CREDS };
  return fail(`в ${CREDS} нет поля token`);
}

/** В выводе живёт только хвост: по нему видно, тот ли это бот, но войти нельзя. */
const mask = (token) => `…${token.slice(-6)}`;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function call(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    const why = json.description || `HTTP ${res.status}`;
    throw new Error(`${method}: ${why}`);
  }
  return json.result;
}

/** Короткая человеческая строка про апдейт — читать её будут в терминале. */
function describe(u) {
  const type = Object.keys(u).find((k) => k !== 'update_id') || '?';
  const body = u[type] || {};
  const chat = body.chat || body.from || {};
  const where = chat.type ? `${chat.type}${chat.id ? ` ${chat.id}` : ''}` : '';
  if (type === 'message' || type === 'edited_message') {
    const text = (body.text || body.caption || '(без текста)').replace(/\s+/g, ' ').slice(0, 60);
    return { type, where, brief: text };
  }
  if (type === 'message_reaction') {
    const emo = (r) => r.map((x) => x.emoji || x.custom_emoji_id || x.type).join(' ');
    return {
      type,
      where,
      brief: `msg ${body.message_id}: [${emo(body.old_reaction || [])}] → [${emo(body.new_reaction || [])}]`,
    };
  }
  if (type === 'message_reaction_count') {
    const counts = (body.reactions || []).map((r) => `${r.type?.emoji || '?'}×${r.total_count}`);
    return { type, where, brief: `msg ${body.message_id}: ${counts.join(' ') || 'пусто'}` };
  }
  return { type, where, brief: '' };
}

const seen = new Map(); // тип апдейта → сколько раз пришёл
const samples = new Map(); // тип → первый образец целиком (для отчёта)

async function main() {
  const { token, from } = readToken();
  console.log(`токен: ${mask(token)} (из ${from})`);

  const me = await call(token, 'getMe').catch((e) => fail(e.message));
  console.log(`бот: @${me.username} (${me.id})`);

  // Вебхук и getUpdates взаимно исключают друг друга: при живом вебхуке
  // getUpdates отвечает 409. Снимать его молча нельзя — он мог быть настроен
  // не нами, поэтому просто говорим человеку, что делать.
  const hook = await call(token, 'getWebhookInfo');
  if (hook.url) {
    fail(`у бота настроен вебхук (${hook.url}) — getUpdates работать не будет.\n`
      + '  Либо возьми другого бота, либо сними вебхук: deleteWebhook.');
  }

  console.log(`\nСлушаю ${LIMIT_SEC} с. Сделай в ЛИЧКЕ с ботом по порядку:`);
  console.log('  1. напиши ему любое сообщение;');
  console.log('  2. поставь 👍 на своё же сообщение;');
  console.log('  3. поправь своё сообщение (edit);');
  console.log('  4. если бот что-то ответит — поставь 👍 и на его сообщение.\n');

  const until = Date.now() + LIMIT_SEC * 1000;
  let offset = 0;
  while (Date.now() < until) {
    const left = Math.max(1, Math.round((until - Date.now()) / 1000));
    let updates;
    try {
      // Длинный поллинг: не дольше остатка замера, иначе последний запрос
      // висел бы уже после срока и скрипт «зависал» бы в конце.
      updates = await call(token, 'getUpdates', {
        offset,
        timeout: Math.min(25, left),
        allowed_updates: ALLOWED,
      });
    } catch (e) {
      console.log(`  ! ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      const { type, where, brief } = describe(u);
      seen.set(type, (seen.get(type) || 0) + 1);
      if (!samples.has(type)) samples.set(type, u);
      const at = new Date().toLocaleTimeString('ru-RU');
      console.log(`  ${at}  ${type}${where ? `  [${where}]` : ''}${brief ? `  ${brief}` : ''}`);
    }
  }

  console.log('\n— итог —');
  if (!seen.size) {
    console.log('не пришло НИЧЕГО. Проверь, что писал именно этому боту (@'
      + `${me.username}) и что замер шёл во время переписки.`);
  }
  for (const [type, n] of seen) console.log(`  ${type}: ${n}`);

  const reactions = seen.get('message_reaction') || 0;
  console.log('\nВЕРДИКТ по реакциям в личке: '
    + (reactions
      ? `ДОЕЗЖАЮТ (${reactions} шт.) — 👍 можно делать подтверждением жалобы.`
      : 'НЕ ДОЕЗЖАЮТ — подтверждение придётся вешать на команду/кнопку.'));
  if (!reactions && seen.size) {
    console.log('  (сообщения приходили, значит связь и токен в порядке —'
      + ' молчат именно реакции.)');
  }

  if (REPORT) {
    writeFileSync(REPORT, JSON.stringify({
      bot: { id: me.id, username: me.username },
      seconds: LIMIT_SEC,
      allowedUpdates: ALLOWED,
      counts: Object.fromEntries(seen),
      reactionsDelivered: reactions > 0,
      samples: Object.fromEntries(samples),
    }, null, 2));
    console.log(`\nотчёт: ${REPORT}`);
  }
}

main().catch((e) => fail(e.message));
