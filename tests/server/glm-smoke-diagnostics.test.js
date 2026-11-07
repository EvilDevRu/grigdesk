import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  cleanGlmSmokeDiagnostic,
  glmSmokeSecrets,
  installGlmSmokeHttpObserver,
  readGlmSmokeHttpErrors,
  writeGlmSmokeHttpObserver,
} from '../../server/scripts/glmSmokeDiagnostics.mts';
import { startGlmLoopback } from '../helpers/glmLoopback.mts';
import { writeGlmEgressGuard } from '../helpers/glmEgressGuard.mts';

const KEY = 'synthetic-smoke-http-secret';

test('служебный флаг TOKEN не искажает 1113, а оба ключа режима скрываются', () => {
  const secrets = glmSmokeSecrets({
    TOKEN_ENABLED: '1',
    ZAI_API_KEY: KEY,
    ZAI_CODING_API_KEY: 'coding-test-key',
  });
  const text = cleanGlmSmokeDiagnostic(`1113 ${KEY} coding-test-key`, secrets, []);

  assert.equal(text, '1113 <secret> <secret>');

  const personal = cleanGlmSmokeDiagnostic(
    '{"phone":1234567890,"customerId":"private-account","error":{"code":"1113"}}', [], [],
  );

  assert.deepEqual(JSON.parse(personal), {
    phone: '<private>',
    customerId: '<private>',
    error: { code: '1113' },
  });
});

test('живой наблюдатель видит оба маршрута Z.ai без изменения адреса и посторонних запросов', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-http-routes-'));
  const file = path.join(root, 'errors.jsonl');
  const original = globalThis.fetch;
  const urls = [];

  await fs.writeFile(file, '', { mode: 0o600 });
  globalThis.fetch = async (input) => {
    urls.push(String(input));

    return new Response('{"error":{"code":"1113"}}', { status: 429 });
  };
  t.after(async () => {
    globalThis.fetch = original;
    await fs.rm(root, { recursive: true, force: true });
  });

  installGlmSmokeHttpObserver({ file, roots: [root] });

  const routes = [
    'https://api.z.ai/api/paas/v4/chat/completions',
    'https://api.z.ai/api/coding/paas/v4/chat/completions',
    'https://example.invalid/chat/completions',
  ];

  for (const url of routes) {
    assert.equal((await fetch(url)).status, 429);
  }

  assert.deepEqual(urls, routes);
  assert.equal((await readGlmSmokeHttpErrors(file, {}, root)).length, 2);
});

test('наблюдатель сохраняет полный HTTP-отказ без секретов и не меняет успешный SSE', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-http-observer-'));
  const previousKey = process.env.GRIGDESK_GLM_ROUTE_KEY;
  const originalFetch = globalThis.fetch;
  const message = `${KEY} user@example.test ${root} ${'длинный текст '.repeat(1500)} конец-ошибки`;
  const mock = await startGlmLoopback({
    expectedKey: KEY,
    scenarios: [
      {
        kind: 'http-error',
        status: 429,
        code: '1113',
        message,
      },
      { kind: 'stream', deltas: [{ role: 'assistant', content: 'ответ-модели' }] },
    ],
  });

  process.env.GRIGDESK_GLM_ROUTE_KEY = KEY;
  t.after(async () => {
    globalThis.fetch = originalFetch;

    if (previousKey === undefined) {
      delete process.env.GRIGDESK_GLM_ROUTE_KEY;
    } else {
      process.env.GRIGDESK_GLM_ROUTE_KEY = previousKey;
    }

    await mock.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  const observer = await writeGlmSmokeHttpObserver(root, mock.endpoint, await writeGlmEgressGuard(root));
  const plugin = await import(pathToFileURL(observer.plugin).href);

  await plugin.apply();
  await assert.rejects(fetch('https://example.invalid'), /только loopback/iu);

  const request = {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3' }),
  };
  const failed = await fetch(`${mock.endpoint}/chat/completions`, request);

  assert.equal(failed.status, 429);
  assert.equal((await failed.json()).error.message, message, 'Ответ провайдера клиенту не изменён');

  const success = await fetch(`${mock.endpoint}/chat/completions`, request);
  const stream = await success.text();

  assert.equal(success.status, 200);
  assert.match(stream, /ответ-модели/u);
  assert.match(stream, /\[DONE\]/u);
  assert.ok(mock.requests.every((entry) => entry.authorizationMatches));

  const errors = await readGlmSmokeHttpErrors(observer.file, { ZAI_API_KEY: KEY }, root);

  assert.equal(errors.length, 1, 'Успешный поток не записывается в диагностику ошибок');
  assert.equal(errors[0].httpStatus, 429);
  assert.equal(JSON.parse(errors[0].errorText).error.code, '1113');
  assert.match(errors[0].errorText, /конец-ошибки/u, 'Тело не усечено до лимита краткого detail');
  assert.ok(errors[0].errorText.length > 8192);
  assert.doesNotMatch(errors[0].errorText, /synthetic-smoke-http-secret|user@example\.test/u);
  assert.equal(errors[0].errorText.includes(root), false);
  assert.equal((await fs.stat(observer.file)).mode & 0o777, 0o600);

  await mock.stop();
  await assert.rejects(fetch(`${mock.endpoint}/chat/completions`, request));

  const afterDisconnect = await readGlmSmokeHttpErrors(observer.file, { ZAI_API_KEY: KEY }, root);

  assert.equal(afterDisconnect.length, 2);
  assert.equal(afterDisconnect[1].httpStatus, null, 'Сетевой сбой не выдаётся за HTTP-ответ');
});
