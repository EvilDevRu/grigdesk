import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repository = path.resolve(import.meta.dirname, '../..');

test('RK-1: keygen создаёт пару PEM с правами 0600/0644 и печатает публичный ключ', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'release-keygen-'));

  t.after(() => {
    return fs.rm(dir, {
      recursive: true,
      force: true
    });
  });

  const result = spawnSync(process.execPath, ['tools/release-keygen.mts', dir], {
    cwd: repository,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const privatePem = await fs.readFile(path.join(dir, 'release-signing.pem'), 'utf8');
  const publicPem = await fs.readFile(path.join(dir, 'release-signing.pub.pem'), 'utf8');

  assert.match(privatePem, /BEGIN PRIVATE KEY/);
  assert.match(publicPem, /BEGIN PUBLIC KEY/);
  assert.ok(result.stdout.includes(publicPem.trim()), 'вывод содержит публичный ключ');

  const privateMode = (await fs.stat(path.join(dir, 'release-signing.pem'))).mode & 0o777;
  const publicMode = (await fs.stat(path.join(dir, 'release-signing.pub.pem'))).mode & 0o777;

  assert.equal(privateMode, 0o600);
  assert.equal(publicMode, 0o644);
});

test('RK-2: повторный запуск при существующем приватном ключе отказывает', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'release-keygen-2'));

  t.after(() => {
    return fs.rm(dir, {
      recursive: true,
      force: true
    });
  });
  await fs.writeFile(path.join(dir, 'release-signing.pem'), 'EXISTING');

  const result = spawnSync(process.execPath, ['tools/release-keygen.mts', dir], {
    cwd: repository,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.equal(await fs.readFile(path.join(dir, 'release-signing.pem'), 'utf8'), 'EXISTING');
});
