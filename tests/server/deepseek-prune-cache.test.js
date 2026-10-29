import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const script = path.resolve(import.meta.dirname, '../../deepseek/scripts/pruneRuntimeCache.mts');

/**
 * Поколение одного buildId: несколько packageId одной поставки должны удаляться вместе.
 * Время каталога задаётся явно, чтобы порядок групп не зависел от скорости теста.
 */
async function writeGeneration(packagesDir, packageId, buildId, ageMs) {
  const dir = path.join(packagesDir, packageId);
  const runtimeFile = path.join(dir, 'generation/runtime.json');
  const time = new Date(Date.now() - ageMs);

  await fs.mkdir(path.join(dir, 'generation'), { recursive: true });
  await fs.writeFile(runtimeFile, JSON.stringify({ buildId, runtimeVersion: '0.1.5-rc.2' }));
  await fs.utimes(runtimeFile, time, time);

  return dir;
}

test('prune: остаются две свежие группы buildId, старые поколения удаляются целиком', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-prune-'));
  const packagesDir = path.join(root, 'packages');

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const fresh = await writeGeneration(packagesDir, 'aaa', 'a'.repeat(64), 60_000);
  const freshSibling = await writeGeneration(packagesDir, 'bbb', 'a'.repeat(64), 50_000);
  const previous = await writeGeneration(packagesDir, 'ccc', 'b'.repeat(64), 3_600_000);
  const stale = await writeGeneration(packagesDir, 'ddd', 'c'.repeat(64), 86_400_000);
  const staleSibling = await writeGeneration(packagesDir, 'eee', 'c'.repeat(64), 90_000_000);

  const { stdout } = await execute(process.execPath, [script, '--cache-dir', root]);

  const report = JSON.parse(stdout);

  assert.deepEqual(report.keptBuilds.sort(), ['a'.repeat(64), 'b'.repeat(64)]);
  assert.deepEqual(report.removedDirs.sort(), [stale, staleSibling].sort());
  assert.equal(await fs.stat(fresh).then(() => true, () => false), true);
  assert.equal(await fs.stat(freshSibling).then(() => true, () => false), true);
  assert.equal(await fs.stat(previous).then(() => true, () => false), true);
});

test('prune: нечитаемое поколение остаётся на месте и не мешает остальным', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-prune-'));
  const packagesDir = path.join(root, 'packages');

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const fresh = await writeGeneration(packagesDir, 'aaa', 'a'.repeat(64), 0);
  const previous = await writeGeneration(packagesDir, 'bbb', 'b'.repeat(64), 3_600_000);
  const stale = await writeGeneration(packagesDir, 'ddd', 'd'.repeat(64), 172_800_000);
  const broken = path.join(packagesDir, 'ccc');

  await fs.mkdir(path.join(broken, 'generation'), { recursive: true });

  const { stdout } = await execute(process.execPath, [script, '--cache-dir', root]);
  const report = JSON.parse(stdout);

  assert.deepEqual(report.removedDirs, [stale]);
  assert.equal(await fs.stat(fresh).then(() => true, () => false), true);
  assert.equal(await fs.stat(previous).then(() => true, () => false), true);
  assert.equal(await fs.stat(broken).then(() => true, () => false), true);
});

test('prune: резервы обрезаются до двух свежих, пустой кэш не ошибка', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-prune-'));
  const releasesDir = path.join(root, 'releases');

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const names = ['1111', '2222', '3333', '4444'];
  const now = Date.now();

  for (const [index, name] of names.entries()) {
    const dir = path.join(releasesDir, name);
    const time = new Date(now - index * 60_000);

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'deepseek'), 'elf');
    await fs.utimes(dir, time, time);
  }

  const { stdout } = await execute(process.execPath, [script, '--cache-dir', root]);
  const report = JSON.parse(stdout);

  assert.deepEqual(report.removedReleases.sort(),
    [path.join(releasesDir, '3333'), path.join(releasesDir, '4444')].sort());
  assert.equal((await fs.readdir(releasesDir)).length, 2);
});

test('prune: относительный каталог и неверные лимиты дают код отказа до эффектов', async () => {
  for (const args of [['--cache-dir', 'relative/path'],
    ['--cache-dir', '/tmp', '--keep-builds', '0'],
    ['--cache-dir', '/tmp', '--keep-releases', 'x'],
    ['--unknown', 'value']]) {
    await assert.rejects(execute(process.execPath, [script, ...args]),
      (error) => {
        assert.notEqual(error.code, 0);

        return true;
      }, JSON.stringify(args));
  }
});
