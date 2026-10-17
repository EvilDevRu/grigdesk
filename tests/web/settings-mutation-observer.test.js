import assert from 'node:assert/strict';
import test from 'node:test';

import { api, onMutationSuccess, pendingMutations } from '../../web/src/shared/apiClient.ts';

/**
 * Подмена сети принадлежит одному тесту и всегда восстанавливается.
 * Подписчик не остаётся в singleton клиента после завершения проверки.
 */
function fixture(t) {
  const original = globalThis.fetch;
  const calls = [];
  let notifications = 0;
  const unsubscribe = onMutationSuccess(() => {
    notifications += 1;
  });

  globalThis.fetch = async (_url, options) => {
    calls.push(options);

    return new Response('{"ok":true}');
  };
  t.after(() => {
    globalThis.fetch = original;
    unsubscribe();
  });

  return { calls, count: () => notifications };
}

test('SW-M01 успех мутации объявляется один раз', async (t) => {
  const f = fixture(t);

  for (const work of [
    () => api.post('/probe'), () => api.put('/probe'), () => api.patch('/probe'),
    () => api.del('/probe'), () => api.postBytes('/probe', new Uint8Array([1])),
    () => api.postBlob('/probe', {}), () => api.download('/probe'),
    () => api.upload('/probe', new FormData()),
  ]) {
    await work();
  }

  assert.equal(f.count(), 8);
  assert.equal(f.calls.length, 8);
});

test('SW-M02 чтения и отказы молчат', async (t) => {
  const f = fixture(t);

  await api.get('/probe');
  await api.downloadGet('/probe');
  await api.getBlob('/probe');

  for (const status of [503, 401]) {
    globalThis.fetch = async () => new Response('{}', { status });
    await assert.rejects(api.post('/probe'));
  }

  globalThis.fetch = async () => {
    throw new TypeError('сеть');
  };
  await assert.rejects(api.post('/probe'));
  globalThis.fetch = async () => new Response('не JSON');
  await assert.rejects(api.post('/probe'));

  const abort = new AbortController();

  abort.abort();
  globalThis.fetch = async (_url, options) => {
    options.signal.throwIfAborted();

    return new Response('{}');
  };
  await assert.rejects(api.post('/probe', {}, { signal: abort.signal }));
  assert.equal(f.count(), 0);
  assert.equal(pendingMutations(), 0);
});

test('SW-M03 счётчик живых мутаций', async (t) => {
  fixture(t);

  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  let requests = 0;

  globalThis.fetch = (_url, options) => {
    if (options.method === 'GET') {
      return Promise.resolve(new Response('{}'));
    }

    requests += 1;

    return requests === 1 ? first.promise : second.promise;
  };

  const a = api.post('/probe');

  assert.equal(pendingMutations(), 1);

  const b = api.post('/probe');
  const rejected = assert.rejects(b);

  assert.equal(pendingMutations(), 2);
  await api.get('/probe');
  assert.equal(pendingMutations(), 2);
  first.resolve(new Response('{}'));
  await a;
  assert.equal(pendingMutations(), 1);
  second.reject(new Error('отказ'));
  await rejected;
  assert.equal(pendingMutations(), 0);
});

test('SW-M04 сломанный подписчик не меняет ответ', async (t) => {
  const f = fixture(t);
  const broken = onMutationSuccess(() => {
    throw new Error('слушатель');
  });

  t.after(broken);
  assert.deepEqual(await api.post('/probe'), { ok: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.count(), 1);
  broken();

  let calls = 0;
  const remove = onMutationSuccess(() => {
    calls += 1;
  });

  remove();
  await api.post('/probe');
  assert.equal(calls, 0);
});
