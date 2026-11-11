import assert from 'node:assert/strict';
import test from 'node:test';

import { readChat, sampleChat, writeChat } from '../server/helpers/chat-list.js';
import { drain } from './helpers/chat-load.js';
import { ensureMessages, serverWorld, windowApi } from './helpers/chat-lazy.js';

test('SYNC-SINGLE: одиночное событие не запускает повтор через таймер', async (t) => {
  const original = sampleChat('sync-single');
  const world = await serverWorld(t, [original]);
  const { chat, sse } = await world.open();
  const pull = t.mock.method(chat, '_pullChat', async () => {});

  t.mock.timers.enable({ apis: ['setTimeout'] });
  sse('chat-store', { id: original.id });
  await drain();
  t.mock.timers.tick(300);
  await drain();
  assert.equal(pull.mock.callCount(), 1);
});

test('SYNC-SERIAL: медленное чтение одного чата не перекрывается следующим', async (t) => {
  const original = sampleChat('sync-serial');
  const world = await serverWorld(t, [original]);
  const { chat, sse } = await world.open();
  const gate = Promise.withResolvers();
  const pull = t.mock.method(chat, '_pullChat', () => gate.promise);

  t.after(() => gate.resolve());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sse('chat-store', { id: original.id });
  sse('chat-store', { id: original.id });
  t.mock.timers.tick(300);
  await drain();
  assert.equal(pull.mock.callCount(), 1, 'второе чтение ждёт первое');
  gate.resolve();
  await drain();
  assert.equal(pull.mock.callCount(), 2, 'после первого чтения обновление не теряется');
});

test('SYNC-DELETE: отложенная шапка не воскрешает удалённый чат', async (t) => {
  const original = sampleChat('sync-delete');
  const world = await serverWorld(t, [original]);
  const { chat, sse } = await world.open();
  const { head } = (await world.app.inject(`/api/chat/store/head/${original.id}`)).json();

  t.mock.timers.enable({ apis: ['setTimeout'] });
  sse('chat-store', { id: original.id, head });
  sse('chat-store', { id: original.id, head });
  sse('chat-store', { id: original.id, gone: true });
  t.mock.timers.tick(300);
  await drain();
  assert.equal(chat._find(original.id), null);
});

test('SYNC-HEADLESS: событие без шапки требует сверки после события с шапкой', async (t) => {
  const original = sampleChat('sync-headless');
  const world = await serverWorld(t, [original]);
  const { chat, sse } = await world.open();
  const { head } = (await world.app.inject(`/api/chat/store/head/${original.id}`)).json();
  const pull = t.mock.method(chat, '_pullChat', async () => {});

  t.mock.timers.enable({ apis: ['setTimeout'] });
  sse('chat-store', { id: original.id, head });
  await drain();
  sse('chat-store', { id: original.id });
  t.mock.timers.tick(300);
  await drain();
  assert.equal(pull.mock.calls[1].arguments[2], undefined, 'старая шапка не заменяет новую сверку');
});

test('SYNC-LOCAL-DELETE: своё удаление тоже отменяет очередь чужих событий', async (t) => {
  const original = sampleChat('sync-local-delete', { archived: true });
  const world = await serverWorld(t, [original]);
  const { chat, sse } = await world.open();

  await chat.ensureChatPage('', true);

  const { head } = (await world.app.inject(`/api/chat/store/head/${original.id}`)).json();

  const event = {
    id: original.id,
    archived: true,
    head,
  };

  t.mock.timers.enable({ apis: ['setTimeout'] });
  sse('chat-store', event);
  sse('chat-store', event);
  assert.equal(chat.deleteChat(original.id), 'deleted');
  t.mock.timers.tick(300);
  await drain();
  assert.equal(chat._find(original.id), null);
});

for (const action of ['delete', 'dispose']) {
  test(`SYNC-LATE-HEAD: ${action} отменяет задержанный ответ скрытой ленты`, async (t) => {
    const original = sampleChat(`sync-late-${action}`);
    const world = await serverWorld(t, [original]);
    const network = windowApi(world.app);
    const { chat } = await world.open(network);

    await ensureMessages(chat, original.id);
    chat._visible = () => false;

    const get = network.api.get;
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const applyHead = t.mock.method(chat, '_applyChatHead');

    t.after(() => gate.resolve());
    network.api.get = async (url) => {
      const result = await get(url);

      if (url.includes('/store/head/')) {
        entered.resolve();
        await gate.promise;
      }

      return result;
    };

    const loading = chat._pullChat(original.id);

    await entered.promise;

    if (action === 'delete') {
      chat._dropRemoteChat(original.id);
    } else {
      chat.$dispose();
    }

    gate.resolve();
    await loading;
    assert.equal(applyHead.mock.callCount(), 0, 'поздняя шапка не применяется');

    if (action === 'delete') {
      assert.equal(chat._find(original.id), null);
    } else {
      assert.equal(chat._find(original.id).messages.length, original.messages.length);
    }
  });
}

test('SYNC-HIDDEN: загруженная скрытая лента принимает шапку без GET', async (t) => {
  const original = sampleChat('sync-hidden');
  const world = await serverWorld(t, [original]);
  const { chat, calls } = await world.open();

  await ensureMessages(chat, original.id);
  chat._visible = () => false;
  await writeChat(world, { ...original, title: 'Чужое название' });

  const { head } = (await world.app.inject(`/api/chat/store/head/${original.id}`)).json();
  const before = calls.length;

  await chat._pullChat(original.id, false, head);
  assert.equal(chat._find(original.id).historyWindow.stale, true);
  assert.equal(calls.slice(before).filter((call) => call.method === 'GET').length, 0);
});

test('SYNC-VISIBLE: новый unread в шапке не превращает чистую ленту в местную правку', async (t) => {
  const original = sampleChat('sync-visible', { unread: false });
  const world = await serverWorld(t, [original]);
  const { chat } = await world.open();

  await ensureMessages(chat, original.id);
  chat._visible = () => true;

  const before = await readChat(world, original);

  await writeChat(world, {
    ...before,
    revision: before.revision + 1,
    unread: true,
    messages: [...before.messages, {
      role: 'assistant',
      text: 'Свежий ответ',
      pid: 'sync-new-final',
    }],
  });

  const { head } = (await world.app.inject(`/api/chat/store/head/${original.id}`)).json();

  await chat._pullChat(original.id, false, head);
  assert.equal(chat._find(original.id).messages.at(-1).pid, 'sync-new-final');
  assert.equal(chat.hasNewerMessages(original.id), false, 'чистое окно внизу принимает новый хвост');
});
