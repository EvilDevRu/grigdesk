import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

export interface WindowAuthState {
  origin: string;
  key: string | null;
}

function missingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/**
 * Проверяется только непосредственный каталог ключа, без обхода его предков.
 * Чужие права не исправляются, отсутствующий каталог создаётся одним mkdir.
 */
async function privateDirectory(directory: string, uid: number): Promise<void> {
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EEXIST') {
      throw error;
    }
  }

  const stat = await fs.lstat(directory);

  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o700) {
    throw new Error('Каталог ключа окна не является личным каталогом 0700.');
  }
}

/**
 * Существующий ключ допускает только собственный обычный файл с правами 0600.
 * Ссылка или каталог отвергаются до создания временного файла и без усечения цели.
 */
async function replaceableKey(file: string, uid: number): Promise<void> {
  try {
    const stat = await fs.lstat(file);

    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600) {
      throw new Error('Файл ключа окна не является собственным обычным файлом 0600.');
    }
  } catch (error) {
    if (!missingFile(error)) {
      throw error;
    }
  }
}

/**
 * Writer возвращает ключ только после полной атомарной публикации собственного файла.
 * Серверный lifecycle отдельно решает, когда разрешено начинать эту запись.
 */
export async function writeWindowKey(file: string): Promise<string> {
  const uid = process.getuid?.();

  if (uid === undefined) {
    throw new Error('Не удалось определить владельца ключа окна.');
  }

  const directory = path.dirname(file);

  await privateDirectory(directory, uid);
  await replaceableKey(file, uid);

  const key = randomBytes(32).toString('base64url');
  const temporary = path.join(directory, `.window-key-${randomBytes(16).toString('hex')}.tmp`);
  let handle: FileHandle | undefined;
  let created = false;

  try {
    handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    created = true;
    await handle.writeFile(key, 'utf8');
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
    created = false;

    return key;
  } finally {
    await handle?.close().catch(() => undefined);

    if (created) {
      await fs.unlink(temporary);
    }
  }
}

/**
 * Только успешный listen разрешает публикацию ключа выбранного порта.
 * Ошибка writer оставляет вход недоступным и не закрывает работающий сервер.
 */
export function registerWindowKeyLifecycle(
  fastify: FastifyInstance,
  state: WindowAuthState,
  file: string | null,
  writer: (file: string) => Promise<string> = writeWindowKey,
): void {
  fastify.addHook('onListen', async () => {
    state.key = null;

    if (file === null) {
      return;
    }

    try {
      state.key = await writer(file);
    } catch {
      state.key = null;
      fastify.log.warn('Ключ окна недоступен: не удалось опубликовать файл.');
    }
  });
}
