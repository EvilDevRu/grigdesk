import fs from 'node:fs/promises';
import path from 'node:path';

import {
  approveInstallReceipt,
  lstatOrNull,
  readInstallReceipt,
  snapshotInstalledFile,
  type PreviousInstall,
} from '../../../shared/node/binaryInstall.ts';
import { syncDirectory } from '../../../shared/node/files.ts';
import { sha256File } from '../../../shared/node/hash.ts';
import { copyInstallCandidate } from './installFiles.mts';

export type { PreviousInstall } from '../../../shared/node/binaryInstall.ts';

/**
 * Прежний target копируется без исполнения только после чтения своей квитанции.
 * Потребитель задаёт точный receipt policy; backup и metadata остаются его задачами.
 */
export async function previousInstall(target: string, stage: string): Promise<PreviousInstall> {
  const receipt = await readInstallReceipt({
    target,
    suffix: '.grigdesk-server.json',
    modeAllowed: (mode) => mode === 0o600,
    exactKeys: true,
    invalid: () => new Error('Некорректный receipt установленного сервера'),
  });

  return snapshotInstalledFile(receipt, stage, {
    copy: copyInstallCandidate,
    unknownTarget: () => new Error('Установщик не перезаписывает чужой target сервера'),
  });
}

/**
 * Ближайший существующий предок проверяется физически до mkdir резервного дерева.
 * Ссылка releases или её предка не должна создавать даже пустые каталоги за границей установки.
 */
async function prepareBackupRoot(releases: string): Promise<void> {
  let ancestor = releases;
  let stat = await lstatOrNull(ancestor);

  while (!stat) {
    ancestor = path.dirname(ancestor);
    stat = await lstatOrNull(ancestor);
  }

  if (!stat.isDirectory() || await fs.realpath(ancestor) !== ancestor) {
    throw new Error('Каталог резервных ELF не должен проходить через символическую ссылку');
  }

  if (ancestor === releases && (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0)) {
    throw new Error('Каталог резервных ELF должен принадлежать владельцу и иметь права 0700');
  }

  await fs.mkdir(releases, { recursive: true, mode: 0o700 });
  await syncDirectory(path.dirname(releases));
}

/**
 * Резервный ELF хранится по SHA и повторно проверяется после записи или при переиспользовании.
 * Ни symlink, ни повреждённая прежняя копия не заменяются молча.
 */
export async function savePrevious(previous: PreviousInstall, releases: string): Promise<string | null> {
  if (!previous.snapshot || !previous.digest) {
    return null;
  }

  const directory = path.join(releases, previous.digest);

  await prepareBackupRoot(releases);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });

  for (const folder of [releases, directory]) {
    const stat = await fs.lstat(folder);

    if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) {
      throw new Error('Каталог резервных ELF должен принадлежать владельцу и иметь права 0700');
    }
  }

  const file = path.join(directory, 'grigdesk-server');
  const stat = await lstatOrNull(file);

  if (!stat) {
    const temporary = path.join(directory, `.copy-${path.basename(path.dirname(previous.snapshot))}`);

    try {
      await copyInstallCandidate(previous.snapshot, temporary);

      if (await sha256File(temporary) !== previous.digest) {
        throw new Error('Резервная копия сервера не совпала с предыдущим ELF');
      }

      await fs.rename(temporary, file);
      await syncDirectory(directory);
      await syncDirectory(releases);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  const saved = await fs.lstat(file);

  if (!saved.isFile() || saved.uid !== process.getuid!() || (saved.mode & 0o777) !== 0o555
    || await sha256File(file) !== previous.digest) {
    throw new Error('Резервная копия сервера не прошла проверку SHA');
  }

  return file;
}

/**
 * Общий CAS квитанции сохраняет старую и новую SHA перед публикацией executable.
 * Суффикс, права и сообщение остаются частью контракта этого установщика.
 */
export async function approveInstall(
  previous: PreviousInstall,
  digest: string,
  stage: string,
): Promise<void> {
  await approveInstallReceipt(previous, digest, stage, {
    suffix: '.grigdesk-server.json',
    mode: 0o600,
    changed: () => new Error('Установленный сервер изменился во время проверки candidate'),
  });
}
