import { constants } from 'node:fs';
import fs from 'node:fs/promises';

export { removePrivateTree as removeInstallStage } from '../../shared/node/files.ts';

/**
 * Источник открывается один раз и должен быть обычным файлом, а не FIFO или устройством.
 * После закрытия копии все проверки относятся только к ней; источник больше не нужен.
 */
export async function copyInstallCandidate(source: string, target: string): Promise<void> {
  const input = await fs.open(source, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  let output;

  try {
    const stat = await input.stat();

    if (!stat.isFile() || stat.size === 0) {
      throw new Error('Candidate DeepSeek должен быть непустым обычным файлом');
    }

    output = await fs.open(target, 'wx', 0o600);

    const buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;

    while (offset < stat.size) {
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);

      if (bytesRead === 0) {
        throw new Error('Копирование candidate DeepSeek оборвалось');
      }

      let written = 0;

      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written);

        if (result.bytesWritten === 0) {
          throw new Error('Запись candidate DeepSeek оборвалась');
        }

        written += result.bytesWritten;
      }

      offset += bytesRead;
    }

    await output.chmod(0o555);
    await output.sync();
  } finally {
    await output?.close();
    await input.close();
  }
}

