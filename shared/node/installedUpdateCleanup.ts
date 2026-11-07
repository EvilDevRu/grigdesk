import fs from 'node:fs/promises';
import path from 'node:path';

import { acquireInstallLock } from './binaryInstall.ts';
import { parseProductVersion } from '../runtime/productReleaseVersion.ts';
import { readInstalledPointer } from './installedLayout.ts';
import type { InstallationReceipt } from './installedLayout.ts';
import type { InstalledUpdateJob } from './installedUpdateState.ts';

/**
 * Завершённое задание не нуждается в архивах, распаковках и пробах подготовки.
 * Удаляются собственный staging-каталог задания и по-заданиевые логи helper-процессов;
 * журнал job.json и общие журналы запуска остаются.
 */
async function removeJobArtifacts(receipt: InstallationReceipt, job: InstalledUpdateJob): Promise<void> {
  await fs.rm(path.join(receipt.root, 'update', job.id), { recursive: true, force: true });

  for (const action of ['prepare', 'apply', 'recover', 'rollback']) {
    await fs.rm(path.join(receipt.root, 'update', `${job.id}-${action}.log`), { force: true });
  }
}

/**
 * Поколения вне current и previous штатно недостижимы: rollback возвращается только
 * к previous, новое задание требует строго больший номер версии.
 * Посторонние каталоги с невалидным номером не трогаем — они не наши.
 */
async function pruneGenerations(receipt: InstallationReceipt, job: InstalledUpdateJob): Promise<void> {
  const current = await readInstalledPointer(receipt);
  const keep = new Set([current.desktop, current.server, job.previous.desktop, job.previous.server]
    .filter((part): part is string => part !== null)
    .map((part) => part.split('/')[1]!));
  const generations = path.join(receipt.root, 'generations');
  const entries = await fs.readdir(generations, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }

    return [];
  });

  for (const entry of entries) {
    if (entry.isDirectory() && !keep.has(entry.name) && parseProductVersion(entry.name)) {
      await fs.rm(path.join(generations, entry.name), { recursive: true, force: true });
    }
  }
}

/**
 * Уборка выполняется только после зафиксированного успеха и не может ронять его:
 * отказ удаления оставляет лишние байты на диске, но не меняет current и журналы.
 * Прореживание поколений идёт под installation lock: параллельный apply следующего
 * задания переключает current только внутри того же lock и не соревнуется с уборкой.
 * Занятый lock пропускает уборку — место освободит следующий успех.
 */
export async function pruneCompletedUpdate(
  receipt: InstallationReceipt,
  job: InstalledUpdateJob,
): Promise<void> {
  if (job.stage !== 'completed') {
    return;
  }

  try {
    await removeJobArtifacts(receipt, job);

    const lock = await acquireInstallLock(
      path.join(receipt.root, 'update/installation'), { waitMs: 0 },
    );

    try {
      await pruneGenerations(receipt, job);
    } finally {
      await lock.release();
    }
  } catch {
    // Лучшее усилие: место освободит следующее успешное обновление или человек.
  }
}
