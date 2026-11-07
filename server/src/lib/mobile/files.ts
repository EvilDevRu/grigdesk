import { promises as fs } from 'node:fs';

import { MobileInputError } from './errors.ts';

export { writeDurableFile as privateWrite } from '../durableFile.ts';

const locks = new Map<string, Promise<unknown>>();

/**
 * Сериализует операции одного файла, включая неуспешные записи.
 * Хвост удаляется после завершения, чтобы идентификаторы не накапливались в памяти.
 */
export function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(operation, operation);
  const tail = next.then(
    () => {},
    () => {},
  );

  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) {
      locks.delete(key);
    }
  });

  return next;
}

/**
 * Отсутствующий файл отличается от повреждённого JSON.
 * Ошибка чтения никогда не превращается в новый пустой список привязок.
 */
export async function privateRead(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw new MobileInputError(
      'mobile_store_corrupt',
      'Не удалось прочитать настройки мобильного доступа.',
      503,
    );
  }
}
