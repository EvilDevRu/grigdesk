import assert from 'node:assert/strict';
import test from 'node:test';
import { serviceFixture } from './helpers/pluginModuleServices.js';

/**
 * Настоящий центр связывает тосты, историю и системные уведомления.
 * Подменён только внешний системный канал; области и идентификаторы строит продукт.
 */
async function alertsFixture(t) {
  const closed = [];
  const shown = [];

  globalThis.__pluginNotifications = { closed, shown };
  t.after(() => delete globalThis.__pluginNotifications);

  const f = await serviceFixture(t, 'pluginRuntime/alerts.ts', {}, {
    './notify.ts': `
      const channel = globalThis.__pluginNotifications;
      export const notify = (...args) => {
        channel.shown.push(args);
        return Promise.resolve(true);
      };
      export const closeSystemNotification = (id) => {
        channel.closed.push(id);
        return Promise.resolve();
      };
    `,
  });
  let toasts = [];
  const off = f.ui.subscribeToasts((value) => toasts = value);

  t.mock.method(document, 'hasFocus', () => false);
  t.after(() => {
    off();
    f.ui.dismissAllToasts();
  });

  return {
    ...f,
    closed,
    shown,
    toasts: () => toasts
  };
}

test('PM-ALERT-OWNERS: id/scope/target замкнуты, clear/disable гасят только свой канал', async (t) => {
  const f = await alertsFixture(t);
  const first = new AbortController();
  const second = new AbortController();
  const a = f.createPluginAlerts('a b', { signal: first.signal, isAlive: () => !first.signal.aborted });
  const b = f.createPluginAlerts('other', { signal: second.signal, isAlive: () => !second.signal.aborted });

  t.after(() => {
    first.abort();
    second.abort();
  });
  assert.equal(a.show({
    id: 'same #id',
    title: 'A',
    sticky: true,
    scope: 'plugin:other',
    target: { kind: 'pipeline', taskId: '1' }
  }), true);
  assert.equal(b.show({
    id: 'same #id',
    title: 'B',
    sticky: true
  }), true);
  assert.deepEqual(f.toasts().map((toast) => toast.id).sort(), [
    'plugin:a%20b:same%20%23id', 'plugin:other:same%20%23id',
  ]);
  assert.equal(f.toasts().find((toast) => toast.title === 'A').scope, 'plugin:a%20b');
  assert.match(f.shown[0][3], /#\/ext\/a%20b$/);
  a.dismiss('same #id');
  assert.deepEqual(f.toasts().map((toast) => toast.id), ['plugin:other:same%20%23id']);
  assert.deepEqual(f.closed, ['plugin:a%20b:same%20%23id']);
  a.show({
    id: 'again',
    title: 'A',
    sticky: true,
    openPanel: false
  });
  assert.equal(f.toasts().find((toast) => toast.id.endsWith(':again')).actions.length, 0);
  a.clear();
  assert.equal(f.toasts().length, 1);
  a.show({
    id: 'last',
    title: 'A',
    sticky: true
  });
  first.abort();
  assert.equal(f.toasts().length, 1);
  assert.equal(a.show({ id: 'late', title: 'Поздний' }), false);
  assert.ok(f.closed.includes('plugin:a%20b:last'));
  assert.equal(f.closed.includes('plugin:other:same%20%23id'), false);

  for (const id of ['', ' ', null, 4]) {
    assert.equal(b.show({ id, title: 'Неверный id' }), false);
  }

  assert.equal(f.toasts().length, 1);
});
