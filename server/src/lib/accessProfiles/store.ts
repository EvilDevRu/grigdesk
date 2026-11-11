import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { dataHome } from '../../../../shared/runtime/dataHome.ts';
import { acquireDirectoryLock } from '../../../../shared/node/directoryLock.ts';
import { writeDurableFile } from '../durableFile.ts';
import type { AccessConfig, AccessManifest, AccessOptions } from './types.ts';

/**
 * Частичная конфигурация сохраняет каноническую папку данных приложения.
 * Отсутствующее поле никогда не превращается в относительный каталог внутри исходников.
 */
export function accessStateDirectory(config: AccessConfig): string {
  const root = config.dataHome ?? dataHome({ env: process.env, home: os.homedir() });

  return String(config.stateDir ?? path.join(String(root), 'state'));
}

/**
 * Приватное чтение не следует ссылкам и ограничивает размер файла.
 * Ошибка прав или формата не превращается в пустое хранилище.
 */
export async function readPrivate<T>(file: string): Promise<T | null> {
  let handle;

  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);

    const stat = await handle.stat();

    if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('Небезопасное хранилище доступа');
    }

    return JSON.parse(await handle.readFile('utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  } finally {
    await handle?.close();
  }
}

export class AccessStore {
  readonly root: string;
  readonly options: AccessOptions;

  constructor(config: AccessConfig, options: AccessOptions = {}) {
    this.root = path.join(accessStateDirectory(config), 'access-profiles');
    this.options = options;
  }

  /**
   * Namespace строится только из проверенного сервером идентификатора адаптера.
   * Пользовательские имена и идентификаторы файлов в путь не подставляются.
   */
  directory(provider: string): string {
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(provider)) {
      throw new Error('Недопустимый исполнитель');
    }

    return path.join(this.root, provider);
  }

  /**
   * Один короткий mutex защищает manifest, reservations и выбор снимка.
   * Сеть и ожидание пользовательского кода выполняются после освобождения mutex.
   */
  async locked<T>(provider: string, action: () => Promise<T>): Promise<T> {
    const directory = this.directory(provider);

    await fs.mkdir(directory, { recursive: true, mode: 0o700 });

    for (const location of [this.root, directory]) {
      const stat = await fs.lstat(location);

      if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
        throw new Error('Небезопасный каталог доступа');
      }

      await fs.chmod(location, 0o700);
    }

    const lock = await acquireDirectoryLock(path.join(directory, 'mutex'));

    try {
      return await action();
    } finally {
      await lock.release();
    }
  }

  read(provider: string): Promise<AccessManifest | null> {
    return readPrivate(path.join(this.directory(provider), 'manifest.json'));
  }

  /**
   * Единственный commit manifest публикует профиль, попытку и ответ операции вместе.
   * После него восстановление не требует повторять внешнюю проверку ключа.
   */
  async write(provider: string, manifest: AccessManifest, commit = false): Promise<void> {
    await writeDurableFile(path.join(this.directory(provider), 'manifest.json'), JSON.stringify(manifest));

    if (commit) {
      this.options.fault?.('after-manifest-commit');
    }
  }

  /**
   * Ревизия секрета неизменяема и становится достижимой лишь через manifest.
   * Отказ до commit оставляет прежнюю ревизию и активный профиль доступными.
   */
  async secret(provider: string, value: NodeJS.ProcessEnv): Promise<string> {
    const ref = randomUUID();

    for (const point of ['write', 'fsync', 'rename']) {
      this.options.fault?.(point);
    }

    await writeDurableFile(path.join(this.directory(provider), `${ref}.json`), JSON.stringify(value));

    return ref;
  }

  /**
   * Ссылку на секрет выдаёт только manifest, а не пользовательский запрос.
   * Исчезнувшая ревизия приводит к отказу, без подстановки доступа из общего env.
   */
  async credentials(provider: string, ref: string): Promise<NodeJS.ProcessEnv> {
    if (!/^[a-f0-9-]{36}$/u.test(ref)) {
      throw new Error('Недопустимая ревизия доступа');
    }

    const value = await readPrivate<NodeJS.ProcessEnv>(path.join(this.directory(provider), `${ref}.json`));

    if (!value) {
      throw new Error('Ревизия доступа недоступна');
    }

    return value;
  }
}
