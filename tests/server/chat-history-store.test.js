import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChatHistoryStore } from '../../server/src/lib/chat/history-store.js';

test('chat history moves from active to archive before permanent removal', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-chat-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const store = new ChatHistoryStore({ chatsDir: path.join(root, 'chats') });
  const chat = {
    id: 'chat-1',
    title: 'Важный разговор',
    messages: [{ role: 'user', text: 'Не потеряй меня' }],
    draft: 'черновик',
    unread: true,
    createdAt: Date.UTC(2026, 6, 29),
    updatedAt: Date.UTC(2026, 6, 29, 1),
  };

  await store.saveOne(chat, false);
  let state = await store.read();
  assert.deepEqual(state.sessions.map((item) => item.id), ['chat-1']);
  assert.equal(state.archived.length, 0);

  await store.saveOne({ ...chat, closedAt: Date.UTC(2026, 6, 29, 2) }, true);
  state = await store.read();
  assert.equal(state.sessions.length, 0);
  assert.deepEqual(state.archived.map((item) => item.id), ['chat-1']);
  assert.equal(state.archived[0].draft, 'черновик');
  assert.equal(state.archived[0].unread, true);

  await store.saveOne(chat, false);
  state = await store.read();
  assert.deepEqual(state.sessions.map((item) => item.id), ['chat-1']);
  assert.equal(state.archived.length, 0);
  assert.equal(state.sessions[0].draft, 'черновик');
  assert.equal(state.sessions[0].unread, true);

  await store.saveOne({ ...chat, closedAt: Date.UTC(2026, 6, 29, 3) }, true);
  assert.equal(await store.remove('chat-1'), true);
  state = await store.read();
  assert.equal(state.sessions.length, 0);
  assert.equal(state.archived.length, 0);
});
