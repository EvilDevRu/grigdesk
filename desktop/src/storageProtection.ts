import type { safeStorage } from 'electron';

type Storage = Pick<typeof safeStorage, 'isEncryptionAvailable' | 'getSelectedStorageBackend'>;

/**
 * Persistent session разрешена только с защищённой системной связкой ключей.
 * Проверка выполняется до создания профиля, без открытого запасного хранения.
 */
export function requireProtectedStorage(storage: Storage): void {
  try {
    if (!storage.isEncryptionAvailable() || typeof storage.getSelectedStorageBackend !== 'function') {
      throw new Error('Защищённое хранилище недоступно.');
    }

    const backend = storage.getSelectedStorageBackend();

    if (!['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend)) {
      throw new Error('Backend не защищает данные на диске.');
    }
  } catch {
    throw new Error('Для окна требуется доступное защищённое хранилище ОС.');
  }
}
