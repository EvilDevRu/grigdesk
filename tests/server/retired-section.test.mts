import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { pluginBootFixture } from './helpers/pluginBootFixture.js';

test('RET-KEEP: запуск сохраняет прежнюю папку без изменений', async (t) => {
  const marker = Buffer.from('# Личная роль\nСохранить содержимое без изменений.\n');
  const bootOptions = {
    apiSession: true,
    before: async ({ root }: { root: string }) => {
      const directory = path.join(root, 'agents');

      await mkdir(directory);
      await writeFile(path.join(directory, 'marker.md'), marker);
    },
  };
  const fixture = await pluginBootFixture(t, bootOptions);
  const response = await fixture.get('/api/health');

  assert.equal(response.status, 200, 'Проверяем сохранность после успешного авторизованного boot');
  assert.deepEqual(await readdir(path.join(fixture.root, 'agents')), ['marker.md']);
  assert.deepEqual(await readFile(path.join(fixture.root, 'agents', 'marker.md')), marker);
});

test('RET-API: прежние действия отсутствуют у авторизованного клиента', async (t) => {
  const fixture = await pluginBootFixture(t);
  const prefix = ['', 'api', 'agents'].join('/');
  const directory = path.join(fixture.root, 'agents');
  const health = await fixture.get('/api/health');

  assert.equal(health.status, 200, 'Авторизация работает до проверки снятых действий');
  await assert.rejects(stat(directory), { code: 'ENOENT' });

  for (const [method, suffix] of [
    ['GET', ''],
    ['POST', ''],
    ['GET', '/role'],
    ['PUT', '/role'],
    ['DELETE', '/role'],
    ['POST', '/install'],
    ['POST', '/reseed'],
  ]) {
    await t.test(`${method} ${suffix || '/'}`, async () => {
      const hasBody = method === 'POST' || method === 'PUT';
      const response = await fetch(fixture.address + prefix + suffix, {
        method,
        headers: hasBody ? { ...fixture.cli, 'content-type': 'application/json' } : fixture.cli,
        body: hasBody ? '{}' : undefined,
        signal: AbortSignal.timeout(10_000),
      });

      await response.arrayBuffer();
      assert.equal(response.status, 404, `${method} ${prefix}${suffix}`);
    });
  }

  await assert.rejects(stat(directory), { code: 'ENOENT' });
});
