import assert from 'node:assert/strict';
import test from 'node:test';
import { serviceFixture } from './helpers/pluginModuleServices.js';
import { pluginCard } from './helpers/pluginModuleContract.js';

/**
 * Настоящий центр связывает тосты, историю и системные уведомления.
 * Подменён только внешний системный канал; области и идентификаторы строит продукт.
 */
async function alertsFixture(t) {
  const closed = [];
  const shown = [];

  globalThis.__pluginNotifications = { closed, shown };
  t.after(() => delete globalThis.__pluginNotifications);

  const f = await serviceFixture(t, 'pluginRuntime/alerts.ts', {
    links: 'shared/alertDeepLinks.ts',
    alerts: 'shared/alerts.ts',
    launcher: 'shared/tools/launcher.ts',
    docks: 'stores/dock.ts',
    plugins: 'stores/plugins.ts',
  }, {
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

test('PM-ALERT-ACTIONS: явный retry доступен без панели и отзывается вместе с context', async (t) => {
  const f = await alertsFixture(t);
  const controller = new AbortController();
  let live = true;
  let calls = 0;
  const alerts = f.createPluginAlerts('a', {
    signal: controller.signal,
    isAlive: () => live,
    kind: 'plugin-background',
  });
  const input = {
    id: 'state-error',
    title: 'Не удалось прочитать состояние',
    openPanel: false,
    actions: [{
      id: 'retry',
      label: 'Повторить',
      run: async () => {
        calls += 1;
      },
    }],
  };

  t.after(() => controller.abort());
  assert.equal(alerts.show(input), true);

  const retry = f.toasts()[0].actions.find((action) => action.id === 'retry');

  assert.ok(retry);
  assert.equal(retry.label, 'Повторить');
  assert.equal(f.toasts()[0].scope, 'plugin-background:a');
  assert.equal(f.toasts()[0].actions.length, 1);
  input.actions[0].run = async () => assert.fail('Callback снимка нельзя подменить после show');
  await retry.run();
  assert.equal(calls, 1);
  live = false;
  await retry.run();
  assert.equal(calls, 1);
  live = true;
  controller.abort();
  await retry.run();
  assert.equal(calls, 1);
});

test('PM-ALERT-ACTIONS-INVALID: битый callback не публикует частичный тост', async (t) => {
  const f = await alertsFixture(t);
  const controller = new AbortController();
  const alerts = f.createPluginAlerts('a', { signal: controller.signal, isAlive: () => true });

  t.after(() => controller.abort());

  for (const actions of [null, {}, [null], [{ id: 'retry', label: 'Повторить' }],
    [{
      id: ' ',
      label: 'Повторить',
      run() {},
    }]]) {
    assert.equal(alerts.show({
      id: 'bad',
      title: 'Ошибка',
      actions,
    }), false);
  }

  assert.equal(f.toasts().length, 0);
});

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

for (const width of [899, 900]) {
  test(`PM-ALERT-PARAMS: ссылка и click→launcher→dock сохраняют параметры при ${width}px`, async (t) => {
    const f = await alertsFixture(t);

    f.pinia.setActivePinia(f.pinia.createPinia());

    const dock = f.docks.useDockStore();
    const plugins = f.plugins.usePluginsStore();
    const controller = new AbortController();
    const alerts = f.createPluginAlerts('ui-module', {
      signal: controller.signal,
      isAlive: () => true,
    });
    const pushed = [];
    const route = {
      path: '/chats',
      meta: {},
      params: {},
    };
    const router = { push: async (target) => pushed.push(target) };
    const remove = f.links.setPluginAlertOpener((id, params) => f.launcher.launchTool({
      route,
      router,
      dock,
      canDock: () => width >= 900,
    }, id, { type: 'open', params }));

    plugins.list = [pluginCard()];
    f.alerts.setAlertTargetOpener((target) => f.links.openAlertTarget(target, { router }));
    t.after(() => {
      remove();
      controller.abort();
      f.alerts.setAlertTargetOpener(null);
    });

    const params = { version: 'версия 2', model: 'модель #1' };

    assert.equal(alerts.show({
      id: 'ready',
      title: 'Готово',
      sticky: true,
      params,
    }), true);

    const url = new URL(f.shown.at(-1)[3]);
    const targetQuery = new URLSearchParams(url.hash.split('?')[1]);

    assert.equal(targetQuery.get('model'), params.model);
    assert.equal(targetQuery.get('version'), params.version);
    await f.toasts().at(-1).actions[0].run();
    assert.deepEqual(dock.intents['ui-module'].map(({ type, params }) => ({ type, params })), [
      { type: 'open', params },
    ]);

    const before = dock.intents['ui-module'].length;

    plugins.list[0].enabled = false;
    await f.toasts().at(-1).actions[0].run();
    assert.equal(dock.intents['ui-module'].length, before);
    plugins.list[0].enabled = true;

    for (const invalid of [
      { model: ['array'] }, { model: 'control\n' }, { constructor: 'prototype' },
      Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`key${index}`, 'value'])),
    ]) {
      assert.equal(alerts.show({
        id: 'invalid',
        title: 'Нет',
        params: invalid,
      }), false);
    }

    assert.equal(alerts.show({
      id: 'no-target',
      title: 'Без перехода',
      params,
      openPanel: false,
    }), true);
    assert.equal(f.toasts().find((toast) => toast.id.endsWith(':no-target')).actions.length, 0);
    controller.abort();
    assert.equal(alerts.show({
      id: 'late',
      title: 'Поздно',
      params,
    }), false);
  });
}
