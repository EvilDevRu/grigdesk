import assert from 'node:assert/strict';
import test from 'node:test';

import { api } from '../../web/src/shared/apiClient.ts';

test('full и sparse PUT фиксируют прежний JSON в Blob до ожидания ответа', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = (url, options) => new Promise((resolve) => {
    calls.push({
      url,
      options,
      finish: () => resolve(new Response('{"ok":true}')),
    });
  });

  try {
    for (const path of [
      '/api/chat/store/chat',
      '/api/chat/store/chat/step-reuse?origin=fixture',
      '/api/chat/store/chat/window',
    ]) {
      const payload = {
        chat: {
          id: 'fixture',
          messages: [{
            text: 'Ответ\n"кавычки" 🦊',
            receipt: { revision: 1 },
          }],
        },
        archived: false,
      };
      const expected = JSON.stringify(payload);
      const saving = api.put(path, payload);
      const request = calls.at(-1);

      payload.chat.messages[0].text = 'Правка во время сети';
      payload.chat.messages[0].receipt.revision = 2;

      assert.equal(request.url, path);
      assert.equal(request.options.method, 'PUT');
      assert.equal(request.options.credentials, 'include');
      assert.equal(request.options.headers['Content-Type'], 'application/json');
      assert.ok(request.options.body instanceof Blob);
      assert.equal(await request.options.body.text(), expected);
      request.finish();
      assert.deepEqual(await saving, { ok: true });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Blob не добавляет повтор мутации, а PUT метаданных сохраняет прежний транспорт', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });

    if (url === '/api/chat/store/chat') {
      throw new TypeError('Обрыв сети');
    }

    return new Response('{}');
  };

  try {
    await assert.rejects(api.put('/api/chat/store/chat', { chat: { id: 'fixture' } }), /Обрыв сети/u);
    assert.equal(calls.length, 1);
    await api.put('/api/chat/store/meta', { activeId: 'fixture' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.body, '{"activeId":"fixture"}');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
