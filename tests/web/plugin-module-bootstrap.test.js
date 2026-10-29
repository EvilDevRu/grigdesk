import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia } from '../../web/node_modules/pinia/dist/pinia.mjs';
import { api } from '../../web/src/shared/apiClient.ts';
import { usePluginsStore } from '../../web/src/stores/plugins.ts';
import { descriptor, pluginCard } from './helpers/pluginModuleContract.js';
import { serviceFixture } from './helpers/pluginModuleServices.js';
import { deferred, settle } from './helpers/pluginRuntimeUnit.js';

test('PM-LOAD-LEGACY-CALLERS: каждый load без options публикует до возврата', async (t) => {
  setActivePinia(createPinia());

  const store = usePluginsStore();
  const pending = [deferred(), deferred()];
  let index = 0;

  t.mock.method(api, 'get', () => pending[index++].promise);

  const first = store.load();
  const second = store.load();
  const a = [pluginCard({ name: 'Первый каталог' })];
  const b = [pluginCard({ name: 'Второй каталог' })];

  pending[0].resolve({ plugins: a });
  await first;
  assert.deepEqual(store.list, a);
  assert.equal(store.loadError, null);
  pending[1].resolve({ plugins: b });
  await second;
  assert.deepEqual(store.list, b);
  assert.equal(store.loadError, null);
});

for (const fails of [false, true]) {
  test(`PM-CATALOG-EPOCH: отменённый load не публикует каталог/ошибку (reject=${fails})`, async (t) => {
    setActivePinia(createPinia());

    const store = usePluginsStore();
    const pending = deferred();
    const abort = new AbortController();
    const initial = [pluginCard({ name: 'Сохранённый каталог' })];

    store.list = initial;
    t.mock.method(api, 'get', async () => {
      await pending.promise;

      if (fails) {
        throw new Error('Поздний отказ старого владельца');
      }

      return { plugins: [pluginCard({ name: 'Старый владелец' })] };
    });

    const loading = store.load({ signal: abort.signal });

    abort.abort();
    pending.resolve();
    await loading;
    assert.deepEqual(store.list, initial);
    assert.equal(store.loadError, null);
  });
}

/**
 * Watchers и stores настоящие; порты runtime считают начало/остановку без import чужого JS.
 * Ответ каталога управляется отдельно от loaded=true, чтобы воспроизводить смену владельца.
 */
async function bootstrapFixture(t, mode = 'page') {
  globalThis.__pluginBootstrapMode = mode;
  t.after(() => delete globalThis.__pluginBootstrapMode);

  const f = await serviceFixture(t, 'pluginRuntime/bootstrap.ts', {
    auths: 'stores/auth.ts',
    shells: 'stores/shell.ts',
    plugins: 'stores/plugins.ts',
    links: 'shared/alertDeepLinks.ts',
    docks: 'stores/dock.ts',
  }, {
    '../shared/desktopSettings.ts': `
      const mode = globalThis.__pluginBootstrapMode;
      export const currentDesktopMode = () => mode;
    `,
  });
  const pinia = f.pinia.createPinia();

  f.pinia.setActivePinia(pinia);

  const auth = f.auths.useAuthStore(pinia);
  const shell = f.shells.useShellStore(pinia);
  const plugins = f.plugins.usePluginsStore(pinia);
  const requests = [];
  const starts = [];
  const cleanups = [];
  const cleared = [];
  const active = new Set();
  const runtime = {
    startBackground: async (id) => {
      if (!active.has(id)) {
        active.add(id);
        starts.push(id);
      }
    },
    stop: (id) => {
      if (active.delete(id)) {
        cleanups.push(id);
        cleared.push(`plugin:${encodeURIComponent(id)}`);
      }
    },
    dispose: () => {
      for (const id of [...active]) {
        runtime.stop(id);
      }
    },
  };
  const opened = [];
  const router = {
    currentRoute: f.vue.ref({
      path: '/chats',
      meta: {},
      params: {}
    }),
    push: async (value) => opened.push(value),
  };
  let reply = [];

  t.mock.method(api, 'get', async (url, init) => {
    assert.equal(url, '/api/plugins');
    requests.push(init);

    return { plugins: reply };
  });
  shell.initialized = true;
  shell.present = true;
  shell.snapshot = { status: 'online', profile: { id: 'first' } };
  plugins.loaded = true;
  plugins.list = [pluginCard({ webModule: { ...descriptor, startOnLogin: true }, name: 'Устаревший' })];

  const dispose = f.installPluginRuntime(pinia, router, { runtime });

  t.after(dispose);

  return {
    ...f,
    opened,
    pinia,
    auth,
    shell,
    plugins,
    requests,
    starts,
    cleanups,
    cleared,
    active,
    runtime,
    dispose,
    reply: (value) => reply = value,
    login: async () => {
      auth.ready = true;
      auth.authenticated = true;
      await settle();
      await settle();
    },
  };
}

for (const mode of ['main', 'page', 'surface']) {
  test(`PM-LOGIN-BOOTSTRAP: ${mode}, opt-in, offline/online, disable, logout и повторный вход`, async (t) => {
    const f = await bootstrapFixture(t, mode);
    const opted = pluginCard({ webModule: { ...descriptor, startOnLogin: true } });
    const variant = (id, overrides) => pluginCard({
      id,
      webModule: {
        entry: `/api/ext/${id}/module/panel.js`,
        css: [],
        locales: {},
        startOnLogin: true
      },
      ...overrides,
    });

    f.reply([
      opted, variant('off', { enabled: false }), variant('system', { system: true }),
      variant('false', { webModule: {
        entry: '/api/ext/false/module/panel.js',
        css: [],
        locales: {},
        startOnLogin: false
      } }),
      variant('omitted', { webModule: {
        entry: '/api/ext/omitted/module/panel.js',
        css: [],
        locales: {}
      } }),
      variant('iframe', { webModule: undefined, web: '/api/ext/iframe/' }),
    ]);
    assert.deepEqual(f.starts, []);
    await f.login();
    assert.equal(f.pluginRuntimeFor(f.pinia) === f.runtime, true);

    if (mode === 'surface') {
      assert.deepEqual(f.starts, []);
      f.links.openAlertTarget({ kind: 'plugin', pluginId: 'ui-module' }, {
        route: { path: '/chats', query: {} },
        router: { push: (value) => f.opened.push(value) },
        chat: { revealChat: async () => true },
        ui: { openTask: () => {} },
      });
      await settle();
      assert.deepEqual(f.opened, []);
      f.auth.authenticated = false;
      await settle();

      return;
    }

    assert.equal(f.auth.clientScope, '', 'Пустой scope не отменяет подтверждённый вход');
    assert.deepEqual(f.starts, ['ui-module']);
    assert.equal(f.requests.length, 1);
    f.plugins.list[0].values = { greeting: 'Обновлено' };
    f.ui.setUiLocale('en');
    await settle();
    assert.equal(f.starts.length, 1);
    f.shell.snapshot = { status: 'offline', profile: { id: 'first' } };
    await settle();
    assert.deepEqual(f.cleanups, ['ui-module']);
    assert.deepEqual(f.cleared, ['plugin:ui-module']);
    f.shell.snapshot = { status: 'online', profile: { id: 'first' } };
    await settle();
    await settle();
    assert.equal(f.starts.length, 2);
    f.plugins.list[0].enabled = false;
    await settle();
    assert.equal(f.cleanups.length, 2);
    f.plugins.list[0].enabled = true;
    await settle();
    assert.equal(f.starts.length, 3);
    f.auth.authenticated = false;
    f.auth.logEpoch += 1;
    await settle();
    assert.equal(f.cleanups.length, 3);
    await f.login();
    assert.equal(f.starts.length, 4);
    f.dispose();
    f.ui.setUiLocale('ru');
  });
}

test('PM-CATALOG-EPOCH: loaded=true не разрешает старт до свежего ответа; старый ответ отозван',
  async (t) => {
  const f = await bootstrapFixture(t);
  const responses = [];

  api.get.mock.mockImplementation((url, init) => {
    const pending = deferred();

    responses.push({ ...pending, init });

    return pending.promise;
  });
  await f.login();
  assert.deepEqual(f.starts, []);
  assert.equal(responses.length, 1);
  f.auth.authenticated = false;
  f.auth.logEpoch += 1;
  await settle();
  assert.equal(responses[0].init.signal.aborted, true);
  await f.login();
  assert.equal(responses.length, 2);
  responses[1].resolve({ plugins: [] });
  await settle();
  responses[0].resolve({ plugins: [pluginCard({ webModule: { ...descriptor, startOnLogin: true } })] });
  await settle();
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.plugins.list, []);
  assert.equal(f.plugins.loadError, null);
});

test('PM-CATALOG-EPOCH: failed не зацикливает сеть, superseded повторяет живую попытку', async (t) => {
  const f = await bootstrapFixture(t);
  let calls = 0;

  t.mock.method(f.plugins, 'load', async () => {
    calls += 1;

    return calls === 1 ? { outcome: 'superseded' } : { outcome: 'failed' };
  });
  await f.login();
  await settle();
  assert.equal(calls, 2);
  assert.deepEqual(f.starts, []);
  await settle();
  assert.equal(calls, 2);
});

test('PM-BOOTSTRAP-DISPOSE: отзывает watchers, эпоху и только свою открывалку', async (t) => {
  const f = await bootstrapFixture(t);

  f.reply([pluginCard({ webModule: { ...descriptor, startOnLogin: true } })]);
  await f.login();
  f.dispose();

  const count = f.starts.length;

  f.auth.authenticated = false;
  await settle();
  await f.login();
  assert.equal(f.starts.length, count);
  assert.deepEqual([...f.active], []);

  const pushed = [];

  f.links.openAlertTarget({ kind: 'plugin', pluginId: 'ui-module' }, {
    route: { path: '/chats', query: {} },
    router: { push: (value) => pushed.push(value) },
    chat: { revealChat: async () => true },
    ui: { openTask: () => {} },
  });
  assert.deepEqual(pushed, []);
});


test('PM-CATALOG-EPOCH: смена profile/clientScope/logEpoch создаёт новую эпоху', async (t) => {
  const f = await bootstrapFixture(t);

  f.reply([pluginCard({ webModule: { ...descriptor, startOnLogin: true } })]);
  await f.login();

  for (const change of [
    () => f.shell.snapshot = { status: 'online', profile: { id: 'second' } },
    () => f.auth.clientScope = 'another-owner',
    () => f.auth.logEpoch += 1,
  ]) {
    const previous = f.starts.length;

    change();
    await settle();
    await settle();
    assert.equal(f.starts.length, previous + 1);
    assert.equal(f.cleanups.length, previous);
    assert.equal(f.requests.length, previous + 1);
  }
});
