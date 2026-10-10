import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Публикует приватный файл атомарно после fsync содержимого и каталога.
 * Внешний эффект или ACK разрешены лишь после устойчивого rename.
 */
export async function writeDurableFile(file: string, text: string | Buffer): Promise<void> {
  const directory = path.dirname(file);

  await fs.mkdir(directory, {
    recursive: true,
    mode: 0o700,
  });
  await fs.chmod(directory, 0o700);

  const temporary = path.join(
    directory,
    `.${path.basename(file)}-${randomBytes(8).toString('hex')}.tmp`,
  );
  const handle = await fs.open(temporary, 'wx', 0o600);

  try {
    await handle.writeFile(text);
    await handle.sync();
    await handle.close();
    await fs.rename(temporary, file);

    const parent = await fs.open(directory, 'r');

    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}
