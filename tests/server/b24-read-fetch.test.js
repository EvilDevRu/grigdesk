import assert from 'node:assert/strict';
import http from 'node:http';
import nodeTest, { before } from 'node:test';
import { customReadModule } from './helpers/trackerPackage.js';




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

let B24ReadOperations;
let B24Client;
let B24Adapter;
let currentB24Read;
let missing = false;

before(async () => {
  const context = {
    skip: () => {
      missing = true;
    },
  };
  const reads = await customReadModule('src/readOperations.ts', context);

  if (reads) {
    ({ B24ReadOperations, currentB24Read } = reads);
    ({ B24Client } = await customReadModule('src/client.ts', context));
    ({ CustomSession: B24Adapter } = await customReadModule('src/session.ts', context));
  }
});

/**
 * Каждый сценарий получает явный skip только при отсутствующем необязательном пакете.
 * Ошибки подготовки и непустой неверный env по-прежнему прерывают before с ошибкой.
 */
function test(name, options, run) {
  const operation = run ?? options;
  const settings = run ? options : {};

  return nodeTest(name, settings, async (t) => {
    if (missing) {
      t.skip('пакет не подготовлен');

      return;
    }

    return operation(t);
  });
}
