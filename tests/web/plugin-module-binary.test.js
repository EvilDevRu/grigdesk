import assert from 'node:assert/strict';
import test from 'node:test';

import { descriptor } from './helpers/pluginModuleContract.js';
import { serviceFixture } from './helpers/pluginModuleServices.js';

/**
 * Настоящий context использует общий transport, подменяется только fetch.
 * Multipart и двоичные ответы не проходят через JSON-обёртку плагина.
 */
async function binaryFixture(t) {
  const f = await serviceFixture(t, 'pluginRuntime/context.ts', {
    transport: 'shared/apiClient.ts',
  });
  const controller = new AbortController();
  const context = await f.createPluginContext('ui-module', { ...descriptor, locales: {} }, {
    byId: () => ({ values: {} }),
  }, { signal: controller.signal });

  t.after(() => controller.abort());

  return {
    ...f,
    context,
    controller,
  };
}

test('PM-BINARY: multipart порядок/boundary, Blob MIME и postBytes headers', async (t) => {
  const f = await binaryFixture(t);
  const calls = [];

  assert.equal(typeof f.context.api.upload, 'function');
  assert.equal(typeof f.context.api.getBlob, 'function');
  assert.equal(typeof f.context.api.postBytes, 'function');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });

    return (options.method ?? 'GET') === 'GET'
      ? new Response(new Uint8Array([0, 1, 254, 255]), { headers: { 'Content-Type': 'model/gltf-binary' } })
      : new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  });

  const form = new FormData();

  form.append('libraryId', 'library');
  form.append('file', new Blob(['GLB'], { type: 'model/gltf-binary' }), 'fixture.glb');
  await f.context.api.upload('/api/ext/ui-module/upload', form, { signal: f.controller.signal });
  assert.equal(calls[0].options.body, form);
  assert.deepEqual([...form.keys()], ['libraryId', 'file']);
  assert.equal(new Headers(calls[0].options.headers).has('Content-Type'), false);
  assert.equal(calls[0].options.signal, f.controller.signal);

  const blob = await f.context.api.getBlob('/api/ext/ui-module/file');

  assert.equal(blob.type, 'model/gltf-binary');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0, 1, 254, 255]);
  await f.context.api.postBytes('/api/ext/ui-module/preview', new Uint8Array([1, 2]), {
    headers: { 'Content-Type': 'image/png' },
  });
  assert.equal(new Headers(calls[2].options.headers).get('Content-Type'), 'image/png');
});

test('PM-BINARY: общий 401, abort загрузки и отказ адресов вне /api', async (t) => {
  const f = await binaryFixture(t);
  let unauthorized = 0;
  let requests = 0;
  const off = f.transport.api.onUnauthorized(() => unauthorized += 1);

  t.after(off);
  assert.equal(typeof f.context.api.upload, 'function');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests += 1;
    options.signal?.throwIfAborted();

    return new Response('{"error":"unauthorized"}', {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  await assert.rejects(f.context.api.getBlob('/api/ext/ui-module/file'), { status: 401 });
  assert.equal(unauthorized, 1);
  f.controller.abort();
  await assert.rejects(f.context.api.upload('/api/ext/ui-module/upload', new FormData(), {
    signal: f.controller.signal,
  }), { name: 'AbortError' });

  const before = requests;

  for (const invalid of ['/outside', 'https://evil.test/api/file', '//host/api/file']) {
    for (const invoke of [
      () => f.context.api.getBlob(invalid),
      () => f.context.api.upload(invalid, new FormData()),
      () => f.context.api.postBytes(invalid, new Uint8Array()),
    ]) {
      await assert.rejects(async () => invoke(), /invalid-api-path/);
    }
  }

  assert.equal(requests, before);
});
