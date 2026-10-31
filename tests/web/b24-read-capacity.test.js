import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { api } from '../../web/src/shared/apiClient.ts';

/**
 * Два оборота event loop пропускают продолжения route/backoff и body-parser.
 * В тесте нет настоящих сроков или обращений к HTTP-серверу.
 */
async function flush() {
  await setImmediate();
  await setImmediate();
}

test('CAPACITY-01: тело портала держит одно место, метки и обычный API проходят', async (t) => {
  const calls = [];
  let body;
  let closed = false;
  const stream = new ReadableStream({
    start(controller) {
      body = controller;
    },
  });

  t.mock.method(globalThis, 'fetch', async (path) => {
    calls.push(path);

    return path === '/api/b24/capacity-held' ? new Response(stream) : new Response('{}');
  });

  const options = { timeoutMs: 0, retry: false };
  const first = api.get('/api/b24/capacity-held', options);

  await flush();

  const second = api.get('/api/b24/capacity-next', options);
  const local = api.get('/api/b24/task-favorites', options);
  const ordinary = api.get('/api/providers', options);

  try {
    await Promise.all([local, ordinary]);
    await flush();
    assert.equal(calls.includes('/api/b24/capacity-next'), false);
    assert.equal(calls.includes('/api/b24/task-favorites'), true);
    assert.equal(calls.includes('/api/providers'), true);
    body.enqueue(new TextEncoder().encode('{}'));
    body.close();
    closed = true;
    await Promise.all([first, second]);
    assert.equal(calls.includes('/api/b24/capacity-next'), true);
  } finally {
    if (!closed) {
      body.enqueue(new TextEncoder().encode('{}'));
      body.close();
    }

    await Promise.allSettled([first, second, local, ordinary]);
  }
});

test('CAPACITY-02: отмена ожидающего чтения не создаёт поздний fetch', async (t) => {
  const calls = [];
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });

  t.mock.method(globalThis, 'fetch', async (path) => {
    calls.push(path);

    return path === '/api/b24/capacity-held-cancel' ? held : new Response('{}');
  });

  const first = api.get('/api/b24/capacity-held-cancel', { timeoutMs: 0, retry: false });

  await flush();

  const consumer = new AbortController();
  const cancelled = api.get('/api/b24/capacity-abandoned', {
    timeoutMs: 0,
    retry: false,
    signal: consumer.signal,
  }).catch((error) => error);

  try {
    await flush();
    consumer.abort();
    assert.equal((await cancelled).name, 'AbortError');
    release(new Response('{}'));
    await first;
    await flush();
    assert.equal(calls.includes('/api/b24/capacity-abandoned'), false);
  } finally {
    release(new Response('{}'));
    await first;
  }
});

test('CAPACITY-03: мутация не ждёт разрешение и не повторяется', async (t) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let mutations = 0;

  t.mock.method(globalThis, 'fetch', async (_path, options) => {
    if (options.method === 'GET') {
      return held;
    }

    mutations += 1;

    throw new TypeError('fixture network failure');
  });

  const first = api.get('/api/b24/capacity-held-mutation', { timeoutMs: 0, retry: false });

  try {
    await flush();
    await assert.rejects(api.post('/api/b24/task/42/timer/start', {}), TypeError);
    assert.equal(mutations, 1);
  } finally {
    release(new Response('{}'));
    await first;
  }
});

test('CAPACITY-04: локальная полоса общая, query и отмена не создают дополнительные места', async (t) => {
  const calls = [];
  let body;
  let closed = false;
  const stream = new ReadableStream({
    start(controller) {
      body = controller;
    },
  });

  t.mock.method(globalThis, 'fetch', async (path) => {
    calls.push(path);

    return path.startsWith('/api/b24/task-favorites') ? new Response(stream) : new Response('{}');
  });

  const options = { timeoutMs: 0, retry: false };
  const first = api.get('/api/b24/task-favorites?capacity=one', options);

  await flush();

  const consumer = new AbortController();
  const abandoned = api.get('/api/b24/task-seen', {
    ...options,
    signal: consumer.signal,
  }).catch((error) => error);
  const last = api.get('/api/b24/task-shelf', options);

  try {
    await Promise.all([
      api.get('/api/b24/capacity-portal-with-local', options),
      api.get('/api/providers', options),
    ]);
    await flush();
    assert.equal(calls.includes('/api/b24/task-seen'), false);
    assert.equal(calls.includes('/api/b24/task-shelf'), false);
    consumer.abort();
    assert.equal((await abandoned).name, 'AbortError');
    body.enqueue(new TextEncoder().encode('{}'));
    body.close();
    closed = true;
    await Promise.all([first, last]);
    assert.equal(calls.includes('/api/b24/task-seen'), false);
    assert.equal(calls.includes('/api/b24/task-shelf'), true);
  } finally {
    if (!closed) {
      body.enqueue(new TextEncoder().encode('{}'));
      body.close();
    }

    consumer.abort();
    await Promise.allSettled([first, abandoned, last]);
  }
});
