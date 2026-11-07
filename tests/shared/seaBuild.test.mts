import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { downloadFile, nodeArchive, seaConfig } from '../../shared/node/seaBuild.ts';

test('SEA config и архив сохраняют имена, лицензию и запрет execArgv', () => {
  assert.deepEqual(nodeArchive({ version: '24.1.2', platform: 'linux-x64' }), {
    directory: 'node-v24.1.2-linux-x64',
    name: 'node-v24.1.2-linux-x64.tar.xz',
    url: 'https://nodejs.org/dist/v24.1.2/node-v24.1.2-linux-x64.tar.xz',
  });
  assert.deepEqual(seaConfig(), {
    main: 'bundle.cjs',
    output: 'sea-prep.blob',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgvExtension: 'none',
    assets: { 'NODE-LICENSE': 'LICENSE' },
  });
  assert.notEqual(seaConfig().assets, seaConfig().assets);
});

test('скачивание пишет тело потоком, сохраняя настройки fetch и ошибки', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shared-sea-'));

  t.after(() => rm(directory, { recursive: true, force: true }));

  const file = path.join(directory, 'archive');
  const mocked = t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    assert.equal(init?.redirect, 'follow');
    assert.ok(init?.signal instanceof AbortSignal);

    return new Response('архив');
  });

  await downloadFile('https://example.invalid/runtime', file);
  assert.equal(await readFile(file, 'utf8'), 'архив');
  await assert.rejects(downloadFile('https://example.invalid/runtime', path.join(directory, 'missing/file')));
  mocked.mock.mockImplementation(async () => new Response(null, { status: 200 }));
  await assert.rejects(downloadFile('https://example.invalid/runtime', file), /HTTP 200/);

  let cancelled = false;

  mocked.mock.mockImplementation(async () => new Response(new ReadableStream({
    cancel() {
      cancelled = true;
    },
  }), { status: 503 }));
  await assert.rejects(downloadFile('https://example.invalid/runtime', file), /HTTP 503/);
  assert.equal(cancelled, true);

  const failure = new Error('network');

  mocked.mock.mockImplementation(async () => {
    throw failure;
  });
  await assert.rejects(downloadFile('https://example.invalid/runtime', file), (error) => error === failure);
});
