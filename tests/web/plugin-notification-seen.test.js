import assert from 'node:assert/strict';
import test from 'node:test';

import { api } from '../../web/src/shared/apiClient.ts';
import { pluginCard } from './helpers/pluginModuleContract.js';
import { serviceFixture } from './helpers/pluginModuleServices.js';

/**
 * Миграция проходит настоящий bridge до первой доставки live исхода.
 * Подменён только HTTP снимка, storage и общий центр принадлежат браузерной фикстуре.
 */
async function migrationFixture(t, owner = 'ownerA') {
  const f = await serviceFixture(t, 'pluginRuntime/serverNotifications.ts');
  const signal = new AbortController();
  let toasts = [];
  const off = f.ui.subscribeToasts((value) => toasts = value);

  t.mock.method(api, 'get', async () => ({ plugins: [] }));
  t.after(() => {
    signal.abort();
    off();
    f.ui.dismissAllToasts();
  });

  const start = () => {
    const bridge = f.createServerNotificationBridge({
      owner,
      clientScope: owner,
      signal: signal.signal,
      isCurrent: () => true,
    });

    bridge.acceptCatalog([pluginCard({ id: 'studio3d', runtimeGeneration: 'generation' })]);

    return bridge;
  };
  const emit = (bridge, key) => bridge.onEvent('plugin-event', {
    pluginId: 'studio3d',
    generation: 'generation',
    event: 'notification',
    data: {
      action: 'show',
      id: key,
      topic: 'model:test',
      dedupKey: key,
      title: { ru: 'Готово', en: 'Ready' },
      sticky: true,
    },
  });

  return {
    ...f,
    start,
    emit,
    signal,
    toasts: () => toasts,
    source: `grigdesk-studio3d-seen:${owner}`,
    target: `grigdesk-plugin-notifications-seen:${owner}:studio3d`,
    marker: `grigdesk-plugin-notifications-seen-imported:${owner}:studio3d`,
  };
}

test('PN-SEEN: legacy union до live/snapshot, bounded500, исходный ключ сохранён', async (t) => {
  const f = await migrationFixture(t);
  const source = JSON.stringify(Array.from({ length: 501 }, (_, index) => `old${index}`));

  localStorage.setItem(f.source, source);
  localStorage.setItem(f.target, JSON.stringify(['new']));

  const bridge = f.start();

  f.emit(bridge, 'old500');
  assert.equal(f.toasts().length, 0);
  assert.equal(localStorage.getItem(f.source), source);
  assert.equal(JSON.parse(localStorage.getItem(f.target)).length, 500);
  assert.equal(localStorage.getItem(f.marker), '1');
  f.emit(bridge, 'new');
  assert.equal(f.toasts().length, 0);
  bridge.dispose();

  const next = f.start();

  f.emit(next, 'old500');
  assert.equal(f.toasts().length, 0);
});

for (const failed of ['target', 'marker']) {
  test(`PN-SEEN: отказ ${failed} не теряет union и не создаёт ложный marker`, async (t) => {
    const f = await migrationFixture(t);

    localStorage.setItem(f.source, '["old"]');

    const write = localStorage.setItem.bind(localStorage);

    t.mock.method(localStorage, 'setItem', (key, value) => {
      if (key === f[failed]) {
        throw new Error('Storage fixture denied');
      }

      write(key, value);
    });

    const bridge = f.start();

    f.emit(bridge, 'old');
    assert.equal(f.toasts().length, 0);
    assert.equal(localStorage.getItem(f.marker), null);
    assert.equal(localStorage.getItem(f.source), '["old"]');
    bridge.dispose();

    const next = f.start();

    f.emit(next, 'old');
    assert.equal(f.toasts().length, 0);
  });
}

test('PN-SEEN: другой владелец не читает прежний namespace', async (t) => {
  const f = await migrationFixture(t, 'ownerB');

  localStorage.setItem('grigdesk-studio3d-seen:ownerA', '["old"]');

  const reads = [];
  const read = localStorage.getItem.bind(localStorage);

  t.mock.method(localStorage, 'getItem', (key) => {
    reads.push(key);

    return read(key);
  });

  const bridge = f.start();

  f.emit(bridge, 'old');
  assert.equal(f.toasts().length, 1);
  assert.equal(reads.some((key) => key.includes('ownerA')), false);
});
