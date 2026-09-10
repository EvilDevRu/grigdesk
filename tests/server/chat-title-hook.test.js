import assert from 'node:assert/strict';
import test from 'node:test';

import {
  finishChatTitleHook,
  normalizeChatTitle,
  visibleChatTitleStep,
  withChatTitleHook,
} from '../../server/src/lib/chat/titleHook.ts';

test('хук добавляется только к первому ходу, не создавая отдельного запроса', () => {
  assert.equal(withChatTitleHook('Проверь авторизацию', false), 'Проверь авторизацию');
  const prompt = withChatTitleHook('Проверь авторизацию', true);
  assert.match(prompt, /COCKPIT_CHAT_TITLE/);
  assert.match(prompt, /ровно три слова/i);
  assert.match(prompt, /^Проверь авторизацию/);
  assert.match(prompt, /\[\/Служебный хук Cockpit\]$/);
});

test('семантическое название извлекается, а служебный маркер исчезает из ответа и шагов', () => {
  const result = finishChatTitleHook({
    reply: 'Авторизация исправлена.\n\n[[COCKPIT_CHAT_TITLE|Исправление Ошибки Авторизации]]',
    steps: [
      { k: 'think', text: 'Проверяю код.' },
      { k: 'text', text: 'Готово.\n[[COCKPIT_CHAT_TITLE|Исправление Ошибки Авторизации]]' },
    ],
  }, true);

  assert.equal(result.title, 'Исправление Ошибки Авторизации');
  assert.equal(result.reply, 'Авторизация исправлена.');
  assert.deepEqual(result.steps, [
    { k: 'think', text: 'Проверяю код.' },
    { k: 'text', text: 'Готово.' },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /COCKPIT_CHAT_TITLE/);
});

test('в протокол проходит только безопасное название ровно из трёх слов', () => {
  assert.equal(normalizeChatTitle('Ремонт OAuth callback'), 'Ремонт OAuth callback');
  assert.equal(normalizeChatTitle('слишком много слов в названии'), '');
  assert.equal(normalizeChatTitle('<b>Опасная HTML вставка</b>'), '');

  const invalid = finishChatTitleHook({
    reply: 'Обычный ответ.\n[[COCKPIT_CHAT_TITLE|Слишком Длинное Имя Чата]]',
    steps: [],
  }, true);
  assert.equal(invalid.reply, 'Обычный ответ.');
  assert.equal(invalid.title, undefined);
});

test('маркер без пользовательского текста не создаёт пустой шаг', () => {
  assert.equal(visibleChatTitleStep({
    k: 'text',
    text: '[[COCKPIT_CHAT_TITLE|Краткое Имя Чата]]',
  }, true), null);
});

test('в обычных ходах похожий текст не считается служебным протоколом', () => {
  const result = finishChatTitleHook({
    reply: 'Пример: [[COCKPIT_CHAT_TITLE|Краткое Имя Чата]]',
    steps: [],
  }, false);
  assert.match(result.reply, /COCKPIT_CHAT_TITLE/);
  assert.equal(result.title, undefined);
});
