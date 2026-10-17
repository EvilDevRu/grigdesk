import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createPluginRepo } from './helpers/pluginRepo.js';

test('F0: fixture создаёт отдельный file origin и релиз без настроек машины', async (t) => {
  const repo = await createPluginRepo(t);

  assert.equal(typeof repo.release, 'function');

  const sha = await repo.release('1.0.0');

  assert.match(sha, /^[a-f0-9]{40}$/u);
  assert.equal(new URL(repo.url).protocol, 'file:');
  assert.equal(JSON.parse(await readFile(`${repo.work}/plugin.json`, 'utf8')).version, '1.0.0');
});
