import type { BigIntStats } from 'node:fs';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { acquireDirectoryLock, type DirectoryLockOptions } from './directoryLock.ts';
import { syncDirectory } from './files.ts';
import { sha256File } from './hash.ts';

export interface InstallReceipt {
  format: 1;
  target: string;
  approved: string[];
}

export interface PreviousInstall {
  receipt: InstallReceipt;
  digest: string | null;
  snapshot: string | null;
}

interface CopyOptions {
  validateSource?: (input: FileHandle) => Promise<void>;
  failure?: (phase: 'source' | 'read' | 'write') => Error;
}

interface ReceiptPolicy {
  target: string;
  suffix: string;
  modeAllowed: (mode: number) => boolean;
  exactKeys?: boolean;
  invalid: () => Error;
}

/**
 * Отсутствующий путь отличается от ошибки доступа и от самой символической ссылки.
 * Установщик не должен считать dangling symlink отсутствующим target или receipt.
 */
export async function lstatOrNull(file: string) {
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
 * Источник открывается один раз как ordinary file, закрытая копия получает fsync и 0555.
 * Потребитель проверяет свой формат через открытый fd до создания выходного файла.
 */
export async function copyInstallFile(
  source: string,
  target: string,
  options: CopyOptions = {},
): Promise<void> {
  const input = await fs.open(source, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  const failure = options.failure ?? (() => new Error('Не удалось скопировать обычный файл установки'));
  let output;

  try {
    const stat = await input.stat();

    if (!stat.isFile() || stat.size === 0) {
      throw failure('source');
    }

    await options.validateSource?.(input);

    output = await fs.open(target, 'wx', 0o600);

    const buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;

    while (offset < stat.size) {
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);

      if (bytesRead === 0) {
        throw failure('read');
      }

      let written = 0;

      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written);

        if (result.bytesWritten === 0) {
          throw failure('write');
        }

        written += result.bytesWritten;
      }

      offset += bytesRead;
    }

    await output.chmod(0o555);
    await output.sync();
  } finally {
    try {
      await output?.close();
    } finally {
      await input.close();
    }
  }
}

/**
 * Fingerprint и SHA связывают все пробы с одним staged inode и его байтами.
 * Перечень stat-полей передаёт потребитель, сохраняя прежние различия контракта.
 */
export async function assertInstallFileUnchanged(
  binary: string,
  stamp: BigIntStats,
  digest: string,
  options: { invalid: () => Error; fields?: readonly string[] },
): Promise<void> {
  const checked = await fs.lstat(binary, { bigint: true });
  const fields = options.fields ?? ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs'];

  if (!checked.isFile() || (checked.mode & 0o777n) !== 0o555n
    || fields.some((field) => Reflect.get(checked, field) !== Reflect.get(stamp, field))
    || await sha256File(binary) !== digest) {
    throw options.invalid();
  }
}

/**
 * Receipt открывается без следования ссылке, uid/mode сверяются с фактическим fd.
 * Закрытость полей и допустимые права задаёт потребитель, SHA/target binding общие.
 */
export async function readInstallReceipt(policy: ReceiptPolicy): Promise<InstallReceipt> {
  const file = `${policy.target}${policy.suffix}`;
  const stat = await lstatOrNull(file);

  if (!stat) {
    return {
      format: 1,
      target: policy.target,
      approved: [],
    };
  }

  if (!stat.isFile() || stat.uid !== process.getuid!() || !policy.modeAllowed(stat.mode & 0o777)) {
    throw policy.invalid();
  }

  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let receipt;

  try {
    const opened = await handle.stat();

    if (!opened.isFile() || opened.uid !== process.getuid!() || !policy.modeAllowed(opened.mode & 0o777)
      || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw policy.invalid();
    }

    receipt = JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }

  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || policy.exactKeys && Object.keys(receipt).sort().join(',') !== 'approved,format,target'
    || receipt.format !== 1 || receipt.target !== policy.target || !Array.isArray(receipt.approved)
    || !receipt.approved.every((digest: unknown) => typeof digest === 'string'
      && /^[a-f0-9]{64}$/u.test(digest))) {
    throw policy.invalid();
  }

  return receipt;
}

/**
 * Прежние байты копируются без исполнения и признаются только по approved SHA.
 * Backup и чтение metadata старого runtime остаются ответственностью потребителей.
 */
export async function snapshotInstalledFile(receipt: InstallReceipt, stage: string, options: {
  copy: (source: string, target: string) => Promise<void>;
  unknownTarget: () => Error;
}): Promise<PreviousInstall> {
  const stat = await lstatOrNull(receipt.target);

  if (!stat) {
    return {
      receipt,
      digest: null,
      snapshot: null,
    };
  }

  if (!stat.isFile() || stat.uid !== process.getuid!()) {
    throw options.unknownTarget();
  }

  const snapshot = path.join(stage, 'previous');

  await options.copy(receipt.target, snapshot);

  const digest = await sha256File(snapshot);

  if (!receipt.approved.includes(digest)) {
    throw options.unknownTarget();
  }

  return {
    receipt,
    digest,
    snapshot,
  };
}

/**
 * CAS прежнего target предшествует атомарной записи квитанции с новым approved SHA.
 * Fsync и rename receipt завершаются до публикации executable; A и B распознаются при retry.
 */
export async function approveInstallReceipt(
  previous: Pick<PreviousInstall, 'receipt' | 'digest'>,
  digest: string,
  stage: string,
  options: {
    suffix: string;
    mode: number;
    changed: () => Error;
  },
): Promise<void> {
  const target = previous.receipt.target;
  const stat = await lstatOrNull(target);

  if (previous.digest === null ? stat !== null : !stat?.isFile()
    || await sha256File(target) !== previous.digest) {
    throw options.changed();
  }

  const file = path.join(stage, 'receipt.json');
  const handle = await fs.open(file, 'wx', options.mode);

  try {
    await handle.writeFile(JSON.stringify({
      ...previous.receipt,
      approved: [...new Set([...previous.receipt.approved, digest])],
    }));
    await handle.sync();
  } finally {
    await handle.close();
  }

  await fs.rename(file, `${target}${options.suffix}`);
  await syncDirectory(path.dirname(target));
}

/**
 * Все установщики сериализуют target одинаковым PID/starttime/token lock.
 * Возвращённый handle снимает только своё владение; stage cleanup остаётся у потребителя.
 */
export async function acquireInstallLock(target: string, options: DirectoryLockOptions = {}) {
  return acquireDirectoryLock(`${target}.install-lock`, { waitMs: 120000, ...options });
}
