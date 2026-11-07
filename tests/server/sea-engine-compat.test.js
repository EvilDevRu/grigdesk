import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { LEGACY } from '../../shared/runtime/legacyBrand.ts';
import { writeCompatibility } from '../../server/scripts/sea/compatibility.mts';
import { buildHelper, loadHelpers } from '../../server/scripts/sea/helpers.mts';

const run = promisify(execFile);
const SOURCE = path.resolve(import.meta.dirname, '../..');

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
        path: 'shared/runtime/legacyBrand.ts',
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

  const library = await import(pathToFileURL(path.join(root, 'shared/runtime/legacyBrand.ts')).href);

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

test('SEA-COMPAT-03: библиотечный helper действительно экспортирует прежние имена', async (t) => {
  const root = await scratch(t);
  const file = path.join(root, 'helpers.json');

  await writeFile(file, JSON.stringify({ schema: 1, helpers: [{
    id: 'legacy-brand',
    entry: 'shared/runtime/legacyBrand.ts',
    entryKind: 'library',
    exports: ['LEGACY', 'legacyRootProblem'],
    description: 'Библиотечная совместимость shell.',
  }] }));

  const manifest = await loadHelpers(file, SOURCE);
  const built = await buildHelper({
    root: SOURCE,
    id: 'legacy-brand',
    manifest,
    outDir: path.join(root, 'out'),
    workDir: path.join(root, 'build'),
  });
  const library = await import(pathToFileURL(built.file).href);

  assert.equal(library.LEGACY.envPrefix, LEGACY.envPrefix);
  assert.equal(library.legacyRootProblem({ GRIGDESK_HOME: '/tmp/test' }), null);
});
