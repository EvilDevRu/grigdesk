import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { openQwenPreviewGateway } from '../../server/src/lib/qwen/previewGateway.ts';
import { qwenPreviewProvider } from '../../server/src/lib/qwen/previewModels.ts';

test('Шлюз Qwen Preview пропускает закреплённое действие и закрывает редирект', async (t) => {
  const envKey = 'GRIGDESK_TEST_QWEN_PREVIEW_GATEWAY_KEY';
  const key = 'synthetic-upstream-key';
  const seen = [];
  const target = createServer((request, response) => {
    seen.push({
      url: request.url,
      auth: request.headers.authorization,
    });

    request.resume();

    if (seen.length === 1) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(307, { location: '/unapproved-destination' }).end();
    }
  });

  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  t.after(() => new Promise((resolve) => target.close(resolve)));

  const previous = process.env[envKey];

  process.env[envKey] = key;
  t.after(() => {
    if (previous === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = previous;
    }
  });

  const model = {
    id: 'fixture(openai)',
    authType: 'openai',
    entry: {
      id: 'fixture',
      baseUrl: `http://127.0.0.1:${target.address().port}/v1`,
      envKey,
    },
  };
  const gateway = await openQwenPreviewGateway({ models: [model] });

  t.after(() => gateway.close());

  const baseUrl = gateway.origin + '/' + qwenPreviewProvider(model).id;
  const route = baseUrl + '/chat/completions';
  const headers = { authorization: `Bearer ${gateway.token}` };

  assert.equal((await fetch(route, { method: 'POST' })).status, 403);
  assert.equal((await fetch(baseUrl + '/models', { method: 'POST', headers })).status, 403);
  assert.equal((await fetch(route, {
    method: 'POST',
    headers,
    body: '{"model":"foreign"}',
  })).status, 403);
  assert.deepEqual(seen, []);

  process.env[envKey] = 'rotated-after-preparation';

  const init = {
    method: 'POST',
    headers,
    body: '{"model":"fixture"}',
  };
  const completed = await fetch(route, init);

  assert.equal(completed.status, 200);
  assert.equal(await completed.text(), 'data: [DONE]\n\n');
  assert.equal((await fetch(route, init)).status, 502);
  assert.deepEqual(seen.map((request) => request.url), ['/v1/chat/completions', '/v1/chat/completions']);
  assert.ok(seen.every((request) => request.auth === `Bearer ${key}`));
});
