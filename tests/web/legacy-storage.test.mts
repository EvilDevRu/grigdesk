import { migrationUrl } from './helpers/compile-vue.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { Window } from '../../web/node_modules/happy-dom/lib/index.js';
import { LEGACY } from '../../shared/runtime/legacyBrand.ts';
import { migrateStoragePrefix } from '../../web/src/shared/legacyStorage.ts';

test('GW-01: настройки переносятся без перезаписи новых и без повторного эффекта', () => {
  const window = new Window();
  const storage = window.localStorage;

  storage.setItem(`${LEGACY.storagePrefix}dock-width`, '300');
  storage.setItem(`${LEGACY.storagePrefix}chat-v2`, 'saved');
  storage.setItem('grigdesk-dock-width', '420');
  storage.setItem('unrelated', 'kept');
  window.sessionStorage.setItem(`${LEGACY.storagePrefix}chat-v2`, 'session');
  migrateStoragePrefix(storage, LEGACY.storagePrefix, 'grigdesk-');
  assert.equal(storage.getItem('grigdesk-dock-width'), '420');
  assert.equal(storage.getItem('grigdesk-chat-v2'), 'saved');
  assert.equal(storage.getItem(`${LEGACY.storagePrefix}dock-width`), null);
  assert.equal(storage.getItem(`${LEGACY.storagePrefix}chat-v2`), null);
  assert.equal(storage.getItem('unrelated'), 'kept');
  assert.equal(window.sessionStorage.getItem(`${LEGACY.storagePrefix}chat-v2`), 'session');
  migrateStoragePrefix(storage, LEGACY.storagePrefix, 'grigdesk-');
  assert.equal(storage.length, 3);

  const denied = new Proxy(storage, {
    get() {
      throw new Error('storage unavailable');
    },
  });

  assert.doesNotThrow(() => migrateStoragePrefix(denied, LEGACY.storagePrefix, 'grigdesk-'));
  assert.doesNotThrow(() => migrateStoragePrefix(null, LEGACY.storagePrefix, 'grigdesk-'));
});

test('GW-02: перенос импортируется до создания приложения', () => {
  const source = readFileSync(migrationUrl('src/main.ts'), 'utf8');

  const migration = source.indexOf("import './shared/legacyStorage.ts';");
  const bootstrap = source.indexOf('const app = createApp(App)');

  assert.ok(migration >= 0 && bootstrap > migration);
});
