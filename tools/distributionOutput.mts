import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Публикует готовый файл или комплект в отдельной папке запуска.
 * На другом томе сначала копирует под временным именем и только потом открывает итоговый путь.
 */
export async function publishDistributionOutput(source: string, destination: string): Promise<void> {
  const directory = path.dirname(destination);
  const partial = path.join(directory, '.partial');

  await fs.mkdir(directory, { mode: 0o700 });

  try {
    try {
      await fs.rename(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
        throw error;
      }

      await fs.cp(source, partial, { recursive: true });
      await fs.rename(partial, destination);
      await fs.rm(source, { recursive: true });
    }
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });

    throw error;
  }
}
