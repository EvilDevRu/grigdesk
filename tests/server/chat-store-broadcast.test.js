// Изменение чата должно разъезжаться по окнам вместе со свежей шапкой: получателю
// не нужен отдельный GET head, чтобы поправить строку списка или метку. Проверяем
// оба пути записи шапки — полный PUT старого клиента и точечный PATCH метаданных.
import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import chatModule from '../../server/src/modules/chat/index.ts';
import { ChatHistoryStore } from '../../server/src/lib/chat/historyStore.ts';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

/**
 * Поднимает изолированный HTTP-модуль и освобождает его таймеры перед файлами.
 * События записываются в момент рассылки, чтобы проверить порядок относительно ACK.
 */
async function chatModuleApp(t, events) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-chat-broadcast-'));
  const app = Fastify({ logger: false });

  t.after(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  app.decorate('sse', {
    broadcast(event, data) {
      events.push({ event, data });
    },
  });
  await app.register(chatModule, {
    config: {
      chatsDir: path.join(root, 'chats'),
      chatStoreLegacyPath: path.join(root, 'legacy.json'),
      chatBindingsDir: path.join(root, 'bindings'),
      rootDir: root,
      factoryHome: root,
      port: 18140,
    },
  });
  await app.ready();

  return app;
}

test('BROADCAST-HEAD: PUT и PATCH шлют chat-store со свежей шапкой', async (t) => {
  const events = [];
  const app = await chatModuleApp(t, events);
  const chat = {
    id: 'chat-b1',
    title: 'Речь',
    messages: [{ role: 'user', text: 'Вопрос' }],
    createdAt: 1,
    updatedAt: 2,
  };

  const put = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: { chat },
  });

  assert.equal(put.statusCode, 200, put.body);

  const stored = events.filter((entry) => entry.event === 'chat-store');

  assert.equal(stored.length, 1, 'запись нового чата рассылается один раз');
  assert.equal(stored[0].data.id, 'chat-b1');
  assert.equal(stored[0].data.head?.id, 'chat-b1', 'событие несёт шапку изменённого чата');
  assert.equal(stored[0].data.head?.title, 'Речь');

  events.length = 0;

  const patch = await app.inject({
    method: 'PATCH',
    url: '/api/chat/store/chat/chat-b1',
    payload: { patch: { title: 'Новое имя' }, origin: 'win-1' },
  });

  assert.equal(patch.statusCode, 200, patch.body);

  const patched = events.find((entry) => entry.event === 'chat-store');

  assert.ok(patched, 'PATCH шапки рассылает событие');
  assert.equal(patched.data.origin, 'win-1');
  assert.equal(patched.data.head?.title, 'Новое имя', 'шапка в событии уже содержит правку');
});

test('BROADCAST-POINT: запись и рассылка не зависят от обхода общего каталога', async (t) => {
  const events = [];
  const app = await chatModuleApp(t, events);

  await app.inject('/api/chat/store/list');
  t.mock.method(ChatHistoryStore.prototype, 'webHeads', async () => {
    throw new Error('Общий каталог занят');
  });

  const response = await app.inject({
    method: 'PUT',
    url: '/api/chat/store/chat',
    payload: { chat: {
      id: 'point-broadcast',
      title: 'Адресная запись',
      messages: [],
      createdAt: 1,
    } },
  });
  const event = events.find((entry) => entry.event === 'chat-store');

  assert.equal(response.statusCode, 200);
  assert.equal(event?.data.head?.title, 'Адресная запись');
});

for (const [firstOrigin, secondOrigin, expectedOrigin] of [
  ['window-a', 'window-b', ''],
  ['window-a', 'window-a', 'window-a'],
  ['', 'window-b', ''],
]) {
  test(`BROADCAST-ORIGIN: объединение ${firstOrigin || 'server'} → ${secondOrigin}`, async (t) => {
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const events = [];

    t.after(() => gate.resolve());

    const app = await chatModuleApp(t, events);
    const id = 'broadcast-origin';

    await app.inject({
      method: 'PUT',
      url: '/api/chat/store/chat',
      payload: { chat: {
        id,
        title: 'Прежнее название',
        unread: true,
        messages: [],
        createdAt: 1,
      } },
    });
    events.length = 0;

    const readEntry = ChatHistoryStore.prototype.readEntry;
    const patchExecution = ChatHistoryStore.prototype.patchExecution;
    let written = false;
    let held = false;

    t.mock.method(ChatHistoryStore.prototype, 'patchExecution', async function (...args) {
      const saved = await patchExecution.apply(this, args);

      written = true;

      return saved;
    });
    t.mock.method(ChatHistoryStore.prototype, 'readEntry', async function (chatId) {
      const hold = written && !held && chatId === id;

      if (hold) {
        held = true;
      }

      const entry = await readEntry.call(this, chatId);

      if (hold) {
        entered.resolve();
        await gate.promise;
      }

      return entry;
    });

    const first = app.inject({
      method: 'PATCH',
      url: `/api/chat/store/chat/${id}`,
      payload: { patch: { title: 'Название из первого окна' }, origin: firstOrigin },
    });

    await entered.promise;

    const second = await app.inject({
      method: 'PATCH',
      url: `/api/chat/store/chat/${id}`,
      payload: { patch: { unread: false }, origin: secondOrigin },
    });

    gate.resolve();
    assert.equal((await first).statusCode, 200);
    assert.equal(second.statusCode, 200);

    const changed = events.filter((entry) => entry.event === 'chat-store');

    assert.equal(changed.length, 1, 'поздняя первая шапка отменена');
    assert.equal(changed[0].data.head.title, 'Название из первого окна');
    assert.equal(changed[0].data.head.unread, false);
    assert.equal(changed[0].data.origin, expectedOrigin,
      'чужую правку нельзя спрятать под origin последнего писателя');
  });
}
