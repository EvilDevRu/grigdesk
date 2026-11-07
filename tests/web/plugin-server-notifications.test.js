import assert from 'node:assert/strict';
import test from 'node:test';

import { pluginCard } from './helpers/pluginModuleContract.js';
import { serviceFixture } from './helpers/pluginModuleServices.js';
import { pluginCore, runtimeFixture } from '../server/helpers/pluginRuntimeFixture.js';

const owner = 'owner A';
const pluginId = 'ui-module';
const generation = 'generation-1';
const seenKey = `grigdesk-plugin-notifications-seen:${owner}:${pluginId}`;
const ready = {
  action: 'show',
  id: 'studio-version',
  dedupKey: 'library:intent:child:ready',
  topic: 'model:модель',
  title: { ru: 'Модель готова', en: 'Model ready' },
  body: { ru: 'Готово {name}', en: 'core.modelReady' },
  params: { model: 'модель 1', version: 'версия β' },
};

/**
 * Реальные bootstrap, stores и alert center разделяют один граф Vue/UI.
 * Подменяются только HTTP и доставка общей SSE-шины, без импорта панели.
 */
async function notificationFixture(t, options = {}) {
  const channel = { shown: [], closed: [] };

  globalThis.__pluginServerNotificationTest = channel;
  t.after(() => delete globalThis.__pluginServerNotificationTest);

  const f = await serviceFixture(t, 'pluginRuntime/bootstrap.ts', {
    auths: 'stores/auth.ts',
    shells: 'stores/shell.ts',
    plugins: 'stores/plugins.ts',
    services: 'pluginRuntime/contextServices.ts',
    transport: 'shared/apiClient.ts',
    alerts: 'shared/alerts.ts',
    docks: 'stores/dock.ts',
    links: 'shared/alertDeepLinks.ts',
  }, {
    '../shared/desktopSettings.ts': `export const currentDesktopMode = () => ${JSON.stringify(
      options.surface ? 'surface' : 'page')};`,
    './notify.ts': `
      const channel = globalThis.__pluginServerNotificationTest;
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
  const pinia = f.pinia.createPinia();

  f.pinia.setActivePinia(pinia);

  const auth = f.auths.useAuthStore(pinia);
  const shell = f.shells.useShellStore(pinia);
  const plugins = f.plugins.usePluginsStore(pinia);
  const dock = f.docks.useDockStore(pinia);
  const requests = [];
  const listeners = new Set();
  let catalog = [pluginCard({ runtimeGeneration: generation })];
  let snapshot = { plugins: [{ pluginId, generation, items: [], error: null }] };
  let toasts = [];
  let imports = 0;
  const runtime = {
    acquirePanel: () => {
      imports += 1;
      assert.fail('Уведомление не загружает панель');
    },
    stop() {},
    reset() {},
    dispose() {},
  };
  const route = f.vue.ref({ path: '/chats', params: {}, meta: {} });
  const router = { currentRoute: route, push: async () => {} };

  if (options.request) {
    t.mock.method(globalThis, 'fetch', async (input, init) => {
      const url = new URL(String(input), 'https://grigdesk.test');
      const response = await options.request(init?.method ?? 'GET', url.pathname);

      requests.push({ url: url.pathname, signal: init?.signal });

      return new Response(response.body, { status: response.statusCode, headers: response.headers });
    });
  } else {
    t.mock.method(f.transport.api, 'get', async (url, init) => {
      requests.push({ url, signal: init?.signal });

      if (url === '/api/plugins') {
        return { plugins: catalog };
      }

      assert.equal(url, '/api/plugins/notifications');

      return typeof snapshot === 'function' ? snapshot(init?.signal) : snapshot;
    });
  }
  t.mock.method(document, 'hasFocus', () => false);

  const off = f.ui.subscribeToasts((value) => toasts = value);

  shell.initialized = true;
  shell.present = true;
  shell.snapshot = { status: 'online', profile: { id: 'fixture-profile' } };

  const install = () => f.installPluginRuntime(pinia, router, {
    runtime,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  });
  let dispose = install();
  const settle = async () => {
    for (let turn = 0; turn < 6; turn += 1) {
      await f.vue.nextTick();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const emit = (name, value) => {
    for (const listener of [...listeners]) {
      listener(name, value);
    }
  };

  t.after(() => {
    dispose();
    off();
    f.alerts.setAlertTargetOpener(null);
    f.alerts.setAlertsLocale(null);
    f.ui.dismissAllToasts();
    f.ui.setUiLocale('ru');
  });

  return {
    ...f,
    auth,
    shell,
    plugins,
    pinia,
    dock,
    channel,
    requests,
    route,
    router,
    settle,
    emit,
    toasts: () => toasts,
    imports: () => imports,
    snapshot: (value) => snapshot = value,
    catalog: (value) => catalog = value,
    send: (data, gen = generation, id = pluginId) => emit('plugin-event', {
      pluginId: id, generation: gen, event: 'notification', data,
    }),
    login: async (scope = owner) => {
      auth.$patch({ ready: true, authenticated: true, clientScope: scope });
      await settle();
    },
    reload: async () => {
      dispose();
      dispose = install();
      await settle();
    },
    dispose: () => dispose(),
  };
}

test('PN-WEB-LIVE: готовность/ошибка без acquire, query и смена языка без native дубля', async (t) => {
  const f = await notificationFixture(t);

  await f.login();
  assert.equal(f.requests.filter(({ url }) => url.endsWith('/notifications')).length, 1);
  f.alerts.setAlertsLocale(f.ui.uiLocale);
  f.send(ready);
  assert.equal(f.toasts().length, 1);
  assert.equal(f.ui.resolveUiText(f.toasts()[0].title), 'Модель готова');
  assert.equal(f.ui.resolveUiText(f.toasts()[0].body), 'Готово {name}');

  const id = f.toasts()[0].id;
  const nativeCount = f.channel.shown.length;

  f.ui.setUiLocale('en');
  assert.equal(f.ui.resolveUiText(f.toasts()[0].title), 'Model ready');
  assert.equal(f.ui.resolveUiText(f.toasts()[0].body), 'core.modelReady');
  assert.equal(f.toasts()[0].id, id);
  assert.equal(f.channel.shown.length, nativeCount);
  assert.equal(new URLSearchParams(f.channel.shown[0][3].split('?')[1]).get('version'), ready.params.version);

  const remove = f.links.setPluginAlertOpener((id, params) => {
    f.dock.enqueue(id, { type: 'open', params });
  });

  t.after(remove);
  f.alerts.setAlertTargetOpener((target) => f.links.openAlertTarget(target, {}));
  f.toasts()[0].actions[0].run();
  assert.deepEqual(f.dock.intents[pluginId][0].params, ready.params);
  f.send({
    ...ready,
    id: 'failed-version',
    dedupKey: 'library:intent:child:failed',
    title: { ru: 'Ошибка', en: 'Failed' },
    body: { ru: 'Исходная причина', en: 'Original reason' },
    tone: 'danger',
    sticky: true,
  });

  const failed = f.toasts().find((toast) => toast.id.endsWith(':failed-version'));

  assert.equal(failed.tone, 'danger');
  assert.equal(failed.durationMs, 0);
  assert.equal(f.ui.resolveUiText(failed.body), 'Original reason');
  assert.equal(f.imports(), 0);
  assert.equal(f.requests.filter(({ url }) => url.endsWith('/notifications')).length, 1);
});

test('PN-WEB-REPLAY: live/snapshot/reload дают один исход, чужое поколение игнорируется', async (t) => {
  const f = await notificationFixture(t);
  const barrier = Promise.withResolvers();

  f.snapshot(() => barrier.promise);
  await f.login();
  f.send(ready);
  f.send({ ...ready, id: 'foreign', dedupKey: 'foreign' }, 'old-generation');
  f.send({ ...ready, id: 'foreign', dedupKey: 'foreign' }, generation, 'other');
  barrier.resolve({ plugins: [{ pluginId, generation, items: [ready], error: null }] });
  await f.settle();
  assert.equal(f.toasts().length, 1);
  assert.deepEqual(JSON.parse(localStorage.getItem(seenKey)), [ready.dedupKey]);
  f.snapshot({ plugins: [{ pluginId, generation, items: [ready], error: null }] });
  await f.reload();
  assert.equal(f.toasts().length, 0);
  assert.equal(f.channel.shown.length, 1);
  assert.equal(f.imports(), 0);
});

test('PN-WEB-BOUNDS: 501 исход оставляет 500 ключей, storage denial ограничен памятью', async (t) => {
  const f = await notificationFixture(t);

  await f.login();

  for (let index = 0; index < 501; index += 1) {
    f.send({ ...ready, id: `item-${index}`, dedupKey: `key-${index}` });
  }

  const keys = JSON.parse(localStorage.getItem(seenKey));

  assert.equal(keys.length, 500);
  assert.equal(keys[0], 'key-1');
  assert.equal(keys.at(-1), 'key-500');
  t.mock.method(f.browser.localStorage, 'getItem', () => {
    throw new Error('Storage запрещён');
  });
  t.mock.method(f.browser.localStorage, 'setItem', () => {
    throw new Error('Storage запрещён');
  });
  f.send({ ...ready, id: 'memory', dedupKey: 'memory' });

  const count = f.channel.shown.length;

  f.send({ ...ready, id: 'memory', dedupKey: 'memory' });
  assert.equal(f.channel.shown.length, count);
  assert.equal(f.imports(), 0);
});

test('PN-WEB-OWNERS: late snapshot/disabled/logout не меняют нового владельца', async (t) => {
  const f = await notificationFixture(t);
  const barrier = Promise.withResolvers();

  f.snapshot(() => barrier.promise);
  await f.login();
  f.snapshot({ plugins: [] });
  await f.login('owner B');
  barrier.resolve({ plugins: [{ pluginId, generation, items: [ready], error: null }] });
  await f.settle();
  assert.equal(f.toasts().length, 0);
  assert.equal(localStorage.getItem(seenKey), null);
  f.send(ready);
  assert.equal(f.toasts().length, 1);
  f.plugins.list[0].enabled = false;
  await f.settle();
  assert.equal(f.toasts().length, 0);
  f.send({ ...ready, dedupKey: 'disabled' });
  assert.equal(f.toasts().length, 0);
  f.auth.authenticated = false;
  await f.settle();
  assert.equal(f.toasts().length, 0);
  assert.equal(localStorage.getItem(seenKey), null);
});

for (const enabled of [false, true]) {
  test(`PN-WEB-REAL-CORE: boot=${enabled}, toggle меняет generation того же core без UI`, async (t) => {
    let hooks = 0;
    const server = await runtimeFixture(t, [{ id: pluginId, web: true, hooks: {
      notifications: async () => {
        hooks += 1;

        return [];
      },
    } }], { prefs: { plugins: { [pluginId]: enabled } }, sse: true });
    const f = await notificationFixture(t, { request: server.request });

    t.mock.method(server.app.sse, 'broadcast', (name, data) => f.emit(name, data));
    assert.equal((await server.request('GET', '/api/plugins/notifications', undefined, {})).statusCode, 401);
    await f.login();

    if (!enabled) {
      assert.equal(await server.imported(pluginId), false);
      assert.equal(hooks, 0);
      assert.equal((await server.toggle(pluginId, true)).statusCode, 200);
      await f.settle();
    }

    assert.equal(hooks, 1);

    const core = pluginCore(server, pluginId);
    const firstGeneration = (await server.card(pluginId)).runtimeGeneration;
    const snapshots = f.requests.filter(({ url }) => url.endsWith('/notifications')).length;

    assert.equal(f.plugins.byId(pluginId).runtimeGeneration, firstGeneration);
    core.emit('notification', ready);
    assert.equal(f.toasts().length, 1);
    assert.equal(f.requests.filter(({ url }) => url.endsWith('/notifications')).length, snapshots);
    assert.equal(f.imports(), 0);
    core.emit('notification', {
      ...ready,
      id: 'initial-failed',
      dedupKey: 'initial-failed',
      title: { ru: 'Не удалось создать модель', en: 'Model creation failed' },
      body: { ru: 'Исходная причина', en: 'Original reason' },
      tone: 'danger',
      sticky: true,
    });
    assert.equal(f.toasts().length, 2);
    assert.equal(f.toasts().find((toast) => toast.id.endsWith(':initial-failed')).durationMs, 0);
    assert.equal(f.requests.filter(({ url }) => url.endsWith('/notifications')).length, snapshots);
    assert.equal((await server.toggle(pluginId, false)).statusCode, 200);
    await f.settle();
    assert.equal(f.toasts().length, 0);
    assert.equal((await server.toggle(pluginId, true)).statusCode, 200);
    await f.settle();
    assert.equal(pluginCore(server, pluginId), core);
    assert.notEqual(f.plugins.byId(pluginId).runtimeGeneration, firstGeneration);
    assert.equal(hooks, 2);
    core.emit('notification', { ...ready, id: 'after-on', dedupKey: 'after-on' });
    assert.equal(f.toasts().length, 1);
    assert.equal(f.requests.filter(({ url }) => url.endsWith('/notifications')).length, snapshots + 1);
    assert.equal(f.imports(), 0);
    f.dispose();
  });
}

test('PN-WEB-ERROR: отказ снимка виден один раз на поколение, retry восстанавливает исход', async (t) => {
  const f = await notificationFixture(t);

  f.snapshot({ plugins: [{ pluginId, generation, items: [], error: 'hook_timeout' }] });
  await f.login();
  assert.equal(f.toasts().length, 1);
  assert.equal(f.toasts()[0].tone, 'warning');
  assert.equal(localStorage.getItem(seenKey), null);
  f.emit('hello', {});
  await f.settle();
  assert.equal(f.channel.shown.length, 1);
  f.snapshot({ plugins: [{ pluginId, generation, items: [ready], error: null }] });

  const retry = f.toasts()[0].actions.find((action) => action.id === 'retry');

  assert.ok(retry);
  await retry.run();
  await f.settle();
  assert.equal(f.toasts().length, 1);
  assert.equal(f.ui.resolveUiText(f.toasts()[0].title), ready.title.ru);
});

test('PN-WEB-VIEWING: только активная собственная тема снимает тост и помечает исход seen', async (t) => {
  const f = await notificationFixture(t);

  await f.login();

  const abort = new AbortController();
  const active = f.vue.ref(true);
  const { context } = f.services.createPluginContextServices({ pluginId }, {
    signal: abort.signal,
    panelActive: active,
    backgroundActive: f.vue.ref(true),
    isAlive: () => !abort.signal.aborted,
    notificationIdentity: { owner: f.runtimeOwner ?? JSON.stringify([owner, 'fixture-profile']), generation },
  });

  t.after(() => abort.abort());
  assert.equal(typeof context.notifications?.setViewing, 'function');
  f.send(ready);
  assert.equal(f.toasts().length, 1);
  context.notifications.setViewing(ready.topic);
  assert.equal(f.toasts().length, 0);
  f.send({ ...ready, id: 'viewed', dedupKey: 'viewed' });
  assert.equal(f.toasts().length, 0);
  assert.ok(JSON.parse(localStorage.getItem(seenKey)).includes('viewed'));
  f.send({ ...ready, id: 'other-topic', topic: 'model:other', dedupKey: 'other-topic' });
  assert.equal(f.toasts().length, 1);
  active.value = false;
  f.send({ ...ready, id: 'hidden', dedupKey: 'hidden' });
  assert.equal(f.toasts().length, 2);
  active.value = true;
  assert.equal(f.toasts().length, 1);
  abort.abort();
  f.send({ ...ready, id: 'closed', dedupKey: 'closed' });
  assert.equal(f.toasts().length, 2);
  context.notifications.setViewing('model:other');
  assert.equal(f.toasts().length, 2);
});

test('PN-WEB-SURFACE: отдельное окно поверхности не запускает bridge', async (t) => {
  const f = await notificationFixture(t, { surface: true });

  await f.login();
  f.send(ready);
  assert.equal(f.requests.length, 0);
  assert.equal(f.toasts().length, 0);
  assert.equal(f.imports(), 0);
});

test('PN-WEB-STALE: новый catalog generation отзывает late snapshot и прежний viewing context', async (t) => {
  const f = await notificationFixture(t);
  const barrier = Promise.withResolvers();

  f.snapshot(() => barrier.promise);
  await f.login();

  const abort = new AbortController();
  const { context } = f.services.createPluginContextServices({ pluginId }, {
    signal: abort.signal,
    panelActive: f.vue.ref(true),
    backgroundActive: f.vue.ref(false),
    isAlive: () => true,
    notificationIdentity: { owner: JSON.stringify([owner, 'fixture-profile']), generation },
  });

  t.after(() => abort.abort());
  f.catalog([pluginCard({ runtimeGeneration: 'generation-2' })]);
  f.snapshot({ plugins: [{ pluginId, generation: 'generation-2', items: [], error: null }] });
  f.emit('state-change', { plugins: true });
  await f.settle();
  barrier.resolve({ plugins: [{ pluginId, generation, items: [ready], error: null }] });
  await f.settle();
  assert.equal(f.toasts().length, 0);
  assert.equal(localStorage.getItem(seenKey), null);
  f.send(ready, 'generation-2');
  assert.equal(f.toasts().length, 1);
  context.notifications.setViewing(ready.topic);
  assert.equal(f.toasts().length, 1);
});

test('PN-WEB-DISMISS: операции сервера ограничены своим каналом и темой', async (t) => {
  const f = await notificationFixture(t);

  await f.login();

  const abort = new AbortController();
  const { context } = f.services.createPluginContextServices({ pluginId }, {
    signal: abort.signal,
    panelActive: f.vue.ref(true),
    backgroundActive: f.vue.ref(false),
    isAlive: () => !abort.signal.aborted,
  });

  t.after(() => abort.abort());
  context.alerts.show({ id: 'ui', title: 'Собственный UI', sticky: true });
  f.send(ready);
  f.send({ ...ready, id: 'other', topic: 'model:other', dedupKey: 'other' });
  f.send({ action: 'dismiss-topic', topic: ready.topic });
  assert.equal(f.toasts().length, 2);
  assert.ok(f.toasts().some((toast) => toast.id === `plugin:${pluginId}:ui`));
  f.send({ action: 'dismiss', id: 'other' });
  assert.equal(f.toasts().length, 1);
  f.send({ ...ready, id: 'second', dedupKey: 'second' });
  f.send({ action: 'clear' });
  assert.equal(f.toasts().length, 1);
  assert.equal(f.toasts()[0].id, `plugin:${pluginId}:ui`);
  f.send({ ...ready, id: 'invalid', dedupKey: 'invalid', scope: 'plugin:other' });
  assert.equal(f.toasts().length, 1);
});

test('PN-WEB-STORAGE: обновление соседнего окна перечитывается перед обработкой исхода', async (t) => {
  const f = await notificationFixture(t);

  await f.login();
  f.send(ready);
  localStorage.setItem(seenKey, JSON.stringify([ready.dedupKey, 'another-window']));
  f.send({ ...ready, id: 'external', dedupKey: 'another-window' });
  assert.equal(f.toasts().length, 1);
  assert.deepEqual(JSON.parse(localStorage.getItem(seenKey)), [ready.dedupKey, 'another-window']);
});

test('PN-WEB-RECONNECT: пропущенные ready/failed восстанавливаются один раз без панели', async (t) => {
  const f = await notificationFixture(t);

  await f.login();
  f.shell.snapshot = { status: 'offline', profile: { id: 'fixture-profile' } };
  await f.settle();
  f.send(ready);
  assert.equal(f.toasts().length, 0);

  const failed = {
    ...ready,
    id: 'missed-failed',
    dedupKey: 'missed-failed',
    tone: 'danger',
    sticky: true,
    body: { ru: 'Причина отказа', en: 'Failure reason' },
  };

  f.snapshot({ plugins: [{ pluginId, generation, items: [ready, failed], error: null }] });
  f.shell.snapshot = { status: 'online', profile: { id: 'fixture-profile' } };
  await f.settle();
  assert.equal(f.toasts().length, 2);
  assert.equal(f.toasts().find((toast) => toast.id.endsWith(':missed-failed')).durationMs, 0);
  f.emit('hello', {});
  await f.settle();
  assert.equal(f.toasts().length, 2);
  assert.equal(f.channel.shown.length, 2);
  assert.equal(f.imports(), 0);
});

test('PN-WEB-CLOSED-SNAPSHOT: неверный item не помечает валидную часть набора seen', async (t) => {
  const f = await notificationFixture(t);

  f.snapshot({ plugins: [{
    pluginId,
    generation,
    items: [ready, { ...ready, id: 'bad', dedupKey: 'bad', url: 'https://evil.test' }],
    error: null,
  }] });
  await f.login();
  assert.equal(f.toasts().length, 1);
  assert.equal(f.toasts()[0].tone, 'warning');
  assert.equal(localStorage.getItem(seenKey), null);
  assert.equal(f.imports(), 0);
});
