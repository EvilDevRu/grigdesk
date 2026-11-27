import { promises as fs } from 'node:fs';
import path from 'node:path';

import { acquireDirectoryLock } from '../../shared/node/directoryLock.ts';
import { syncDirectory, withWorkDirectory } from '../../shared/node/files.ts';
import type { GlmAccessMode } from '../src/lib/glm/contract.ts';

/**
 * Сохраняет результат живой проверки в списке выпуска, заменяя записи только своего режима.
 * Блокировка охватывает чтение и замену файла, чтобы параллельные записи не теряли соседний режим.
 */
export async function writeGlmSmokeAdmission(
  file: string,
  mode: GlmAccessMode,
  compatibility: string,
): Promise<void> {
  const target = await fs.realpath(file);
  const directory = path.dirname(target);
  const lock = await acquireDirectoryLock(`${target}.lock`);

  try {
    const current = JSON.parse(await fs.readFile(target, 'utf8')) as {
      admission?: Array<{ mode: string; compatibility: string }>;
    };

    if (!Array.isArray(current.admission)) {
      throw new TypeError('Файл compatibility не содержит список admission');
    }

    current.admission = [
      ...current.admission.filter((entry) => entry.mode !== mode),
      { mode, compatibility },
    ];

    const permissions = (await fs.stat(target)).mode & 0o777;

    await withWorkDirectory(directory, async (work) => {
      const next = path.join(work, path.basename(target));

      await fs.writeFile(next, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600, flush: true });
      await fs.chmod(next, permissions);
      await fs.rename(next, target);
      await syncDirectory(directory);
    });
  } finally {
    await lock.release();
  }
}
