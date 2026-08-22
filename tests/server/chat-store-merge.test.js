// Сервер не теряет сообщений: присланная отставшим окном лента может только дополнять
// серверную копию, но не стирать уже доставленные ответы агента.
import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChatHistoryStore } from '../../server/src/lib/chat/history-store.js';
import { mergeMessages, mergeChat } from '../../server/src/lib/chat/merge-chat.js';

const msg = (role, text) => ({ role, text });

async function freshStore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-chat-merge-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new ChatHistoryStore({ chatsDir: path.join(root, 'chats') });
}

const baseChat = (over = {}) => ({
  id: 'chat-1',
  title: 'Разговор',
  messages: [msg('user', 'Вопрос 1'), msg('assistant', 'Ответ 1')],
  createdAt: Date.UTC(2026, 7, 1, 1),
  updatedAt: Date.UTC(2026, 7, 1, 2),
  ...over,
});

test('отставшее окно не стирает сообщения, дошедшие до другого устройства', async (t) => {
  const store = await freshStore(t);
  // Планшет: ход прошёл, ответ агента записан.
  await store.saveOne(baseChat({
    messages: [msg('user', 'Вопрос 1'), msg('assistant', 'Ответ 1'), msg('user', 'Вопрос 2'), msg('assistant', 'Ответ 2')],
    updatedAt: Date.UTC(2026, 7, 1, 4),
  }), false);

  // Компьютер: его копия осталась на состоянии двухчасовой давности.
  const res = await store.saveOne(baseChat(), false);
  assert.equal(res.restored, 2);

  const state = await store.read();
  assert.deepEqual(state.sessions[0].messages.map((m) => m.text),
    ['Вопрос 1', 'Ответ 1', 'Вопрос 2', 'Ответ 2']);
});

test('метка обрыва связи уступает пришедшему ответу агента', async (t) => {
  const store = await freshStore(t);
  // Ответ дошёл до сервера (через chats/pending — окно к тому моменту уже отвалилось).
  await store.saveOne(baseChat({
    messages: [msg('user', 'Вопрос 1'), msg('assistant', 'Ответ 1'), msg('user', 'Вопрос 2'), msg('assistant', 'Ответ 2')],
  }), false);

  // Окно тем временем записало в свою ленту сетевую ошибку и задало следующий вопрос.
  const res = await store.saveOne(baseChat({
    messages: [
      msg('user', 'Вопрос 1'), msg('assistant', 'Ответ 1'), msg('user', 'Вопрос 2'),
      msg('error', 'Failed to fetch'), msg('user', 'Вопрос 3'),
    ],
    updatedAt: Date.UTC(2026, 7, 1, 5),
  }), false);
  assert.equal(res.dropped, 1);

  const state = await store.read();
  assert.deepEqual(state.sessions[0].messages.map((m) => m.text),
    ['Вопрос 1', 'Ответ 1', 'Вопрос 2', 'Ответ 2', 'Вопрос 3']);
});

test('обычное дополнение ленты идёт как есть', async (t) => {
  const store = await freshStore(t);
  await store.saveOne(baseChat(), false);
  const res = await store.saveOne(baseChat({
    messages: [...baseChat().messages, msg('user', 'Вопрос 2')],
    updatedAt: Date.UTC(2026, 7, 1, 3),
  }), false);

  assert.equal(res.restored, 0);
  assert.equal(res.dropped, 0);
  assert.equal(res.written, true);
  const state = await store.read();
  assert.equal(state.sessions[0].messages.length, 3);
});

test('очистка чата человеком уважается', async (t) => {
  const store = await freshStore(t);
  const current = await store.saveOne(baseChat(), false);
  // Явная очистка является CAS-операцией: только окно с текущей revision вправе
  // отличить намеренное действие от пустого stale-снимка до первого ответа.
  await store.saveOne({
    ...current.chat,
    messages: [],
    updatedAt: Date.UTC(2026, 7, 1, 3),
  }, false);
  const state = await store.read();
  assert.deepEqual(state.sessions[0].messages, []);
});

test('пустая stale-копия не очищает сообщения другого окна', async (t) => {
  const store = await freshStore(t);
  const empty = await store.saveOne(baseChat({ messages: [] }), false);
  const filled = await store.saveOne({
    ...empty.chat,
    messages: [msg('user', 'Вопрос'), msg('assistant', 'Ответ')],
    sessionId: 'live-session',
    contextTokens: 42_000,
    updatedAt: Date.UTC(2026, 7, 1, 3),
  }, false);
  assert.equal(filled.chat.messages.length, 2);

  const stale = await store.saveOne(empty.chat, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.restored, 2);
  const persisted = await store.readOne(empty.chat.id);
  assert.deepEqual(persisted.messages.map((message) => message.text), ['Вопрос', 'Ответ']);
  assert.equal(persisted.sessionId, 'live-session');
  assert.equal(persisted.contextTokens, 42_000);
});

test('одновременные сохранения двух окон не теряют ни одного хвоста', async (t) => {
  const store = await freshStore(t);
  await store.saveOne(baseChat(), false);

  await Promise.all([
    store.saveOne(baseChat({
      messages: [...baseChat().messages, msg('user', 'С компьютера')],
      updatedAt: Date.UTC(2026, 7, 1, 3),
    }), false),
    store.saveOne(baseChat({
      messages: [...baseChat().messages, msg('user', 'С планшета')],
      updatedAt: Date.UTC(2026, 7, 1, 3),
    }), false),
  ]);

  const texts = (await store.read()).sessions[0].messages.map((m) => m.text);
  assert.ok(texts.includes('С компьютера'), texts.join(' | '));
  assert.ok(texts.includes('С планшета'), texts.join(' | '));
});

test('состояние агента не откатывается копией из отставшего окна', () => {
  const disk = baseChat({
    sessionId: 'новая-сессия', contextTokens: 90_000, contextWindow: 258_400,
    contextMetric: 'active-input-v1', totalInputTokens: 2_000_000, cachedInputTokens: 1_800_000,
    contextCache: { scope: 'request', status: 'reported', readTokens: 80_000, uncachedTokens: 10_000 },
    updatedAt: Date.UTC(2026, 7, 1, 6),
  });
  const stale = baseChat({
    sessionId: 'старая-сессия', contextTokens: 12_000, contextWindow: 400_000,
    contextMetric: 'legacy-unavailable', totalInputTokens: 12_000, cachedInputTokens: 0,
    contextCache: { scope: 'request', status: 'unavailable' },
    updatedAt: Date.UTC(2026, 7, 1, 2),
  });

  const { chat } = mergeChat(disk, stale);
  assert.equal(chat.sessionId, 'новая-сессия');
  assert.equal(chat.contextTokens, 90_000);
  assert.equal(chat.contextWindow, 258_400);
  assert.equal(chat.contextMetric, 'active-input-v1');
  assert.equal(chat.totalInputTokens, 2_000_000);
  assert.equal(chat.cachedInputTokens, 1_800_000);
  assert.deepEqual(chat.contextCache, {
    scope: 'request', status: 'reported', readTokens: 80_000, uncachedTokens: 10_000,
  });
  assert.equal(chat.updatedAt, Date.UTC(2026, 7, 1, 6));
});

test('сброс памяти агента из свежего окна проходит', () => {
  const disk = baseChat({ sessionId: 'старая-сессия', updatedAt: Date.UTC(2026, 7, 1, 2) });
  const fresh = baseChat({ sessionId: '', updatedAt: Date.UTC(2026, 7, 1, 7) });

  const { chat } = mergeChat(disk, fresh);
  assert.equal(chat.sessionId, '');
});

// ── Метки обрыва, за которыми пришёл ответ ────────────────────────────────────
// Продолжение того же инцидента: затирание истории вылечили, но метка осталась висеть
// ПЕРЕД ответом (окно записало её раньше, чем агент договорил). Ход при этом был жив.

test('метка обрыва снимается, когда ответ на неё уже пришёл', async (t) => {
  const store = await freshStore(t);
  await store.saveOne(baseChat({
    messages: [
      msg('user', 'Вопрос 1'), msg('error', 'Failed to fetch'), msg('assistant', 'Ответ 1'),
    ],
  }), false);

  const texts = (await store.read()).sessions[0].messages.map((m) => `${m.role}`);
  assert.deepEqual(texts, ['user', 'assistant']);
});

test('метка остаётся, если человеку пришлось переспросить (ход правда падал)', async (t) => {
  const store = await freshStore(t);
  await store.saveOne(baseChat({
    messages: [
      msg('user', 'Вопрос 1'), msg('error', 'HTTP 500'),
      msg('user', 'Вопрос 1'), msg('assistant', 'Ответ 1'),
    ],
  }), false);

  const roles = (await store.read()).sessions[0].messages.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'error', 'user', 'assistant']);
});

test('метка в конце ленты не трогается — ход ещё идёт', async (t) => {
  const store = await freshStore(t);
  await store.saveOne(baseChat({
    messages: [msg('user', 'Вопрос 1'), msg('error', 'Failed to fetch')],
  }), false);

  const roles = (await store.read()).sessions[0].messages.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'error']);
});

test('старое окно не возвращает снятую метку обратно', async (t) => {
  const store = await freshStore(t);
  // Сервер уже почистил ленту.
  await store.saveOne(baseChat({
    messages: [msg('user', 'Вопрос 1'), msg('error', 'Failed to fetch'), msg('assistant', 'Ответ 1')],
  }), false);
  // Окно со старым фронтом (кэш PWA) шлёт свою копию — с меткой и дописанным вопросом.
  await store.saveOne(baseChat({
    messages: [
      msg('user', 'Вопрос 1'), msg('error', 'Failed to fetch'), msg('assistant', 'Ответ 1'),
      msg('user', 'Вопрос 2'),
    ],
    updatedAt: Date.UTC(2026, 7, 1, 6),
  }), false);

  const roles = (await store.read()).sessions[0].messages.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'user']);
});

test('служебная пометка о сжатии не мешает снять метку обрыва', () => {
  const { chat } = mergeChat(
    baseChat({ messages: [msg('user', 'Вопрос 1')] }),
    baseChat({
      messages: [
        msg('user', 'Вопрос 1'), msg('error', 'Failed to fetch'),
        msg('note', '🗜 Контекст сжат'), msg('assistant', 'Ответ 1'),
      ],
      updatedAt: Date.UTC(2026, 7, 1, 5),
    }),
  );
  assert.deepEqual(chat.messages.map((m) => m.role), ['user', 'note', 'assistant']);
});

test('повторы одного текста не схлопываются', () => {
  const { messages } = mergeMessages(
    [msg('user', 'Делай'), msg('assistant', 'Готово')],
    [msg('user', 'Делай'), msg('user', 'Делай')],
  );
  assert.deepEqual(messages.map((m) => `${m.role}:${m.text}`),
    ['user:Делай', 'assistant:Готово', 'user:Делай']);
});
