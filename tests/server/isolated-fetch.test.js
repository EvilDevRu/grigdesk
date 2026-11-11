import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

import { isolatedFetch } from '../../server/src/lib/isolatedFetch.ts';
import { createPluginCore } from '../../server/src/modules/plugins/core.ts';

/**
 * Настоящий HTTP-сервер позволяет проверить завершение дочернего процесса по закрытию TCP.
 * Фикстура закрывает все соединения даже при падении проверки.
 */
async function fixture(t, handler) {
  const server = http.createServer(handler);

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  return `http://127.0.0.1:${server.address().port}`;
}

test('изоляция от основного fetch; ключ и POST сохраняются', async (t) => {
  const url = await fixture(t, async (request, response) => {
    const chunks = [];

    for await (const chunk of request) {
      chunks.push(chunk);
    }

    assert.equal(request.headers.authorization, 'synthetic-key');
    assert.equal(request.method, 'POST');
    response.writeHead(201, { 'content-type': 'application/json', 'retry-after': '12' });
    response.end(JSON.stringify({ body: Buffer.concat(chunks).toString() }));
  });
  const original = globalThis.fetch;

  globalThis.fetch = () => {
    throw new Error('Основной fetch сломан');
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const response = await isolatedFetch(url, {
    method: 'POST',
    headers: { authorization: 'synthetic-key' },
    body: 'данные',
  });

  assert.equal(response.status, 201);
  assert.equal(response.headers.get('retry-after'), '12');
  assert.deepEqual(await response.json(), { body: 'данные' });
  assert.equal(createPluginCore({}, 'fixture').fetch, isolatedFetch);
});

test('отмена зависшего ответа закрывает процесс и сокет; следующий запрос работает', async (t) => {
  const controller = new AbortController();
  let closed;
  const disconnected = new Promise((resolve) => {
    closed = resolve;
  });
  const url = await fixture(t, (request, response) => {
    if (request.url === '/hang') {
      request.socket.once('close', closed);
      response.writeHead(200);
      response.write('незаконченное тело');
      controller.abort();
    } else {
      response.end('восстановлено');
    }
  });

  await assert.rejects(isolatedFetch(`${url}/hang`, { signal: controller.signal }), { name: 'AbortError' });
  await disconnected;
  assert.equal(await (await isolatedFetch(url)).text(), 'восстановлено');
});

test('жёсткий срок завершает запрос без пользовательского signal', { timeout: 20_000 }, async (t) => {
  let closed;
  const disconnected = new Promise((resolve) => {
    closed = resolve;
  });
  const url = await fixture(t, (request) => {
    request.socket.once('close', closed);
  });

  await assert.rejects(isolatedFetch(url), { name: 'TimeoutError' });
  await disconnected;
});

test('предел распакованного тела и запрет перенаправлений сохраняются', async (t) => {
  let targetCalls = 0;
  const url = await fixture(t, (request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/target' });
      response.end();
    } else if (request.url === '/target') {
      targetCalls += 1;
      response.end('unexpected');
    } else {
      response.writeHead(200, { 'content-encoding': 'gzip' });
      response.end(gzipSync(Buffer.alloc(2 * 1024 * 1024 + 1)));
    }
  });

  await assert.rejects(isolatedFetch(`${url}/redirect`, { redirect: 'error' }));
  assert.equal(targetCalls, 0);
  await assert.rejects(isolatedFetch(url), (error) => error.cause?.code === 'response_too_large');
});

test('заранее отменённый запрос и потоковый ввод не запускают сеть', async () => {
  await assert.rejects(isolatedFetch('http://127.0.0.1:1', { signal: AbortSignal.abort() }), {
    name: 'AbortError',
  });
  await assert.rejects(isolatedFetch('http://127.0.0.1:1', { body: new Uint8Array(1) }), TypeError);
});
