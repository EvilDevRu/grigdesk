import { createHash } from 'node:crypto';
import { promises as fs, realpathSync, statSync } from 'node:fs';

/**
 * Синхронный spawn проверяет тот же физический файл без окна между await и запуском.
 * Формула совпадает с асинхронной подготовкой и остаётся внутренней identity сервера.
 */
export function executableIdentitySync(file: string): string {
  const realpath = realpathSync(file);
  const stat = statSync(realpath);

  if (!stat.isFile()) {
    throw new Error('Исполняемый путь не является файлом');
  }

  return createHash('sha256').update(JSON.stringify([
    realpath, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs,
  ])).digest('hex');
}

/**
 * Выбор программы связывается с её физическим файлом до и после захвата reader.
 * Это закрывает смену ссылки/файла между подготовкой адаптера и запуском helper-а.
 */
export async function executableIdentity(file: string): Promise<string> {
  const realpath = await fs.realpath(file);
  const stat = await fs.stat(realpath);

  if (!stat.isFile()) {
    throw new Error('Исполняемый путь не является файлом');
  }

  return createHash('sha256').update(JSON.stringify([
    realpath, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs,
  ])).digest('hex');
}
