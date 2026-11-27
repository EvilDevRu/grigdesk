import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

export const QWEN_PREVIEW_VERSION = '1.0.0-preview.2';
export const QWEN_PREVIEW_SUPPORTED = process.platform === 'linux' && process.arch === 'x64';

const linuxX64 = {
  size: 157578720,
  sha256: 'f446b996d490d3d408edff32326be528ecf5644a5cdb0b0436495d0329f4da31',
};

export const qwenPreviewBinary = (dataHome: string): string =>
  path.join(dataHome, 'runtimes', 'qwen-code', QWEN_PREVIEW_VERSION, 'qwen');

/**
 * Решение о запуске основано на байтах проверенного поставленного ELF.
 * Версия в stdout и имя программы не дают права применять managed policy.
 */
export async function verifyQwenPreviewBinary(file: string) {
  if (!QWEN_PREVIEW_SUPPORTED || !path.isAbsolute(file)) {
    throw new Error('Qwen Preview.2: проверенная поставка доступна для Linux x64.');
  }

  const physical = await fs.realpath(file);
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const descriptor = await fs.open(physical, flags);

  try {
    const before = await descriptor.stat();

    if (!before.isFile() || before.size !== linuxX64.size
      || (before.mode & 0o222) !== 0 || (before.mode & 0o111) === 0) {
      throw new Error('Qwen Preview.2: требуется проверенный ELF с правами только чтения и запуска.');
    }

    const hash = createHash('sha256');

    for await (const chunk of descriptor.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }

    const after = await fs.lstat(physical);

    if (hash.digest('hex') !== linuxX64.sha256 || before.dev !== after.dev || before.ino !== after.ino
      || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Qwen Preview.2: контрольная сумма исполняемого файла не подтверждена.');
    }

    return { physical, descriptor };
  } catch (error) {
    await descriptor.close();

    throw error;
  }
}
