import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

import { nodeArchive } from '../../shared/node/seaBuild.ts';

import { runtimeInfoFixture } from './deepseekMetadataFixture.mts';

export const DAY = 86_400_000;
export const NOW = 1_800_000_000_000;

const ENVIRONMENT = [
  'HOME', 'GRIGDESK_HOME', 'GRIGDESK_ARTIFACTS_DIR', 'GRIGDESK_TEST_DEEPSEEK_ROOT',
  'GRIGDESK_TEST_DEEPSEEK_BINARY', 'GRIGDESK_TEST_DEEPSEEK_CACHE_DIR',
  'GRIGDESK_TEST_DEEPSEEK_PAYLOAD', 'GRIGDESK_DEEPSEEK_NODE_CACHE',
  'GRIGDESK_TEST_DEEPSEEK_RETENTION', 'GRIGDESK_TEST_DEEPSEEK_KEEP_GENERATIONS',
] as const;

/**
 * Все изменяемые пути и переменные принадлежат одному временному сценарию.
 * Даже при отказе assertion восстановление окружения не затрагивает данные владельца.
 */
export async function retentionFixture(t: TestContext) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-retention-'));
  const saved = ENVIRONMENT.map((name) => [name, process.env[name]] as const);
  const artifacts = path.join(home, 'artifacts');
  const root = path.join(artifacts, 'deepseek-binary');
  const binary = path.join(home, 'binary');
  const cache = path.join(root, 'explicit-cache/current');
  const payload = path.join(home, 'payload.zip');
  const calls = path.join(home, 'calls.jsonl');
  const control = path.join(home, 'control.json');
  const info = runtimeInfoFixture();

  t.after(async () => {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }

    await fs.rm(home, { recursive: true, force: true });
  });

  for (const name of ENVIRONMENT) {
    delete process.env[name];
  }

  Object.assign(process.env, {
    HOME: home,
    GRIGDESK_HOME: path.join(home, 'data'),
    GRIGDESK_ARTIFACTS_DIR: artifacts,
    GRIGDESK_TEST_DEEPSEEK_ROOT: root,
    GRIGDESK_TEST_DEEPSEEK_BINARY: binary,
    GRIGDESK_TEST_DEEPSEEK_CACHE_DIR: cache,
    GRIGDESK_TEST_DEEPSEEK_PAYLOAD: payload,
  });
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(payload, 'private payload');
  await fs.writeFile(control, '{}');
  await fs.writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const control = JSON.parse(fs.readFileSync(${JSON.stringify(control)}, 'utf8'));
const cache = args.includes('--cache-dir') ? args[args.indexOf('--cache-dir') + 1]
  : ${JSON.stringify(cache)};
const ownerFile = cache + '.lock/owner.json';
const owner = fs.existsSync(ownerFile) ? JSON.parse(fs.readFileSync(ownerFile, 'utf8')) : null;
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, owner }) + '\\n');
if (control.exit) process.exit(control.exit);
if (control.barrier && args.includes('--runtime-info')) {
  fs.writeFileSync(control.barrier + '.ready', '');
  const end = Date.now() + 10000;
  while (!fs.existsSync(control.barrier + '.release') && Date.now() < end) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (!fs.existsSync(control.barrier + '.release')) process.exit(8);
}
const info = ${JSON.stringify(info)};
const proof = { packageId: control.packageId ?? info.packageId, verified: control.verified ?? true };
process.stdout.write(JSON.stringify(args.includes('--runtime-info') ? info : proof) + '\\n');
`, { mode: 0o755 });

  return {
    home,
    artifacts,
    root,
    binary,
    cache,
    payload,
    calls,
    control,
    info,
  };
}

/**
 * Возраст задаётся всему маленькому дереву, а не только его родителю.
 * Это отличает проверку retention от случайной свежести только что записанного файла.
 */
export async function ageTree(directory: string, time: number): Promise<void> {
  const stat = await fs.lstat(directory);

  if (stat.isDirectory()) {
    for (const name of await fs.readdir(directory)) {
      await ageTree(path.join(directory, name), time);
    }
  }

  await fs.lutimes(directory, time / 1000, time / 1000);
}

/**
 * Кандидат содержит известное число байт; часы могут быть фиксированы тестом.
 * Родительские контейнеры не становятся кандидатами из-за их собственного mtime.
 */
export async function oldTree(root: string, relative: string, bytes = 17, time = Date.now() - 8 * DAY) {
  const directory = path.join(root, relative);

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'sentinel'), Buffer.alloc(bytes, 37));
  await ageTree(directory, time);

  return directory;
}

/**
 * Только ENOENT означает отсутствие; ошибка доступа не выдаётся за удаление.
 * Символическая ссылка считается существующей записью даже при отсутствующем target.
 */
export async function present(file: string): Promise<boolean> {
  return fs.lstat(file).then(() => true, (error: NodeJS.ErrnoException) => {
    assert.equal(error.code, 'ENOENT');

    return false;
  });
}

/**
 * Снимок сохраняет режим, время, имена и байты, не проходя по символическим ссылкам.
 * Чтение файлов не учитывает atime, который закономерно меняется от самого просмотра.
 */
export async function treeSnapshot(root: string): Promise<unknown[]> {
  const result: unknown[] = [];

  /**
   * Обход ограничен собственной фикстурой и читает только обычные файлы.
   * Сортировка делает повторные снимки независимыми от порядка readdir.
   */
  async function visit(file: string): Promise<void> {
    const stat = await fs.lstat(file);
    const entry = {
      path: path.relative(root, file),
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
    };

    if (stat.isSymbolicLink()) {
      result.push({ ...entry, link: await fs.readlink(file) });
    } else if (stat.isFile()) {
      const bytes = await fs.readFile(file);

      result.push({
        ...entry,
        size: stat.size,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    } else {
      result.push(entry);

      for (const name of (await fs.readdir(file)).sort()) {
        await visit(path.join(file, name));
      }
    }
  }

  if (await present(root)) {
    await visit(root);
  }

  return result;
}

/**
 * Проверяется файловое событие своего ребёнка вместо задержки на удачу.
 * Таймаут означает сломанный протокол фикстуры, а не ожидаемое отсутствие retention.
 */
export async function waitFile(file: string): Promise<void> {
  const end = Date.now() + 5000;

  while (!await present(file)) {
    assert.ok(Date.now() < end, `Не достигнут файловый барьер: ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/**
 * Имя pinned-архива берётся из того же pin и nodeArchive, что использует candidateRoot.
 * Остальные sentinels представляют постоянные части cache, включая неизвестного ребёнка.
 */
export async function pinnedCacheFixture(root: string): Promise<string> {
  const cache = path.join(root, 'node-cache');
  const pinFile = new URL('../../deepseek/build/node-runtime.json', import.meta.url);
  const pin = JSON.parse(await fs.readFile(pinFile, 'utf8'));

  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(path.join(cache, nodeArchive(pin).name), 'pinned archive sentinel');

  for (const relative of ['payloads/id', 'runtime-deps-node24', 'node-runtime', 'unknown']) {
    await oldTree(cache, relative);
  }

  await ageTree(cache, Date.now() - 8 * DAY);

  return cache;
}
