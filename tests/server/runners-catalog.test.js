// Каталог установленных исполнителей — зеркало `factory runners` движка:
// только *.sh-модули адаптеров, без служебных index/policy/catalog и без имён,
// которые нельзя передать обратно в CLI движка.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listInstalledRunners } from '../../server/src/lib/runners-catalog.js';

test('каталог исполнителей: только валидные адаптеры, отсортированные', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-runners-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runnersDir = path.join(root, 'engine', 'lib', 'runners');
  await mkdir(runnersDir, { recursive: true });
  for (const name of ['codex.sh', 'claude.sh', 'index.sh', 'policy.sh', 'catalog.sh']) {
    await writeFile(path.join(runnersDir, name), '# адаптер\n');
  }
  // Не модуль движка и имена, непригодные для CLI-аргумента.
  await writeFile(path.join(runnersDir, 'notes.txt'), 'текст\n');
  await writeFile(path.join(runnersDir, 'Claude.sh'), '# верхний регистр\n');
  await writeFile(path.join(runnersDir, '0bad.sh'), '# цифра в начале\n');

  assert.deepEqual(await listInstalledRunners({ factoryHome: path.join(root, 'engine') }), [
    'claude', 'codex',
  ]);
});

test('каталог исполнителей: несуществующая директория — пустой список', async () => {
  assert.deepEqual(await listInstalledRunners({ factoryHome: '/нет/такого/engine' }), []);
});
