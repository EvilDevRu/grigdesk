// Fixture использует только публичную прежнюю схему browser pending, без product source импортов.
// Настоящий fake-indexeddb6.2.7 сохраняет одни и те же records между background/panel/child contexts.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { serialize } from 'node:v8';

import { webFile } from './compile-vue.js';

/**
 * Зависимость берётся из development окружения ядра, версия явно сверяется до fixture эффектов.
 * Рабочее дерево плагина/SDK/его helpers не участвуют в чтении или записи IndexedDB.
 */
export async function createStudioBrowserStorage(t, suppliedFactory) {
  const require = createRequire(webFile('package.json'));
  const modulePath = require.resolve('fake-indexeddb');
  const metadata = JSON.parse(await readFile(new URL('../../package.json', pathToFileURL(modulePath))));

  assert.equal(metadata.version, '6.2.7');

  const { IDBFactory } = await import(pathToFileURL(modulePath).href);
  const factory = suppliedFactory ?? new IDBFactory();
  let opening;
  let opened;

  /**
   * Старое и новое окно используют DB1/intents без migration/reset данных.
   * Чтение schema не фильтрует записи: проверка stale сохранности видит каждый исходный байт.
   */
  const database = () => {
    opening ??= new Promise((resolve, reject) => {
      const request = factory.open('grigdesk-studio3d-intents', 1);

      request.onupgradeneeded = () => request.result.createObjectStore('intents', { keyPath: 'key' });
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Fixture browser DB заблокирована.'));
      request.onsuccess = () => {
        opened = request.result;
        resolve(opened);
      };
    });

    return opening;
  };

  t.after(() => opened?.close());

  /**
   * Completion, а не request success, подтверждает долговечность fixture write.
   * Все операции выполняются настоящей IDB transaction без Map storage double.
   */
  async function transaction(mode, action) {
    const databaseHandle = await database();

    return new Promise((resolve, reject) => {
      const tx = databaseHandle.transaction('intents', mode, { durability: 'strict' });
      let result;

      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('Fixture IDB transaction error'));
      tx.onabort = () => reject(tx.error ?? new Error('Fixture IDB transaction aborted'));

      const request = action(tx.objectStore('intents'));

      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error);
    });
  }

  const all = async () => transaction('readonly', store => store.getAll());

  return {
    factory,
    all,
    list: async owner => (await all()).filter(record => record.owner === owner),
    put: async record => {
      await transaction('readwrite', store => store.put(structuredClone(record)));
    },
    remove: async key => {
      await transaction('readwrite', store => store.delete(key));
    },
    bytes: async owner => Buffer.from(serialize((await all()).filter(record => record.owner === owner))),
    close: () => opened?.close(),
  };
}
