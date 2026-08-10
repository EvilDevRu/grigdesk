import assert from 'node:assert/strict';
import test from 'node:test';

import { apiHarness, chatStoreFixture } from './helpers/chat-store.js';

function session(id, extra = {}) {
  return {
    id,
    taskId: null,
    title: id,
    model: 'test-model',
    modelRef: { provider: 'test-provider', model: 'test-model' },
    effort: '',
    mode: '',
    messages: [],
    sessionId: null,
    contextTokens: 0,
    draft: '',
    sending: false,
    compacting: false,
    steps: [],
    createdAt: 100,
    updatedAt: 200,
    ...extra,
  };
}

test('выбор архивного чата открывает его на месте, не восстанавливая', async () => {
  const opened = session('opened');
  const archived = session('archived', { closedAt: 300 });
  const chat = await chatStoreFixture({ sessions: [opened], archived: [archived] });
  const archivedInStore = chat.archived[0];

  chat.selectChat(archived.id);

  assert.equal(chat.activeId, archived.id);
  assert.equal(chat.active, archivedInStore, 'выбранный архивный чат доступен экрану разговора');
  assert.equal(chat.session(archived.id), archivedInStore);
  assert.deepEqual(chat.sessions, [opened], 'активные чаты не изменились от просмотра');
  assert.deepEqual(chat.archived, [archived], 'чат остался в архиве');
  assert.equal(archived.closedAt, 300, 'метка архивирования не снята');
});

test('новое сообщение достаёт выбранный чат из архива до запуска агента', async () => {
  const opened = session('opened');
  const archived = session('archived', { closedAt: 300, draft: 'Продолжаем' });
  const chat = await chatStoreFixture({ sessions: [opened], archived: [archived] });
  const archivedInStore = chat.archived[0];
  const calls = [];
  apiHarness.put = async (url, body) => {
    calls.push({ method: 'PUT', url, body });
    return { ok: true };
  };
  apiHarness.post = async (url, body) => {
    calls.push({ method: 'POST', url, body });
    return { reply: 'Готово', sessionId: 'continued-session' };
  };

  chat.selectChat(archived.id);
  const accepted = await chat.send(archived.id, 'Продолжаем');

  assert.equal(accepted, true);
  assert.equal(chat.archived.length, 0);
  assert.equal(chat.sessions.at(-1), archivedInStore, 'в активные перенесён исходный объект');
  assert.equal(chat.activeId, archived.id);
  assert.equal(archived.closedAt, undefined);
  assert.deepEqual(archived.messages.map((message) => message.role), ['user', 'assistant']);

  const save = calls.find((call) => call.method === 'PUT' && call.url === '/api/chat/store/chat');
  const run = calls.find((call) => call.method === 'POST' && call.url === '/api/chat');
  assert.ok(save, 'продолжаемый чат сохранён перед запуском агента');
  assert.equal(save.body.archived, false, 'первое сохранение продолжения уже не архивное');
  assert.ok(run, 'после сохранения запущен новый ход');
  assert.ok(calls.indexOf(save) < calls.indexOf(run), 'перенос сохранён до model POST');
});
