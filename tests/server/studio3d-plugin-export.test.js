import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  validatePluginPackage, validateNpmDirs,
} from '../../server/src/lib/packageInstall/validatePackage.ts';

const raw = process.env.STUDIO3D_PACKAGE_DIR;
const directory = raw === undefined ? null : path.resolve(raw);

if (raw !== undefined) {
  assert.equal(path.isAbsolute(raw), true, 'STUDIO3D_PACKAGE_DIR должен быть абсолютным');
  assert.equal((await lstat(raw)).isDirectory(), true, 'Нужен существующий release export');
}

/**
 * Собственный обход перечитывает байты и не доверяет receipt/exporter inventory.
 * Любая development папка, ссылка или npm metadata закрывает готовность выпуска.
 */
async function inventory(root, prefix = '') {
  const files = [];

  for (const name of (await readdir(path.join(root, prefix))).sort()) {
    assert.equal(['development', 'sdk', 'node_modules'].includes(name.toLowerCase()), false, name);
    assert.equal(['package.json', 'package-lock.json'].includes(name), false, name);

    const relative = prefix ? `${prefix}/${name}` : name;
    const absolute = path.join(root, relative);
    const info = await lstat(absolute);

    assert.equal(info.isSymbolicLink(), false, relative);

    if (info.isDirectory()) {
      files.push(...await inventory(root, relative));
    } else {
      assert.equal(info.isFile(), true, relative);

      const bytes = await readFile(absolute);

      files.push({
        path: relative,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }

  return files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

test('EXPORT14 готовый payload принят настоящим validator без development/SDK/npm', {
  skip: directory === null && 'Нужен STUDIO3D_PACKAGE_DIR: чистый release export.',
}, async () => {
  const manifest = JSON.parse(await readFile(path.join(directory, 'plugin.json'), 'utf8'));
  const validated = await validatePluginPackage(directory, {
    version: '1.0.0',
    expectedId: 'studio3d',
    // Это проверка формата payload; полный production SYSTEM используется в15/16.
    reservedIds: new Set(),
    grigDeskVersion: '1.0.0',
  });

  const files = await inventory(directory);

  assert.equal(validated.id, 'studio3d');
  assert.equal(validated.serverEntry, 'server.mjs');
  assert.deepEqual(validated.npmDirs, []);
  assert.deepEqual(await validateNpmDirs(directory, manifest), []);
  assert.deepEqual(manifest.install.npm, []);
  assert.equal(files.length <= 5000, true);
  assert.equal(files.reduce((sum, file) => sum + file.size, 0) <= 50 * 1024 ** 2, true);
});

test('EXPORT14 независимый SHA перечня совпадает с отдельным receipt', {
  skip: directory === null && 'Нужен STUDIO3D_PACKAGE_DIR: чистый release export.',
}, async () => {
  const files = await inventory(directory);
  const receipt = JSON.parse(await readFile(`${directory}.receipt.json`, 'utf8'));
  const digest = createHash('sha256').update(`${JSON.stringify(files)}\n`).digest('hex');

  assert.equal(receipt.pluginId, 'studio3d');
  assert.equal(receipt.version, '1.0.0');
  assert.equal(receipt.directory, directory);
  assert.deepEqual(receipt.files, files);
  assert.equal(receipt.digest, digest);
});
