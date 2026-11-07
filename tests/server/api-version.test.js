import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { API_CONTRACT_FINGERPRINT, API_VERSION } from '../../shared/client/apiVersion.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tool = path.join(root, 'tools/api-version.mjs');

/**
 * Копия общего кода позволяет менять контракты и номер выпуска без правок рабочего дерева.
 * Очистка зарегистрирована до копирования, чтобы не оставлять файлы при отказе подготовки.
 */
async function versionFixture(t, major = 0, minor = 1) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-api-version-'));

  t.after(() => rm(directory, {
    recursive: true,
    force: true,
  }));
  await cp(path.join(root, 'shared'), path.join(directory, 'shared'), { recursive: true });

  const versionFile = path.join(directory, 'shared/client/apiVersion.ts');

  await writeFile(versionFile, [
    '// Посторонний текст инструмент обязан сохранить.',
    `export const API_VERSION = { major: ${major}, minor: ${minor} };`,
    `export const API_CONTRACT_FINGERPRINT = '${'0'.repeat(64)}';`,
    '',
  ].join('\n'));

  return {
    directory,
    versionFile,
    run: (...args) => spawnSync(process.execPath, [tool, '--root', directory, ...args], {
      encoding: 'utf8',
    }),
  };
}

/**
 * Эталон строится непосредственно из правила выбора путей и текстов с LF.
 * Он не импортирует инструмент, поэтому ошибку его отбора или сортировки видно в тесте.
 */
async function fingerprint(directory) {
  const files = (await readdir(path.join(directory, 'shared'), { recursive: true }))
    .map((file) => `shared/${file.split(path.sep).join('/')}`)
    .filter((file) => file.endsWith('Contracts.ts') || file === 'shared/lib/contractDecoders.ts'
      || (/^shared\/client\/[^/]+\.ts$/.test(file) && !file.endsWith('/apiVersion.ts')))
    .sort();
  const entries = await Promise.all(files.map(async (file) => {
    const source = await readFile(path.join(directory, file), 'utf8');

    return `${file}\n${source.replace(/\r\n?/g, '\n')}\n`;
  }));

  return createHash('sha256').update(entries.join('')).digest('hex');
}

/**
 * Выпущенная фикстура начинает с совпадающего отпечатка и строго версии 1.0.
 * Дальнейший отказ проверки обязан быть вызван изменением контракта, а не исходной порчей файла.
 */
async function sealFixture(fixture) {
  const source = await readFile(fixture.versionFile, 'utf8');
  const hash = await fingerprint(fixture.directory);

  await writeFile(fixture.versionFile, source.replace('0'.repeat(64), hash));
}

test('API: до первого выпуска версия контрактов остаётся 0.1', () => {
  assert.deepEqual(API_VERSION, {
    major: 0,
    minor: 1,
  });
});

test('API: major 0 выключает сторож даже с неверным отпечатком', async (t) => {
  const fixture = await versionFixture(t);
  const before = await readFile(fixture.versionFile, 'utf8');
  const result = fixture.run('--check');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /до выпуска сторож выключен/);
  assert.equal(await readFile(fixture.versionFile, 'utf8'), before);
});

test('API: отпечаток настоящего дерева соответствует общим контрактам', async () => {
  assert.equal(API_CONTRACT_FINGERPRINT, await fingerprint(root));
});

test('API: изменение выпущенного контракта требует bump minor или major', async (t) => {
  const fixture = await versionFixture(t, 1, 0);

  await sealFixture(fixture);
  await appendFile(path.join(fixture.directory, 'shared/plugins/db/dbContracts.ts'), '\n// Изменение.\n');

  const changed = fixture.run('--check');

  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /контракты изменились/);

  const minor = fixture.run('--bump', 'minor');

  assert.equal(minor.status, 0, minor.stderr);
  assert.match(await readFile(fixture.versionFile, 'utf8'), /major: 1,\s*minor: 1/);
  assert.equal(fixture.run('--check').status, 0);

  const major = fixture.run('--bump', 'major');
  const source = await readFile(fixture.versionFile, 'utf8');

  assert.equal(major.status, 0, major.stderr);
  assert.match(source, /major: 2,\s*minor: 0/);
  assert.match(source, /Посторонний текст инструмент обязан сохранить/);
  assert.ok(source.includes(await fingerprint(fixture.directory)));
  assert.equal(fixture.run('--check').status, 0);
});

test('API: отбор путей, нормализация LF и исключение самого apiVersion', async (t) => {
  const fixture = await versionFixture(t, 1, 0);
  const decoder = path.join(fixture.directory, 'shared/lib/contractDecoders.ts');

  await sealFixture(fixture);
  await appendFile(fixture.versionFile, '// Изменение вне констант.\n');
  await appendFile(path.join(fixture.directory, 'shared/lib/errors.ts'), '\n// Не контракт.\n');
  await writeFile(decoder, (await readFile(decoder, 'utf8')).replace(/\n/g, '\r\n'));

  const unchanged = fixture.run('--check');

  assert.equal(unchanged.status, 0, unchanged.stderr);

  await writeFile(path.join(fixture.directory, 'shared/client/pairingPayload.ts'), 'export {};\n');

  const added = fixture.run('--check');

  assert.equal(added.status, 1);
  assert.match(added.stderr, /контракты изменились/);

  const bump = fixture.run('--bump', 'minor');

  assert.equal(bump.status, 0, bump.stderr);
  assert.ok((await readFile(fixture.versionFile, 'utf8')).includes(await fingerprint(fixture.directory)));

  await appendFile(decoder, '// Изменение декодера.\n');

  assert.equal(fixture.run('--check').status, 1);
});
