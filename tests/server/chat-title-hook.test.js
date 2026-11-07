import assert from 'node:assert/strict';
import test from 'node:test';

import {
  finishChatTitleHook,
  normalizeChatTitle,
  visibleChatTitleStep,
  withChatTitleHook,
} from '../../server/src/lib/chat/titleHook.ts';

import {
  chatAppFixture,
  controlledExecutor,
  saveChat,
  turnBody,
  waitFor,
} from './helpers/chat-turns.js';

test('хук добавляется только к первому ходу, не создавая отдельного запроса', () => {
  assert.equal(withChatTitleHook('Проверь авторизацию', false), 'Проверь авторизацию');
  const prompt = withChatTitleHook('Проверь авторизацию', true);
  assert.match(prompt, /GRIGDESK_CHAT_TITLE/);
  assert.match(prompt, /ровно три слова/i);
  assert.match(prompt, /^Проверь авторизацию/);
  assert.match(prompt, /\[\/Служебный хук GrigDesk\]$/);
});

test('семантическое название извлекается, а служебный маркер исчезает из ответа и шагов', () => {
  const result = finishChatTitleHook({
    reply: 'Авторизация исправлена.\n\n[[GRIGDESK_CHAT_TITLE|Исправление Ошибки Авторизации]]',
    steps: [
      { k: 'think', text: 'Проверяю код.' },
      { k: 'text', text: 'Готово.\n[[GRIGDESK_CHAT_TITLE|Исправление Ошибки Авторизации]]' },
    ],
  }, true);

  assert.equal(result.title, 'Исправление Ошибки Авторизации');
  assert.equal(result.reply, 'Авторизация исправлена.');
  assert.deepEqual(result.steps, [
    { k: 'think', text: 'Проверяю код.' },
    { k: 'text', text: 'Готово.' },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /GRIGDESK_CHAT_TITLE/);
});

test('в протокол проходит только безопасное название ровно из трёх слов', () => {
  assert.equal(normalizeChatTitle('Ремонт OAuth callback'), 'Ремонт OAuth callback');
  assert.equal(normalizeChatTitle('слишком много слов в названии'), '');
  assert.equal(normalizeChatTitle('<b>Опасная HTML вставка</b>'), '');

  const invalid = finishChatTitleHook({
    reply: 'Обычный ответ.\n[[GRIGDESK_CHAT_TITLE|Слишком Длинное Имя Чата]]',
    steps: [],
  }, true);
  assert.equal(invalid.reply, 'Обычный ответ.');
  assert.equal(invalid.title, undefined);
});

test('маркер без пользовательского текста не создаёт пустой шаг', () => {
  assert.equal(visibleChatTitleStep({
    k: 'text',
    text: '[[GRIGDESK_CHAT_TITLE|Краткое Имя Чата]]',
  }, true), null);
});

test('в обычных ходах похожий текст не считается служебным протоколом', () => {
  const result = finishChatTitleHook({
    reply: 'Пример: [[GRIGDESK_CHAT_TITLE|Краткое Имя Чата]]',
    steps: [],
  }, false);
  assert.match(result.reply, /GRIGDESK_CHAT_TITLE/);
  assert.equal(result.title, undefined);
});

test('маркер названия очищается из SSE и журнала блока до переноса финала', async (t) => {
  const { executor, waitForRuns } = controlledExecutor();
  const { app, events } = await chatAppFixture(t, { executor });
  const chatKey = 'chat-title-fixture';
  const assistantMessageId = 'assistant-title-final';
  const reply = 'Документы проверены.\n[[GRIGDESK_CHAT_TITLE|Проверка Трёх Документов]]';

  await saveChat(app, chatKey);

  const started = await app.inject({
    method: 'POST',
    url: '/api/chat',
    payload: turnBody(chatKey, 'turn-title-fixture', 'Проверь документы.', { requestTitle: true }),
  });

  assert.equal(started.statusCode, 202, started.body);

  const [run] = await waitForRuns(1);

  await run.options.onAssistantMessage({
    assistantMessageId,
    text: reply,
    sourceRevision: 1,
    complete: true,
  });

  const published = events.find((event) => event.event === 'chat-assistant-message');

  assert.equal(published.data.block.text, 'Документы проверены.');
  assert.equal(published.data.block.complete, true);

  const page = await app.inject({
    method: 'GET',
    url: `/api/chat/in-turn?chatKey=${chatKey}&runId=${published.data.runId}`,
  });

  assert.equal(page.statusCode, 200, page.body);
  assert.equal(page.json().entries[0].text, 'Документы проверены.');

  run.release(reply, { assistantMessageId });

  const final = await waitFor(async () => {
    const response = await app.inject({ method: 'GET', url: '/api/chat/pending' });

    return response.json().pending.find((item) => item.turnId === 'turn-title-fixture');
  }, { what: 'финал с очищенным названием' });

  assert.equal(final.reply, 'Документы проверены.');
  assert.equal(final.title, 'Проверка Трёх Документов');
  assert.equal(final.finalAssistantMessageId, assistantMessageId);
});
