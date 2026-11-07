import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { probeGrigDesk } from '../../shared/runtime/grigDeskReadiness.ts';

const body = {
  configured: true,
  authenticated: false,
};
const origin = 'http://127.0.0.1:12345';

function fake(reply: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(reply), { status });
}

/**
 * HTTP-фикстура занимает свой свободный порт и закрывает все принятые сокеты.
 * Даже зависший ответ не удерживает процесс теста после завершения проверки.
 */
async function listen(t: TestContext, server: Server): Promise<string> {
  const sockets = new Set<Socket>();

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const address = server.address();

  assert.ok(address && typeof address === 'object');

  return `http://127.0.0.1:${address.port}`;
}

test('CR-1 ответ по схеме и параметры GET', async () => {
  /**
   * Подмена проверяет контракт каждого параметра до возврата валидного ответа.
   * Готовность не должна достигаться при неверном URL или отменённом сигнале.
   */
  const fetchImpl: typeof fetch = async (url, options) => {
    assert.equal(url, origin + '/api/auth/state');
    assert.equal(options?.method, 'GET');
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);

    return new Response(JSON.stringify(body));
  };

  assert.equal(await probeGrigDesk(origin, { fetchImpl }), 'grigdesk');
});

test('CR-2 чужой ответ и неразбираемый JSON', async () => {
  for (const status of [500, 302]) {
    assert.equal(await probeGrigDesk(origin, { fetchImpl: fake(body, status) }), 'other');
  }

  for (const reply of [{}, [], null, { configured: 'true' }, { configured: true }]) {
    assert.equal(await probeGrigDesk(origin, { fetchImpl: fake(reply) }), 'other');
  }

  const fetchImpl: typeof fetch = async () => new Response('<html>');

  assert.equal(await probeGrigDesk(origin, { fetchImpl }), 'other');
});

test('CR-3 закрытый свободный порт', async (t) => {
  const server = createServer();
  const url = await listen(t, server);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(await probeGrigDesk(url), 'refused');
});

test('CR-4 зависший сервер получает таймаут', async (t) => {
  const url = await listen(t, createServer(() => {}));

  assert.equal(await probeGrigDesk(url, { timeoutMs: 200 }), 'no_answer');
});

test('CR-5 уже отменённый запрос не вызывает fetch', async () => {
  const signal = AbortSignal.abort();
  const fetchImpl: typeof fetch = async () => {
    assert.fail('fetch после отмены');
  };

  assert.equal(await probeGrigDesk(origin, {
    signal,
    fetchImpl,
  }), 'no_answer');
});

test('CR-5 отмена при чтении JSON исключает позднюю готовность', async () => {
  const controller = new AbortController();
  let reading = false;
  const response = new Response();

  response.json = async () => {
      reading = true;
      controller.abort();

    return body;
  };

  const fetchImpl: typeof fetch = async () => response;

  assert.equal(await probeGrigDesk(origin, {
    signal: controller.signal,
    fetchImpl,
  }), 'no_answer');
  assert.equal(reading, true);
});

test('CR-6 настоящий HTTP', async (t) => {
  const url = await listen(t, createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(body));
  }));

  assert.equal(await probeGrigDesk(url), 'grigdesk');
});

test('CR-2 сетевой отказ без ECONNREFUSED не подтверждает чужой сервер', async () => {
  for (const error of [null, 'отказ', new Error('сеть'), { cause: null }]) {
    const fetchImpl: typeof fetch = async () => {
      throw error;
    };

    assert.equal(await probeGrigDesk(origin, { fetchImpl }), 'no_answer');
  }
});
