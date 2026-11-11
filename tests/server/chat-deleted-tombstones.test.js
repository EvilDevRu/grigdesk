// Удалённый чат не воскресает из страховочной копии другого устройства:
// удаление оставляет памятку в chats/deleted.json, и saveOne для отсутствующего
// файла отвергается вместо молчаливого создания нового.
import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';

const DAY = 24 * 60 * 60 * 1000;

const msg = (role, text) => ({ role, text });

async function freshDir(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-chat-deleted-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, 'chats');
}

const chatOf = (id, over = {}) => ({
  id,
  title: `Разговор ${id}`,
  messages: [msg('user', 'Вопрос'), msg('assistant', 'Ответ')],
  createdAt: Date.UTC(2026, 9, 1, 1),
  updatedAt: Date.UTC(2026, 9, 1, 2),
  ...over,
});

test('удалённый чат не воссоздаётся страховочной копией другого окна', async (t) => {
  const dir = await freshDir(t);
  const store = new ChatHistoryStore({ chatsDir: dir });
  const chat = chatOf('deleted-1');

  await store.saveOne(chat, false);
  assert.equal(await store.remove('deleted-1'), true);

  // Телефон проснулся и прислал свою копию удалённого разговора с force.
  await assert.rejects(
    () => store.saveOne(chat, false),
    (error) => error.code === 'chat_deleted' && error.statusCode === 409,
  );

  const state = await store.read();
  assert.equal(state.sessions.length, 0, 'файл чата не воссоздан');
});

test('памятка переживает рестарт процесса хранилища', async (t) => {
  const dir = await freshDir(t);
  const first = new ChatHistoryStore({ chatsDir: dir });

  await first.saveOne(chatOf('deleted-restart'), false);
  await first.remove('deleted-restart');

  // Новый экземпляр читает тот же каталог: окно телефона может опоздать на дни.
  const second = new ChatHistoryStore({ chatsDir: dir });

  await assert.rejects(() => second.saveOne(chatOf('deleted-restart'), false),
    (error) => error.code === 'chat_deleted');

  const raw = JSON.parse(await fs.readFile(path.join(dir, 'deleted.json'), 'utf8'));
  assert.equal(raw.deleted.length, 1);
  assert.equal(raw.deleted[0].id, 'deleted-restart');
});

test('точечный PUT и полный PUT стора одинаково отвергаются', async (t) => {
  const dir = await freshDir(t);
  const store = new ChatHistoryStore({ chatsDir: dir });

  await store.saveOne(chatOf('deleted-put'), false);
  await store.remove('deleted-put');

  // Окно пришло с proof-of-base: для отсутствующего файла это всё равно создание.
  const windowed = chatOf('deleted-put', {
    messages: [msg('user', 'Вопрос')],
    historyWindow: { offset: 0 },
  });

  await assert.rejects(
    () => store.saveOne(windowed, false, {
      window: { offset: 0, end: 1, total: 2, prefixHash: '0'.repeat(64), baseEnd: 0, baseHash: '0'.repeat(64) },
    }),
    (error) => error.code === 'chat_deleted',
  );

  await assert.rejects(
    () => store.save({ sessions: [chatOf('deleted-put')] }, { preserveMissing: true }),
    (error) => error.code === 'chat_deleted',
  );

  assert.equal((await store.scan()).size, 0);
});

test('повторное удаление отсутствующего чата не оставляет памятку', async (t) => {
  const dir = await freshDir(t);
  const store = new ChatHistoryStore({ chatsDir: dir });

  assert.equal(await store.remove('never-existed'), false);

  // Чата никогда не было — новый чат с таким id записывается как обычно.
  await store.saveOne(chatOf('never-existed'), false);
  const state = await store.read();
  assert.equal(state.sessions.length, 1);
});

test('памятки старше срока забываются при следующем удалении', async (t) => {
  const dir = await freshDir(t);
  const start = Date.UTC(2026, 9, 1);
  let clock = start;
  const store = new ChatHistoryStore({ chatsDir: dir, now: () => clock });

  await store.saveOne(chatOf('old-chat'), false);
  await store.remove('old-chat');

  // Через 91 день человек удаляет другой чат: старая памятка выходит за срок.
  clock = start + 91 * DAY;
  await store.saveOne(chatOf('fresh-chat'), false);
  await store.remove('fresh-chat');

  const raw = JSON.parse(await fs.readFile(path.join(dir, 'deleted.json'), 'utf8'));
  assert.deepEqual(raw.deleted.map((entry) => entry.id), ['fresh-chat']);

  // Забытая памятка больше не блокирует создание: очень старое удаление
  // не держит каталог навсегда (документированный крайний случай).
  await store.saveOne(chatOf('old-chat'), false);
  assert.equal((await store.scan()).size, 1, 'только воссозданный старый чат');
});

test('companion после удаления создаётся заново с новым id', async (t) => {
  const dir = await freshDir(t);
  const store = new ChatHistoryStore({ chatsDir: dir });

  const first = await store.ensureByPurpose({ purpose: 'companion', taskId: '123' });
  assert.equal(first.created, true);

  assert.equal(await store.remove(first.chat.id), true);

  // Повторная запись удалённого companion-объекта с identity-полями остаётся
  // за identity gate: контрактный отказ chat_identity_rebind важнее памятки.
  await assert.rejects(
    () => store.saveOne(first.chat),
    (error) => error.code === 'chat_identity_rebind',
  );

  const second = await store.ensureByPurpose({ purpose: 'companion', taskId: '123' });
  assert.equal(second.created, true);
  assert.notEqual(second.chat.id, first.chat.id);
});
