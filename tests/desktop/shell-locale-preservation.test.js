import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';

import { startPipe } from '../../desktop/src/pipe/pipeServer.ts';

/**
 * HTTP-клиент сохраняет заданный Host, тогда как fetch нормализует его в origin URL.
 * Полное чтение ответа освобождает соединение до завершения временной трубы.
 */
function post(origin, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(origin + '/__shell/locale', { method: 'POST', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });

    request.on('error', reject);
    request.end(JSON.stringify({ preference: 'en' }));
  });
}

test('GUARD-AUTH: locale закрыт cookie, Host, Origin и Fetch-Site до вызова shell', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'i18n-auth-'));
  let calls = 0;
  const pipe = await startPipe({
    port: 0,
    uiDir: directory,
    secret: 'synthetic-language-secret',
    appApi: { major: 0, minor: 1 },
    upstream: null,
    shell: {
      handle(_req, res) {
        calls += 1;
        res.writeHead(204);
        res.end();
      },
    },
  });

  t.after(async () => {
    await pipe.close();
    await rm(directory, { recursive: true, force: true });
  });

  const cookie = 'grigdesk_pipe=synthetic-language-secret';

  for (const headers of [
    {},
    { cookie: 'grigdesk_pipe=wrong' },
    { cookie, origin: 'https://foreign.test' },
    { cookie, host: 'foreign.test' },
    { cookie, 'sec-fetch-site': 'cross-site' },
  ]) {
    const status = await post(pipe.origin, headers);

    assert.equal(status, 403, JSON.stringify(headers));
    assert.equal(calls, 0);
  }

  const accepted = await post(pipe.origin, { cookie, origin: pipe.origin });

  assert.equal(accepted, 204);
  assert.equal(calls, 1);
});
