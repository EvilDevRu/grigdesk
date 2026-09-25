import assert from 'node:assert/strict';
import { test } from 'node:test';

import { api, isReportedApiError, setApiLogSink } from '../../web/src/shared/apiClient.ts';

// Шаблоном путь делает runtime журнала; sink получает путь без query и hash,
// без тела запроса и без текста ответа.
test('API sink видит отказ без query и содержимого; downloadGet делает GET', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const events = [];
  setApiLogSink((ev, data) => events.push({ ev, data }));
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options?.method || 'GET' });
    if (String(url).includes('/api/web-log/download')) {
      return new Response('line\n', { status: 200,
        headers: { 'Content-Disposition': 'attachment; filename="web-log.ndjson"' } });
    }
    return new Response(JSON.stringify({ message: 'secret-token' }), { status: 503 });
  };
  try {
    await assert.rejects(api.post('/api/projects/private?token=abc', { private: 'body' }));
    const file = await api.downloadGet('/api/web-log/download?day=2026-09-23');
    assert.equal(calls.at(-1).method, 'GET');
    assert.equal(file.filename, 'web-log.ndjson');
    assert.equal(await file.blob.text(), 'line\n');
    assert.equal(events[0].ev, 'api.fail');
    assert.equal(events[0].data.path, '/api/projects/private');
    assert.equal(events[0].data.status, 503);
    assert.doesNotMatch(JSON.stringify(events), /secret-token|token=abc|body/u);
  } finally {
    globalThis.fetch = originalFetch;
    setApiLogSink(null);
  }
});

test('API sink охватывает двоичные методы и upload без содержимого тела', async () => {
  const originalFetch = globalThis.fetch;
  const events = [];
  const methods = [];
  setApiLogSink((ev, data) => events.push({ ev, data }));
  globalThis.fetch = async (_url, options) => {
    methods.push(options?.method || 'GET');
    return new Response(JSON.stringify({ message: 'secret-response' }), { status: 503 });
  };
  try {
    const form = new FormData();
    form.append('file', 'secret-form');
    await assert.rejects(api.upload('/api/files/private', form));
    await assert.rejects(api.download('/api/files/private'));
    await assert.rejects(api.getBlob('/api/files/private'));
    await assert.rejects(api.postBlob('/api/files/private', { token: 'secret-body' }));
    await assert.rejects(api.postBytes('/api/files/private', new Uint8Array([1, 2, 3])));

    assert.deepEqual(methods, ['POST', 'POST', 'GET', 'POST', 'POST']);
    assert.equal(events.length, 5);
    assert.ok(events.every((event) => event.ev === 'api.fail'
      && event.data.path === '/api/files/private' && event.data.attempt === 1));
    assert.doesNotMatch(JSON.stringify(events), /secret|token/u);
  } finally {
    globalThis.fetch = originalFetch;
    setApiLogSink(null);
  }
});

test('повтор GET фиксирует неудачную попытку с willRetry', async () => {
  const originalFetch = globalThis.fetch;
  const events = [];
  let calls = 0;
  setApiLogSink((ev, data) => events.push({ ev, data }));
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('secret-network-detail');
    return new Response('{"ok":true}', { status: 200 });
  };
  try {
    assert.deepEqual(await api.get('/api/tasks'), { ok: true });
    assert.equal(calls, 2);
    assert.deepEqual(events.map(({ ev, data }) => [ev, data.attempt, data.willRetry]),
      [['api.fail', 1, true]]);
    assert.doesNotMatch(JSON.stringify(events), /secret-network-detail/u);
  } finally {
    globalThis.fetch = originalFetch;
    setApiLogSink(null);
  }
});

test('ошибка, записанная как api.fail, помечена для store.error', async () => {
  const originalFetch = globalThis.fetch;
  setApiLogSink(() => {});
  globalThis.fetch = async () => new Response('{}', { status: 502 });
  try {
    const error = await api.get('/api/tasks').catch((reason) => reason);
    assert.equal(error.status, 502);
    assert.equal(isReportedApiError(error), true);
    assert.equal(isReportedApiError(new Error('чужая')), false);
    assert.equal(isReportedApiError('строка'), false);
  } finally {
    globalThis.fetch = originalFetch;
    setApiLogSink(null);
  }
});
