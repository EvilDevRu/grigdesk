// Намерение сохраняется до HTTP: перезагрузка не создаёт новый UUID оплаты.
// База содержит только снимки запросов окна, без ключей и токенов исполнителя.
import type { PendingStudioIntent, PendingStudioStorage } from './pendingIntentTypes.ts';

export type { PendingStudioIntent, PendingStudioStorage } from './pendingIntentTypes.ts';

/**
 * Канонический JSON отличает новый снимок формы от повтора прежнего нажатия.
 * Порядок ключей объекта не меняет identity, порядок строк и видов сохраняется.
 */
export function studioFingerprint(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(studioFingerprint).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${studioFingerprint(object[key])}`).join(',')}}`;
  }
  
  return JSON.stringify(value) ?? 'null';
}

/**
 * Запись считается durable после transaction complete, а не после put success.
 * Недоступная IndexedDB закрывает отправку: volatile fallback не подтверждает оплату.
 */
export function createStudioPending(factory?: IDBFactory): PendingStudioStorage {
  let opening: Promise<IDBDatabase> | null = null;
  const database = () => {
    if (opening) {
      return opening;
    }
    
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const indexed = factory ?? globalThis.indexedDB;
      
      if (!indexed) {
        reject(new Error('Не удалось сохранить намерение 3D. Проверьте доступ к хранилищу браузера.'));
        
        return;
      }
      
      const request = indexed.open('grigdesk-studio3d-intents', 1);
      
      request.onupgradeneeded = () => {
        request.result.createObjectStore('intents', { keyPath: 'key' });
      };
      request.onerror = () => reject(new Error('Хранилище намерений 3D недоступно.'));
      request.onblocked = () => reject(new Error('Закройте другую вкладку для обновления хранилища 3D.'));
      request.onsuccess = () => {
        const db = request.result;
        
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      };
    }).catch((error) => {
      opening = null;
      
      throw error;
    });
    
    return opening;
  };
  const write = async (work: (store: IDBObjectStore) => void): Promise<void> => {
    const db = await database();
    
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('intents', 'readwrite', { durability: 'strict' });
      
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('Не удалось сохранить намерение 3D.'));
      transaction.onabort = () => reject(new Error('Сохранение намерения 3D отменено.'));
      work(transaction.objectStore('intents'));
    });
  };

  return {
    list: async (owner) => {
      const db = await database();
      const rows = await new Promise<PendingStudioIntent[]>((resolve, reject) => {
        const request = db.transaction('intents', 'readonly').objectStore('intents').getAll();
        
        request.onsuccess = () => resolve(request.result as PendingStudioIntent[]);
        request.onerror = () => reject(new Error('Не удалось прочитать намерения 3D.'));
      });
      
      return rows.filter((record) => record.owner === owner && ['run', 'retry', 'batch'].includes(record.kind)
        && typeof record.libraryId === 'string' && typeof record.key === 'string'
        && record.request?.idempotencyKey === record.key && record.request?.libraryId === record.libraryId);
    },
    put: (record) => write((store) => {
      store.put(structuredClone(record));
    }),
    remove: (key) => write((store) => {
      store.delete(key);
    }),
  };
}

export const studioPending = createStudioPending();
