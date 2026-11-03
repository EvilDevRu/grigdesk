import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseBrowserRunProof } from './factoryBrowserBinding.ts';
import { browserToolResult } from '../executors/work-tools/browser.ts';

/**
 * Каждый run имеет отдельную квоту и очередь записи, не общую папку чужих снимков.
 * Проверка private родителей защищает от случайной подмены сохранённого evidence пути.
 */
export function createBrowserEvidence(root: string) {
  const tails = new Map<string, Promise<unknown>>();

  /**
   * Родители создаются только под назначенным artifacts root и без symlink переходов.
   * Публичные URL и текст страницы не участвуют в формировании имени файла.
   */
  async function directoryFor(raw: unknown) {
    const proof = parseBrowserRunProof(raw);
    const parts = ['browser-workspace', 'pipeline', proof.task, proof.attemptId, proof.runId];

    await mkdir(root, { recursive: true, mode: 0o700 });

    let directory = await realpath(root);

    for (const part of parts) {
      directory = path.join(directory, part);
      await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') {
          throw error;
        }
      });

      /**
       * Папка общих снимков могла существовать до evidence с правами umask (0775).
       * Закрываем доступ только у собственного каталога, через дескриптор без
       * перехода по ссылке; владельца и тип проверяем до изменения режима.
       */
      const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        .catch(() => {
          throw new Error('browser_evidence_invalid');
        });

      try {
        const stat = await handle.stat();

        if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
          throw new Error('browser_evidence_invalid');
        }

        if ((stat.mode & 0o777) !== 0o700) {
          await handle.chmod(0o700);
        }
      } finally {
        await handle.close();
      }
    }

    return directory;
  }

  /**
   * Rich screenshot сохраняется только после bounded sanitizer и проверки run directory.
   * Сериализация квоты не позволяет параллельным снимкам превысить лимит.
   */
  const save = async (proof: unknown, raw: unknown) => {
    const value = raw as { format?: string } | null;

    if (value?.format !== 'grigdesk-work-content-v1') {
      return raw;
    }

    const result = browserToolResult(raw, 'screenshot') as {
      format?: string;
      content?: { data: string }[];
    };

    if (result.format !== 'grigdesk-work-content-v1' || !result.content) {
      throw new Error('browser_result_invalid');
    }

    const directory = await directoryFor(proof);
    const previous = tails.get(directory) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const files = await readdir(directory);
      let total = 0;

      if (files.length >= 32) {
        throw new Error('browser_evidence_limit');
      }

      for (const name of files) {
        const info = await lstat(path.join(directory, name));

        if (!info.isFile() || info.isSymbolicLink()) {
          throw new Error('browser_evidence_invalid');
        }

        total += info.size;
      }

      const bytes = Buffer.from(result.content![0]!.data, 'base64');

      if (total + bytes.length > 64 * 1024 * 1024) {
        throw new Error('browser_evidence_limit');
      }

      const file = path.join(directory, `${randomUUID()}.jpg`);

      await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });

      return { ...result, imagePath: file };
    });

    tails.set(directory, current);

    try {
      return await current;
    } finally {
      if (tails.get(directory) === current) {
        tails.delete(directory);
      }
    }
  };

  return Object.assign(save, { prepare: directoryFor });
}
