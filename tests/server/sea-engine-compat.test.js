import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { writeCompatibility } from '../../server/scripts/sea/compatibility.mts';

const run = promisify(execFile);

/**
 * Временный корень проверки обёрток не содержит серверных исходников.
 * Уборка удаляет только каталог, созданный этой проверкой.
 */
async function scratch(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-compat-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

test('SEA-COMPAT-01: обёртки сохраняют exports, argv и код отказа', async (t) => {
  const root = await scratch(t);
  const helperDirectory = path.join(root, 'server/runtime/helpers');

  await mkdir(helperDirectory, { recursive: true });
  await writeFile(path.join(helperDirectory, 'library.mjs'), 'export const value = "сохранён";\n');
  await writeFile(path.join(helperDirectory, 'script.mjs'),
    'console.log(JSON.stringify(process.argv.slice(2)));\nprocess.exitCode = 7;\n');

  const manifest = {
    schema: 1,
    wrappers: [
      {
        path: 'engine/lib/probe-library.mjs',
        helper: 'library',
        kind: 'library',
      },
      {
        path: 'engine/lib/probe.mjs',
        helper: 'script',
        kind: 'script',
      },
    ],
  };
  const helpers = { helpers: [
    { id: 'library', entryKind: 'library' },
    { id: 'script', entryKind: 'script' },
  ] };

  await writeCompatibility(root, manifest, helpers);

  const library = await import(pathToFileURL(path.join(root, 'engine/lib/probe-library.mjs')).href);

  assert.equal(library.value, 'сохранён');

  const command = [path.join(root, 'engine/lib/probe.mjs'), 'a b', ''];

  await assert.rejects(run(process.execPath, command), (error) => {
    assert.equal(error.code, 7);
    assert.deepEqual(JSON.parse(error.stdout), ['a b', '']);

    return true;
  });
  assert.doesNotMatch(await readFile(path.join(root, 'engine/lib/probe.mjs'), 'utf8'), /\/home\//);
});

test('SEA-COMPAT-02: неизвестный helper и выход за R отвергаются до записи', async (t) => {
  const root = await scratch(t);

  for (const wrapper of [
    {
      path: '../escape.mjs',
      helper: 'known',
      kind: 'script',
    },
    {
      path: 'engine/lib/unknown.mjs',
      helper: 'absent',
      kind: 'script',
    },
    {
      path: 'engine/lib/unknown.mjs',
      helper: 'known',
      kind: 'magic',
    },
  ]) {
    await assert.rejects(writeCompatibility(root, { schema: 1, wrappers: [wrapper] }, {
      helpers: [{ id: 'known', entryKind: 'script' }],
    }), /обёртк|helper|путь/i);
  }
});
