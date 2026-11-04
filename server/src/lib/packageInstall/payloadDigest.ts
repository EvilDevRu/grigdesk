import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readlink } from 'node:fs/promises';
import path from 'node:path';

import { installError } from './errors.ts';
import { readPackageTree } from './packageTree.ts';
import type { PackageEntry } from './packageTree.ts';

export interface PackageSnapshot {
  npmDirs: string[];
  digest: string;
}

/**
 * Snapshot фиксирует файлы до выполнения npm в отдельном staging.
 * Первое требование задаёт тест неизменности после подготовки.
 */
export async function capturePackageSnapshot(dir: string, npmDirs: string[]): Promise<PackageSnapshot> {
  const tree = await readPackageTree(dir);

  return { npmDirs: [...npmDirs], digest: await digestEntries(dir, tree) };
}

/**
 * Подготовленный результат должен сохранить snapshot и безопасные npm ссылки.
 * Digest пригоден для повторного preflight перед публикацией.
 */
export async function validatePreparedPayload(
  dir: string,
  snapshot: PackageSnapshot,
): Promise<string> {
  const tree = await readPackageTree(dir, { generatedDirs: snapshot.npmDirs });
  const generated = snapshot.npmDirs.map((npmDir) => path.posix.join(npmDir, 'node_modules'));
  const original = tree.filter((entry) => !generated.some((root) => entry.relative === root
    || entry.relative.startsWith(`${root}/`)));

  if (await digestEntries(dir, original) !== snapshot.digest) {
    throw installError('preview_stale');
  }

  return digestEntries(dir, tree);
}

/**
 * Установленная копия повторно хешируется без сохранённого snapshot подготовки.
 * Этот digest служит preflight для apply, rollback и проверки целостности.
 */
export async function computePayloadDigest(dir: string, npmDirs: string[] = []): Promise<string> {
  return digestEntries(dir, await readPackageTree(dir, { generatedDirs: npmDirs }));
}

/**
 * Digest включает однозначные записи путей, типов, executable mode и content.
 * Файлы читаются потоково; корневая .git уже исключена проверенным обходом.
 */
async function digestEntries(directory: string, entries: PackageEntry[]): Promise<string> {
  const digest = createHash('sha256');

  const sorted = [...entries].sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);

  for (const entry of sorted) {
    const type = entry.info.isSymbolicLink() ? 'link' : entry.info.isDirectory() ? 'directory' : 'file';

    const size = type === 'file' ? entry.info.size : null;

    digest.update(JSON.stringify([entry.relative, type, entry.info.mode & 0o111, size]));
    digest.update('\0');

    if (type === 'link') {
      digest.update(await readlink(path.join(directory, entry.relative)));
    } else if (type === 'file') {
      const handle = await open(
        path.join(directory, entry.relative),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const stream = handle.createReadStream({ autoClose: false });

      try {
        for await (const chunk of stream) {
          digest.update(chunk);
        }
      } finally {
        stream.destroy();
        await handle.close();
      }
    }

    digest.update('\0');
  }

  return digest.digest('hex');
}
