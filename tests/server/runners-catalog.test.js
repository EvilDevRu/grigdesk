// Каталог установленных исполнителей — зеркало `factory runners` Go-движка:
// идентификаторы из stdout, только пригодные для CLI-аргумента имена, без
// повторов и отсортированные. Нет фабрики или каталога — пустой список.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listInstalledRunners } from '../../server/src/lib/runnersCatalog.ts';

/**
 * Подписывает stub-фабрику, которая отвечает на `runners` заданным списком.
 * Каталог читается из stdout настоящего запуска, а не из shell-модулей.
 */
async function stubFactory(t, output) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-runners-catalog-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const bin = path.join(root, 'factory');

  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' ${output}\n`, { mode: 0o755 });

  return bin;
}

test('каталог исполнителей: только валидные адаптеры, отсортированные', async (t) => {
  const bin = await stubFactory(t, "'codex' 'claude' 'deepseek' 'glm' 'claude'");

  assert.deepEqual(await listInstalledRunners({ factoryBin: bin }), [
    'claude', 'codex', 'deepseek', 'glm',
  ]);
});

test('каталог исполнителей: непригодное для CLI имя отклоняет весь список', async (t) => {
  const bin = await stubFactory(t, "'claude' '0bad' 'Claude'");

  assert.deepEqual(await listInstalledRunners({ factoryBin: bin }), []);
});

test('каталог исполнителей: нет фабрики или относительный путь — пустой список', async () => {
  assert.deepEqual(await listInstalledRunners({}), []);
  assert.deepEqual(await listInstalledRunners({ factoryBin: 'relative/factory' }), []);
});

test('каталог исполнителей: несуществующая фабрика — пустой список', async () => {
  assert.deepEqual(await listInstalledRunners({ factoryBin: '/нет/такого/factory' }), []);
});
