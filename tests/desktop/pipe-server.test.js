import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporary } from '../relay/helpers.js';
import { sealUiRelease } from '../../desktop/src/uiRelease.ts';
import { startPipe } from '../../desktop/src/pipe/pipeServer.ts';

/**
 * Запечатывает крошечный пакет интерфейса вне рабочего dist.
 * Каждая проверка получает случайный порт и собственную cookie.
 */
export async function pipeFixture(t, options = {}) {
  const directory = await temporary(t);
  const uiDir = path.join(directory, 'ui');

  await mkdir(uiDir);
  await writeFile(path.join(uiDir, 'index.html'), '<h1>Машины</h1>');
  await writeFile(path.join(uiDir, 'app.js'), 'export const packaged = true;');
  await sealUiRelease(uiDir);

  const pipe = await startPipe({
    port: 0,
    uiDir,
    secret: 'synthetic-pipe-secret',
    appApi: { major: 0, minor: 1 },
    upstream: null,
    ...options,
  });

  t.after(() => pipe?.close());

  return pipe;
}

test('труба требует cookie, раздаёт только manifest и держит API без машины закрытым', async (t) => {
  const pipe = await pipeFixture(t);

  assert.ok(pipe, 'труба должна запуститься');
  assert.equal((await fetch(pipe.origin)).status, 403);

  const headers = { cookie: 'grigdesk_pipe=synthetic-pipe-secret' };
  const index = await fetch(pipe.origin, { headers });

  assert.equal(index.status, 200);
  assert.equal(index.headers.get('cache-control'), 'no-cache');
  assert.equal(await index.text(), '<h1>Машины</h1>');
  assert.equal((await fetch(`${pipe.origin}/chats`, { headers })).status, 404);
  assert.equal((await fetch(`${pipe.origin}/api/x`, { headers })).status, 503);
  assert.equal((await fetch(`${pipe.origin}/app.js`, { headers })).headers.get('x-content-type-options'),
    'nosniff');

  const foreign = await fetch(pipe.origin, {
    headers: { ...headers, origin: 'https://other.test' },
  });

  assert.equal(foreign.status, 403);
});

test('D2: чужой сайт не проходит без Origin, теневая cookie не блокирует настоящую', async (t) => {
  const pipe = await pipeFixture(t);
  const headers = { cookie: 'grigdesk_pipe=x; grigdesk_pipe=synthetic-pipe-secret' };

  assert.equal((await fetch(pipe.origin, { headers })).status, 200);

  for (const site of ['cross-site', 'same-site']) {
    const response = await fetch(pipe.origin, { headers: { ...headers, 'sec-fetch-site': site } });

    assert.equal(response.status, 403);
  }

  for (const site of ['same-origin', 'none']) {
    const response = await fetch(pipe.origin, { headers: { ...headers, 'sec-fetch-site': site } });

    assert.equal(response.status, 200);
  }
});
