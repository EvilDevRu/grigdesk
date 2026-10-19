import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { syncDirectory } from '../../shared/node/files.ts';
import { sha256File } from '../../shared/node/hash.ts';
import { copyInstallCandidate } from './installFiles.mts';

interface Receipt {
  format: 1;
  target: string;
  approved: string[];
}

export interface PreviousInstall {
  receipt: Receipt;
  digest: string | null;
  snapshot: string | null;
}

/**
 * Отсутствие файла отличается от запрета доступа и других ошибок файловой системы.
 * Symlink остаётся видимым объектом и никогда не принимается за отсутствующий target.
 */
async function statOrNull(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

/**
 * Только private receipt нашего установщика разрешает заменять уже существующий ELF.
 * Набор проверенных SHA переживает сбой между публикацией receipt и rename бинарника.
 */
async function readReceipt(target: string): Promise<Receipt> {
  const file = `${target}.grigdesk-deepseek.json`;
  const stat = await statOrNull(file);

  if (!stat) {
    return {
      format: 1,
      target,
      approved: [],
    };
  }

  if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) {
    throw new Error('Некорректный receipt установленного DeepSeek');
  }

  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let receipt;

  try {
    receipt = JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }

  if (receipt.format !== 1 || receipt.target !== target || !Array.isArray(receipt.approved)
    || !receipt.approved.every((digest: unknown) => typeof digest === 'string'
      && /^[a-f0-9]{64}$/u.test(digest))) {
    throw new Error('Некорректный receipt установленного DeepSeek');
  }

  return receipt;
}

/**
 * Старый target сначала копируется без исполнения и сверяется с известными байтами.
 * Metadata памяти затем можно читать из снимка, не выполняя чужой обычный файл.
 */
export async function previousInstall(target: string, stage: string): Promise<PreviousInstall> {
  const receipt = await readReceipt(target);
  const stat = await statOrNull(target);

  if (!stat) {
    return {
      receipt,
      digest: null,
      snapshot: null,
    };
  }

  if (!stat.isFile() || stat.uid !== process.getuid!()) {
    throw new Error('Установщик не перезаписывает чужой target DeepSeek');
  }

  const snapshot = path.join(stage, 'previous');

  await copyInstallCandidate(target, snapshot);

  const digest = await sha256File(snapshot);

  if (!receipt.approved.includes(digest)) {
    throw new Error('Установщик не перезаписывает чужой target DeepSeek');
  }

  return {
    receipt,
    digest,
    snapshot,
  };
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

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });

  for (const folder of [releases, directory]) {
    const stat = await fs.lstat(folder);

    if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) {
      throw new Error('Каталог резервных ELF должен принадлежать владельцу и иметь права 0700');
    }
  }

  const file = path.join(directory, 'deepseek');
  const stat = await statOrNull(file);

  if (!stat) {
    const temporary = path.join(directory, `.copy-${path.basename(path.dirname(previous.snapshot))}`);

    try {
      await copyInstallCandidate(previous.snapshot, temporary);

      if (await sha256File(temporary) !== previous.digest) {
        throw new Error('Резервная копия DeepSeek не совпала с предыдущим ELF');
      }

      await fs.rename(temporary, file);
      await syncDirectory(directory);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  const saved = await fs.lstat(file);

  if (!saved.isFile() || await sha256File(file) !== previous.digest) {
    throw new Error('Резервная копия DeepSeek не прошла проверку SHA');
  }

  return file;
}

/**
 * Перед заменой перечитывается установленная команда: внешний писатель не теряется молча.
 * Проверенная новая SHA добавляется заранее, поэтому при сбое A и B остаются распознаваемыми.
 */
export async function approveInstall(
  previous: PreviousInstall,
  digest: string,
  stage: string,
): Promise<void> {
  const target = previous.receipt.target;
  const stat = await statOrNull(target);

  if (previous.digest === null ? stat !== null : !stat?.isFile()
    || await sha256File(target) !== previous.digest) {
    throw new Error('Установленный DeepSeek изменился во время проверки candidate');
  }

  const file = path.join(stage, 'receipt.json');
  const handle = await fs.open(file, 'wx', 0o600);

  try {
    await handle.writeFile(JSON.stringify({
      ...previous.receipt,
      approved: [...new Set([...previous.receipt.approved, digest])],
    }));
    await handle.sync();
  } finally {
    await handle.close();
  }

  await fs.rename(file, `${target}.grigdesk-deepseek.json`);
  await syncDirectory(path.dirname(target));
}
