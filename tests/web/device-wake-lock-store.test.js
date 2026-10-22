import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STORE_URL = pathToFileURL(fileURLToPath(
  new URL('../../web/src/stores/device.ts', import.meta.url),
)).href;
// Vue фиксирует наличие document при импорте runtime-dom. Загружаем Pinia до установки
// нашего минимального fake document: самому стору DOM-рендерер не нужен.
const { createPinia, setActivePinia } = await import(
  '../../web/node_modules/pinia/dist/pinia.mjs'
);
let fixtureId = 0;

class FakeDocument extends EventTarget {
  visibilityState = 'visible';

  setVisibility(state) {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

class FakeWakeLock extends EventTarget {
  released = false;

  async release() {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event('release'));
  }
}

async function fixture(t, { supported = true, saved = false } = {}) {
  const document = new FakeDocument();
  const values = new Map(saved ? [['grigdesk-screen-wake-lock', '1']] : []);
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  const locks = [];
  const navigator = supported ? {
    wakeLock: {
      async request(kind) {
        assert.equal(kind, 'screen');
        const lock = new FakeWakeLock();
        locks.push(lock);
        return lock;
      },
    },
  } : {};

  for (const [key, value] of Object.entries({ document, localStorage, navigator })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  t.after(() => {
    for (const key of ['document', 'localStorage', 'navigator']) delete globalThis[key];
  });

  const { useDeviceStore } = await import(`${STORE_URL}?wake-lock-test=${fixtureId += 1}`);
  setActivePinia(createPinia());
  const store = useDeviceStore();
  store.initWakeLock();
  return { store, document, values, locks };
}

test('Screen Wake Lock включается глобальной настройкой и сохраняется на устройстве', async (t) => {
  const { store, values, locks } = await fixture(t);

  assert.equal(await store.setWakeLockEnabled(true), true);
  assert.equal(store.wakeLockActive, true);
  assert.equal(values.get('grigdesk-screen-wake-lock'), '1');
  assert.equal(locks.length, 1);
});

test('Screen Wake Lock снимается в фоне и восстанавливается при возврате', async (t) => {
  const { store, document, locks } = await fixture(t, { saved: true });
  await new Promise(setImmediate);
  assert.equal(store.wakeLockActive, true);
  assert.equal(locks.length, 1);

  document.setVisibility('hidden');
  await new Promise(setImmediate);
  assert.equal(locks[0].released, true);
  assert.equal(store.wakeLockActive, false);

  document.setVisibility('visible');
  await new Promise(setImmediate);
  assert.equal(locks.length, 2);
  assert.equal(store.wakeLockActive, true);
});

test('выключение Screen Wake Lock освобождает экран и не теряется при отсутствии API', async (t) => {
  const { store, values, locks } = await fixture(t, { saved: true });
  await new Promise(setImmediate);

  assert.equal(await store.setWakeLockEnabled(false), true);
  assert.equal(locks[0].released, true);
  assert.equal(store.wakeLockActive, false);
  assert.equal(values.get('grigdesk-screen-wake-lock'), '0');

  const unsupported = await fixture(t, { supported: false });
  assert.equal(unsupported.store.wakeLockSupported, false);
  assert.equal(await unsupported.store.setWakeLockEnabled(true), false);
  assert.equal(unsupported.store.wakeLockActive, false);
});


test('возможности устройства не управляют обновлением документа', async (t) => {
  const { store } = await fixture(t);

  for (const key of ['needRefresh', 'doUpdate', 'checkForUpdate']) {
    assert.equal(key in store, false);
  }
});
