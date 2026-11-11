import assert from 'node:assert/strict';
import test from 'node:test';

import { readChat, sampleChat } from '../server/helpers/chat-list.js';
import { serverWorld, windowApi } from './helpers/chat-lazy.js';

test('WINDOW-ACK-READ: прочтение нового ответа переживает два stale и повтор записи', async (t) => {
  const original = sampleChat('window-ack-read', { unread: true });
  const world = await serverWorld(t, [original]);
  const network = windowApi(world.app);
  const view = await world.open(network);

  view.chat._visible = () => false;
  await view.chat.ensureChatMessages(original.id);

  const live = view.chat.session(original.id);
  const final = {
    role: 'assistant',
    text: 'Новый итог',
    pid: 'window-read-final',
    steps: [{ k: 'text', text: 'Шаг нового ответа' }],
  };

  live.messages.push(final);
  live.unread = true;

  const put = network.api.put;
  const acknowledgements = [];
  let attempts = 0;

  network.api.put = async (url, body) => {
    if (url !== '/api/chat/store/chat/window') {
      return put(url, body);
    }

    attempts += 1;

    // Первая чужая правка опережает запись нового ответа. После её ACK другое
    // приложение читает уже сохранённый ответ и опережает второй PUT метаданных.
    if (attempts <= 2) {
      const patch = attempts === 1 ? { title: 'Чужое название' } : { unread: false };
      const changed = await world.app.inject({
        method: 'PATCH',
        url: `/api/chat/store/chat/${original.id}`,
        payload: {
          patch,
          origin: 'reader',
        },
      });

      assert.equal(changed.statusCode, 200);
    }

    const response = await put(url, body);

    acknowledgements.push(response.stale);

    return response;
  };

  await view.chat._writeChat(original.id);
  assert.deepEqual(acknowledgements, [true, true]);
  assert.equal(live.unread, false, 'ACK истории обновил ключ уже сохранённого ответа');
  assert.equal((await readChat(world, original)).unread, false);

  await view.chat._writeChat(original.id);

  const saved = await readChat(world, original);

  assert.deepEqual(acknowledgements, [true, true, false]);
  assert.equal(saved.unread, false, 'повтор метаданных не возвращает чужую прочитанную точку');
  assert.equal(live.unread, false);
  assert.deepEqual(saved.messages, [...original.messages, final]);
  assert.equal(view.chat.saveError, null);
});
