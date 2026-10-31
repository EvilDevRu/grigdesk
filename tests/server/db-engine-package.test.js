import assert from 'node:assert/strict';

import { lstat, symlink, writeFile } from 'node:fs/promises';

import path from 'node:path';

import test from 'node:test';

import { validatePluginPackage } from '../../server/src/lib/packageInstall/validatePackage.ts';

import { engineTree, writeEngine } from './helpers/dbEngineFixture.js';

const expected = {
  packageKind: 'db-engine',
  version: '1.0.0',
  expectedId: null,
  reservedIds: new Set(['mysql']),
  grigDeskVersion: '1.0.0',
};

test('DPK-01: engine.json без plugin.json/version нормализуется без импорта entry', async (t) => {
  const root = await engineTree(t);

  const marker = path.join(root, 'imported');

  const dir = await writeEngine(root, 'fixture-db', {},
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad');`);

  const result = await validatePluginPackage(dir, expected);

  assert.equal(result.id, 'fixture-db');

  assert.equal(result.name, 'Внешняя СУБД');

  assert.equal(result.version, expected.version);

  assert.equal(result.hasServer, true);

  assert.equal(result.webDir, null);

  assert.equal(result.webModuleDir, null);

  assert.deepEqual(result.npmDirs, []);

  assert.equal(await lstat(marker).catch(() => null), null);
});

for (const [name, patch] of [
  ['пустой label', { label: '' }],
  ['длинный label', { label: 'я'.repeat(129) }],
  ['kind', { kind: 'plugin' }],
  ['api строкой', { api: '1' }],
  ['api иной версии', { api: 2 }],
  ['minimum будущего', { minimum: '99.0.0' }],
  ['minimum prerelease', { minimum: '1.0.0-beta' }],
  ['id прототипа', { id: '__proto__' }],
  ['id вне домена', { id: 'Bad Id' }],
  ['entry traversal', { entry: '../outside.mjs' }],
  ['entry абсолютный', { entry: '/tmp/entry.mjs' }],
  ['entry расширение', { entry: 'entry.js' }],
  ['entry dependency', { entry: 'node_modules/entry.mjs' }],
  ['version не совпадает с тегом', { version: '2.0.0' }],
]) {
  test(`DPK-02: отклоняется ${name} по политике драйвера`, async (t) => {
    const root = await engineTree(t);

    const dir = await writeEngine(root, 'fixture-db', patch);

    await assert.rejects(validatePluginPackage(dir, expected), (error) => {
      assert.notEqual(error.code, 'manifest_missing', 'должен проверяться engine.json');

      assert.doesNotMatch(error.message, /plugin\.json|api2/u);

      return true;
    });
  });
}

test('DPK-02: reserved id и expectedId проверяются для engine.json', async (t) => {
  const root = await engineTree(t);

  const reserved = await writeEngine(root, 'mysql');

  const other = await writeEngine(root, 'other');

  await assert.rejects(validatePluginPackage(reserved, expected), { code: 'id_reserved' });

  await assert.rejects(validatePluginPackage(other, { ...expected, expectedId: 'fixture-db' }), {
    code: 'id_mismatch',
  });
});

test('DPK-02: entry должен существовать и не быть symlink', async (t) => {
  const root = await engineTree(t);

  const dir = await writeEngine(root, 'fixture-db', { entry: 'missing.mjs' });

  await assert.rejects(validatePluginPackage(dir, expected), (error) => error.code !== 'manifest_missing');

  await symlink('entry.mjs', path.join(dir, 'missing.mjs'));

  await assert.rejects(validatePluginPackage(dir, expected), (error) => error.code !== 'manifest_missing');
});

test('DPK-02: корневой lock выбирает npm, file dependencies отклоняются', async (t) => {
  const root = await engineTree(t);

  const dir = await writeEngine(root);

  const pkg = { name: 'fixture-db', version: '1.0.0' };

  const lock = {
    name: pkg.name,
    version: pkg.version,
    lockfileVersion: 3,
    packages: { '': pkg }
  };

  await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg));

  await writeFile(path.join(dir, 'package-lock.json'), JSON.stringify(lock));

  assert.deepEqual((await validatePluginPackage(dir, expected)).npmDirs, ['.']);

  await writeFile(path.join(dir, 'package.json'), JSON.stringify({
    ...pkg,
    dependencies: { unsafe: 'file:../outside' },
  }));

  await assert.rejects(validatePluginPackage(dir, expected), { code: 'package_unsupported' });
});

for (const field of ['id', 'label', 'kind', 'api', 'minimum', 'entry']) {
  test(`DPK-02: поле ${field} обязательно в engine.json`, async (t) => {
    const root = await engineTree(t);

    const dir = await writeEngine(root);

    const { readFile } = await import('node:fs/promises');

    const manifest = JSON.parse(await readFile(path.join(dir, 'engine.json'), 'utf8'));

    delete manifest[field];

    await writeFile(path.join(dir, 'engine.json'), JSON.stringify(manifest));

    await assert.rejects(validatePluginPackage(dir, expected), (error) => {
      assert.notEqual(error.code, 'manifest_missing',
        'engine.json существует, проверяется обязательное поле');

      return true;
    });
  });
}
