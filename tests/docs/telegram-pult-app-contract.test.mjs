// Проверяет, что документация Telegram-пульта содержит обязательный пользовательский и безопасностный контракт.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const contractUrl = new URL('../../docs/cockpit/telegram-pult.md', import.meta.url);

test('PULT-DOC-01: канон описывает клавиатуру и безопасный разговор с ассистентом', async () => {
  const text = await readFile(contractUrl, 'utf8');
  const clauses = [
    ['новый принцип', /смотрит,\s*разблокирует\s+и\s+поручает/iu],
    ['постоянная клавиатура', /ReplyKeyboardMarkup[\s\S]*is_persistent[\s\S]*resize_keyboard/u],
    ['четыре кнопки', /📋 Конвейер[\s\S]*💬 Агент[\s\S]*📥 Задачи[\s\S]*⚙️ Ещё/u],
    ['команды только владельцу', /setMyCommands[\s\S]*(scope|BotCommandScopeChat)[\s\S]*личк/iu],
    ['общий companion', /store\/ensure[\s\S]*purpose[^\n]*companion[\s\S]*taskId[^\n]*null/iu],
    ['обычный auto-ход', /mode[^\n]*auto[\s\S]*без[^\n]*companionTurn/iu],
    ['запрет обхода спроса', /dontAsk[\s\S]*bypassPermissions[\s\S]*(не|never)/iu],
    ['тихий прогресс и Стоп', /sendChatAction[\s\S]*typing[\s\S]*30\s*секунд[\s\S]*Стоп/iu],
    ['управление памятью', /\/api\/chat\/compact[\s\S]*\/api\/chat\/session\/reset/u],
    ['голос в одном ответе', /услышал:\s*…[\s\S]*(одном|ответ)/iu],
    ['обрыв при рестарте', /\/api\/chat\/active[\s\S]*(перезапуск|рестарт)/iu],
  ];
  const missing = clauses.filter(([, pattern]) => !pattern.test(text)).map(([name]) => name);
  assert.deepEqual(missing, []);
});
