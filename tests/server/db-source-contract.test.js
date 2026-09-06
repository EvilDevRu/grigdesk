import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const SERVER = new URL('../../server/src/', import.meta.url);
const WEB = new URL('../../web/src/', import.meta.url);

async function walk(root, suffixes) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, root);
    if (entry.isDirectory()) {
      files.push(...await walk(target, suffixes));
    } else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) {
      files.push(target);
    }
  }
  return files;
}

test('ядро БД и Vue не ветвятся по имени СУБД', async () => {
  const dbRoot = new URL('lib/db/', SERVER);
  const coreExists = await access(dbRoot).then(() => true, () => false);
  const files = [
    ...(coreExists ? await walk(dbRoot, ['.js']) : []),
    ...await walk(WEB, ['.js', '.ts', '.vue']),
  ];
  const forbidden = [];
  for (const file of files) {
    if (file.pathname.includes('/lib/db/engines/')) {
      continue;
    }
    const source = await readFile(file, 'utf8');
    if (/['"](?:mysql|clickhouse|redis)['"]/iu.test(source)) {
      forbidden.push(path.relative(new URL('../..', import.meta.url).pathname, file.pathname));
    }
  }

  assert.deepEqual(
    { coreExists, forbidden },
    { coreExists: true, forbidden: [] },
    `ветвления по вендору найдены вне engine-файлов: ${forbidden.join(', ')}`,
  );
});
