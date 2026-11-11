import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { readChat, sampleChat } from '../server/helpers/chat-list.js';
import { waitFor } from '../server/helpers/chat-turns.js';
import { serverWorld, windowApi } from './helpers/chat-lazy.js';
import { chatNotifications } from './helpers/chat-store.js';

/**
 * Полностью загруженная синтетическая лента воспроизводит запись нового чата:
 * у него ещё нет historyWindow. Наличие всех сообщений проверяется до смены пути.
 */
async function fullFixture(t, id) {
  const original = sampleChat(id, { effort: '', unread: true });
  const world = await serverWorld(t, [original]);
  const network = windowApi(world.app);
  const view = await world.open(network);

  await view.chat.ensureChatMessages(original.id);

  const live = view.chat.session(original.id);

  assert.deepEqual(live.messages, original.messages);
  delete live.historyWindow;
  view.chat._visible = () => false;

  return {
    ...view,
    original,
    world,
    live,
  };
}

/** Полная запись может переиспользовать steps, сохраняя тот же контракт ACK. */
function isFullWrite(url) {
  return ['/api/chat/store/chat', '/api/chat/store/chat/step-reuse'].includes(url);
}

test('FULL-CONTENTION: семь гонок четырёх клиентов завершаются чистым состоянием', async (t) => {
  const view = await fullFixture(t, 'full-contention');
  const peers = [await view.world.open(), await view.world.open(), await view.world.open()];
  const put = view.api.put;
  const acknowledgements = [];
  const final = {
    role: 'assistant',
    text: 'Новый итог полной ленты',
    pid: 'full-new-final',
    steps: [{ k: 'text', text: 'Новый шаг' }],
  };

  view.api.put = async (url, body) => {
    if (!isFullWrite(url)) {
      return put(url, body);
    }
    if (acknowledgements.length < 7) {
      const peer = peers[acknowledgements.length % peers.length];

      peer.chat.session(view.original.id).title = `Чужая правка ${acknowledgements.length}`;
      await peer.chat._writeChat(view.original.id);
    }

    const response = await put(url, body);

    acknowledgements.push(response);

    return response;
  };
  view.live.messages.push(final);
  view.live.draft = 'Черновик полной ленты';
  view.chat.setEffort(view.original.id, 'high');

  const response = await view.chat._writeChat(view.original.id);

  assert.equal(response.stale, true);
  assert.equal(view.chat.saveError, null);
  assert.equal(view.chat._dirty(view.live), true);
  assert.deepEqual((await readChat(view.world, view.original)).messages,
    [...view.original.messages, final]);

  await waitFor(() => !view.chat._dirty(view.live), { what: 'согласование полной ленты после семи гонок' });

  const saved = await readChat(view.world, view.original);

  assert.equal(saved.effort, 'high');
  assert.equal(saved.draft, 'Черновик полной ленты');
  assert.deepEqual(saved.messages, [...view.original.messages, final]);
  assert.equal(acknowledgements.filter((ack) => ack.stale).length, 7);
  assert.equal(acknowledgements.at(-1).stale, false);
  assert.equal(chatNotifications().some((entry) => entry[2] === 'chat-save-error'), false);

  const writes = acknowledgements.length;

  view.chat._persist(true);
  await delay(400);
  assert.equal(acknowledgements.length, writes, 'после согласования лишние PUT прекращаются');
});

test('FULL-ACK-READ: повтор stale не возвращает прочитанный новым клиентом ответ', async (t) => {
  const view = await fullFixture(t, 'full-ack-read');
  const put = view.api.put;
  const acknowledgements = [];
  const final = {
    role: 'assistant',
    text: 'Прочитанный новый итог',
    pid: 'full-read-final',
    steps: [{ k: 'text', text: 'Шаг прочитанного ответа' }],
  };

  t.mock.timers.enable({ apis: ['setTimeout'] });
  view.api.put = async (url, body) => {
    if (!isFullWrite(url)) {
      return put(url, body);
    }
    if (acknowledgements.length < 2) {
      const patch = acknowledgements.length === 0 ? { title: 'Чужое название' } : { unread: false };
      const changed = await view.world.app.inject({
        method: 'PATCH',
        url: `/api/chat/store/chat/${view.original.id}`,
        payload: { patch, origin: 'reader' },
      });

      assert.equal(changed.statusCode, 200);
    }

    const response = await put(url, body);

    acknowledgements.push(response);

    return response;
  };
  view.live.messages.push(final);
  view.live.unread = true;
  await view.chat._writeChat(view.original.id);

  assert.equal(view.live.unread, false);
  assert.equal((await readChat(view.world, view.original)).unread, false);

  await view.chat._writeChat(view.original.id);

  const saved = await readChat(view.world, view.original);

  assert.equal(saved.unread, false, 'ACK нового итога не воскрешает уже прочитанный ответ');
  assert.equal(view.live.unread, false);
  assert.deepEqual(saved.messages, [...view.original.messages, final]);
  assert.deepEqual(acknowledgements.map((ack) => ack.stale), [true, true, false]);
  assert.equal(view.chat.saveError, null);
});
