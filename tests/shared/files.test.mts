import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readTextOrNull, syncDirectory, withWorkDirectory } from '../../shared/node/files.ts';

test('UTF-8 чтение отличает ENOENT, пустой файл, ссылку и отказ чтения', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shared-files-'));

  t.after(() => rm(directory, { recursive: true, force: true }));

  const file = path.join(directory, 'data');
  const link = path.join(directory, 'link');

  assert.equal(await readTextOrNull(file), null);
  await symlink(file, link);
  assert.equal(await readTextOrNull(link), null);
  await writeFile(file, '');
  assert.equal(await readTextOrNull(file), '');
  await writeFile(file, 'текст\n');
  assert.equal(await readTextOrNull(link), 'текст\n');
  await writeFile(file, Buffer.from([0xff]));
  assert.equal(await readTextOrNull(file), '\uFFFD');
  await assert.rejects(readTextOrNull(directory), { code: 'EISDIR' });
});

test('временные папки уникальны и очищаются при успехе и отказе', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shared-work-'));

  t.after(() => rm(directory, { recursive: true, force: true }));

  const cache = path.join(directory, 'nested', 'cache');
  const seen = new Set<string>();
  const results = await Promise.all([1, 2].map((value) => withWorkDirectory(cache, async (work) => {
    seen.add(work);
    await writeFile(path.join(work, 'file'), String(value));

    return readFile(path.join(work, 'file'), 'utf8');
  })));

  assert.deepEqual(results, ['1', '2']);
  assert.equal(seen.size, 2);
  assert.deepEqual(await readdir(cache), []);

  const failure = new Error('produce');

  await assert.rejects(withWorkDirectory(cache, async () => {
    throw failure;
  }), (error) => error === failure);
  assert.deepEqual(await readdir(cache), []);
});

test('fsync каталога не следует ссылке и не маскирует отсутствующий путь', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shared-sync-'));

  t.after(() => rm(directory, { recursive: true, force: true }));
  await syncDirectory(directory);
  await assert.rejects(syncDirectory(path.join(directory, 'missing')), { code: 'ENOENT' });

  const link = path.join(directory, 'link');

  await symlink(directory, link);
  await assert.rejects(syncDirectory(link));
});
