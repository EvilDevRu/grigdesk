import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { B24Client } from '../../server/src/lib/b24/client.ts';
import { B24ReadOperations } from '../../server/src/lib/b24/readOperations.ts';

/**
 * Барьер подтверждает вход в нужную фазу без ожидания случайного количества миллисекунд.
 * Он также передаёт исход чтения тела после отмены fetch.
 */
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

/**
 * Только синтетические credentials и память cookie, настоящий портал не используется.
 * Клиент сохраняет производственный raw и нативный fetch для проверки тела ответа.
 */
function clientAt(baseUrl) {
  return new B24Client({
    baseUrl,
    login: 'fixture',
    password: 'fixture',
    cookiePath: null,
  });
}

test('FETCH-01: abort чтения передан fetch и не повторяет запрос', async (t) => {
  const client = clientAt('https://portal.example.test');
  const reads = new B24ReadOperations((fn) => Promise.resolve().then(fn));
  let attempts = 0;
  let received;

  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    attempts += 1;
    received = options.signal;
    reads.invalidate();

    throw new DOMException('fixture abort', 'AbortError');
  });

  const result = await reads.read('fixture', 'task', () => client.raw('/fixture'))
    .catch((error) => error);

  assert.equal(result.name, 'AbortError');
  assert.equal(received instanceof AbortSignal, true);
  assert.equal(received.aborted, true);
  assert.equal(attempts, 1);
});

test('FETCH-02: отмена прекращает тело после уже полученных заголовков', {
  timeout: 5000,
}, async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{');
  });

  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const client = clientAt(`http://127.0.0.1:${server.address().port}`);
  const events = [];
  const reads = new B24ReadOperations((fn) => Promise.resolve().then(fn), {
    trace: (event) => events.push(event),
  });
  const bodyStarted = deferred();
  const bodyFinished = deferred();
  const consumer = new AbortController();

  t.after(() => consumer.abort());

  const reading = reads.read('fixture', 'task', async () => {
    const response = await client.raw('/fixture');

    bodyStarted.resolve();

    try {
      return await response.text();
    } catch (error) {
      bodyFinished.resolve(error.name);

      throw error;
    }
  }, consumer.signal).catch((error) => error);

  await bodyStarted.promise;
  consumer.abort();
  assert.equal((await reading).name, 'AbortError');
  assert.equal(await bodyFinished.promise, 'AbortError');
  assert.ok(events.some((event) => event.phase === 'headers' && event.status === 200));
});

test('FETCH-03: ошибка вне контекста сохраняет прежние три попытки', async (t) => {
  let attempts = 0;

  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    attempts += 1;
    assert.equal(options.signal, undefined);

    throw new TypeError('fixture network failure');
  });

  await assert.rejects(clientAt('https://portal.example.test').raw('/fixture', {
    method: 'POST',
    body: 'fixture',
  }), TypeError);
  assert.equal(attempts, 3);
});
