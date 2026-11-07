import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { jsonHash32, sha256, sha256File, shortSha256 } from '../../shared/node/hash.ts';

test('SHA256 использует байты UTF-8 и полный lowercase hex', () => {
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256('я'), sha256(Buffer.from('я', 'utf8')));
  assert.equal(sha256(new Uint8Array([97, 98, 99])), sha256('abc'));
  assert.equal(shortSha256('abc'), 'ba7816bf8f01cfea414140de5dae2223');
});

test('JSON-хеш сохраняет сериализацию и её ошибки', () => {
  assert.equal(jsonHash32({ a: 1 }), shortSha256('{"a":1}'));
  assert.notEqual(jsonHash32({ a: 1, b: 2 }), jsonHash32({ b: 2, a: 1 }));
  assert.equal(jsonHash32([undefined, NaN]), jsonHash32([null, null]));
  assert.throws(() => jsonHash32(undefined), TypeError);
  assert.throws(() => jsonHash32(1n), TypeError);

  const cyclic: { self?: unknown } = {};

  cyclic.self = cyclic;
  assert.throws(() => jsonHash32(cyclic), TypeError);
});

test('хеш файла охватывает несколько чанков и сохраняет ошибки чтения', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shared-hash-'));

  t.after(() => rm(directory, { recursive: true, force: true }));

  const file = path.join(directory, 'data');
  const data = Buffer.alloc(262_145, 0xab);

  await writeFile(file, data);
  assert.equal(await sha256File(file), sha256(data));
  await writeFile(file, '');
  assert.equal(await sha256File(file), sha256(''));
  await assert.rejects(sha256File(path.join(directory, 'missing')), { code: 'ENOENT' });
  await assert.rejects(sha256File(directory), { code: 'EISDIR' });
});
