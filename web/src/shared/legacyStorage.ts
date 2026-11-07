import { LEGACY } from '../../../shared/runtime/legacyBrand.ts';

type StorageLike = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Перенос ключей выполняется до создания сторов интерфейса.
 * Новое значение сильнее старого; недоступное хранилище не мешает запуску приложения.
 */
export function migrateStoragePrefix(
  storage: StorageLike | null, oldPrefix: string, newPrefix: string,
): void {
  try {
    if (!storage || oldPrefix === newPrefix) {
      return;
    }

    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => key !== null && key.startsWith(oldPrefix));

    for (const key of keys) {
      const target = newPrefix + key.slice(oldPrefix.length);
      const value = storage.getItem(key);

      if (value !== null && storage.getItem(target) === null) {
        storage.setItem(target, value);
      }

      storage.removeItem(key);
    }
  } catch {
    // Политика браузера может запрещать даже чтение length или отдельного ключа.
  }
}

try {
  migrateStoragePrefix(globalThis.localStorage, LEGACY.storagePrefix, 'grigdesk-');
} catch {
  // Сам getter localStorage также может бросить до входа в функцию переноса.
}
