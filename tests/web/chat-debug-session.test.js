import assert from 'node:assert/strict';
import test from 'node:test';

import { apiHarness, chatStoreFixture } from './helpers/chat-store.js';

const SOURCE_CHAT = {
  id: 'source-chat',
  taskId: '8165',
  title: 'Исходный разговор',
  purpose: '',
  sourceChatId: null,
  messages: [{ role: 'user', text: 'Экспорт падает' }],
  sessionId: 'source-session',
  contextTokens: 0,
  draft: '',
  createdAt: 100,
  updatedAt: 200,
  sending: false,
  compacting: false,
  steps: [],
};

test('Debug открывается отдельным черновиком задачи, переиспользуется и восстанавливается из архива', async () => {
  const chat = await chatStoreFixture({ sessions: [{ ...SOURCE_CHAT }] });
  const posts = [];
  const puts = [];
  apiHarness.post = async (...args) => { posts.push(args); return {}; };
  apiHarness.put = async (url, body) => { puts.push({ url, body }); return { ok: true }; };

  const context = '  Ошибка: экспорт завершается с кодом 500.  ';
  const expectedDraft = [
    'Работай в песочнице задачи #8165 в режиме Debug: воспроизведи описанную ошибку, докажи первопричину, внеси минимальное исправление и выполни релевантные проверки.',
    'Не начинай менять worktree, пока Hunt или другой читающий конвейер этой задачи ещё выполняется.',
    '\nКонтекст исходного разговора:\nОшибка: экспорт завершается с кодом 500.',
  ].join('\n');

  const created = await chat.openDebugFor({
    taskId: 8165,
    taskTitle: 'Экспорт',
    sourceChatId: SOURCE_CHAT.id,
    context,
  });
  const debug = chat.sessions.find((session) => session.id === created.id);

  assert.equal(created.created, true);
  assert.notEqual(created.id, SOURCE_CHAT.id, 'Debug получает отдельный chat id');
  assert.ok(debug);
  assert.equal(debug.taskId, SOURCE_CHAT.taskId, 'Debug остаётся в песочнице той же задачи');
  assert.equal(debug.purpose, 'debug');
  assert.equal(debug.sourceChatId, SOURCE_CHAT.id);
  assert.equal(debug.draft, expectedDraft);
  assert.deepEqual(debug.messages, [], 'постановка остаётся черновиком, а не сообщением');
  assert.equal(debug.sending, false);
  assert.equal(chat.activeId, debug.id);
  assert.equal(chat.open, true);

  const saved = puts.find(({ url, body }) => (
    url === '/api/chat/store/chat' && body.chat.id === debug.id
  ));
  assert.ok(saved, 'новый Debug-чат сразу сохраняется');
  assert.equal(saved.body.chat.purpose, 'debug');
  assert.equal(saved.body.chat.sourceChatId, SOURCE_CHAT.id);
  assert.equal(saved.body.chat.draft, expectedDraft);

  const reused = await chat.openDebugFor({
    taskId: '8165',
    taskTitle: 'Другое название не создаёт дубль',
    sourceChatId: 'another-source',
    context: 'Новый контекст не заменяет уже подготовленный черновик',
  });
  assert.deepEqual(reused, { id: debug.id, created: false });
  assert.equal(chat.sessions.filter((session) => session.purpose === 'debug').length, 1);
  assert.equal(debug.sourceChatId, SOURCE_CHAT.id);
  assert.equal(debug.draft, expectedDraft);

  assert.equal(chat.deleteChat(debug.id), 'archived');
  assert.equal(chat.sessions.some((session) => session.id === debug.id), false);
  assert.equal(chat.archived.some((session) => session.id === debug.id), true);

  const restored = await chat.openDebugFor({ taskId: 8165, sourceChatId: SOURCE_CHAT.id });
  assert.deepEqual(restored, { id: debug.id, created: false });
  assert.equal(chat.archived.some((session) => session.id === debug.id), false);
  assert.equal(chat.sessions.find((session) => session.id === debug.id), debug);
  assert.equal(chat.activeId, debug.id);
  assert.equal(debug.draft, expectedDraft);
  assert.deepEqual(debug.messages, []);
  assert.deepEqual(posts, [], 'открытие, переиспользование и восстановление не запускают send');
});
