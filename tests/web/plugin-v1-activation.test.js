import assert from 'node:assert/strict';
import test from 'node:test';

import { api } from '../../web/src/shared/apiClient.ts';
import { serviceFixture } from './helpers/pluginModuleServices.js';
import { cardV1, webEntryV1 } from './helpers/pluginV1.js';
import { settle } from './helpers/pluginRuntimeUnit.js';

const SLOT = 'provider.popover.after-bars';
const resource = {
  key: 'fixture',
  label: 'Явный источник',
  summary: '42 %',
  controls: []
};

/**
 * Реальные Pinia, decoder, runtime и popup разделяют один граф Vue и общий UI.
 * Управляются только ответы транспорта и загрузка внешнего ESM; start исполняет продукт.
 */
async function activationFixture(t, overrides = {}, options = {}) {
  const f = await serviceFixture(t, 'pluginRuntime/runtime.ts', {
    catalogs: 'stores/plugins.ts',
    boot: 'pluginRuntime/bootstrap.ts',
    auths: 'stores/auth.ts',
    shells: 'stores/shell.ts',
    popup: 'features/providers/ProviderUsagePlugins.vue',
  });
  const pinia = f.pinia.createPinia();

  f.pinia.setActivePinia(pinia);

  const plugins = f.catalogs.usePluginsStore(pinia);
  const auth = f.auths.useAuthStore(pinia);
  const shell = f.shells.useShellStore(pinia);
  const calls = {
    imports: [],
    starts: [],
    cleanups: [],
    gets: []
  };
  const card = cardV1(overrides);

  const get = api.get;

  t.mock.method(api, 'get', (url, init) => {
    calls.gets.push({ url, init });

    return get(url, init);
  });
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(String(input), 'https://grigdesk.test').pathname;

    if (url === '/api/plugins') {
      return Response.json({ plugins: [card] });
    }

    const body = options.get ? await options.get(String(input), init) : { resources: [resource] };

    return Response.json(body);
  });
  await plugins.load();
  assert.equal(plugins.loadError, null, 'настоящий decoder принял публичный v1 DTO');

  const router = {
    currentRoute: f.vue.ref({
      path: '/chats',
      meta: {},
      params: {}
    }),
    push: async () => {},
  };
  const module = {
    component: { render: () => null },
    start: options.start ?? ((context) => {
      calls.starts.push(context);

      return () => calls.cleanups.push(context);
    }),
    releaseStyles: () => {},
  };
  const runtime = f.createPluginRuntime({
    plugins,
    router,
    dock: {
      isOpen: false,
      activeTool: null,
      runtime: {}
    },
    loadPluginModule: async (...args) => {
      calls.imports.push(args);

      return options.load ? await options.load(...args) : module;
    },
  });

  auth.ready = true;
  auth.authenticated = true;
  shell.initialized = true;
  shell.present = true;
  shell.snapshot = { status: 'online', profile: { id: 'first-profile' } };

  const dispose = f.boot.installPluginRuntime(pinia, router, { runtime });

  t.after(dispose);
  await settle();

  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const popup = () => {
    const wrapper = mount(f.popup.default, {
      props: { providerId: 'codex' },
      global: { plugins: [pinia] },
      attachTo: f.browser.document.querySelector('#mount'),
    });

    t.after(() => wrapper.unmount());

    return wrapper;
  };

  return {
    ...f,
    runtime,
    plugins,
    calls,
    popup,
    flushPromises,
    module,
    auth,
    shell,
    dispose
  };
}

test('V1-DEMAND-PANEL: закрытые места не импортируются, первый спрос вызывает optional start', async (t) => {
  const f = await activationFixture(t);

  assert.equal(f.calls.imports.length, 0);

  const panel = await f.runtime.acquirePanel('ui-module', webEntryV1, { active: true });

  assert.equal(f.calls.imports.length, 1);
  assert.equal(f.calls.starts.length, 1);
  assert.equal(f.calls.starts[0], panel.context);
  panel.release();
  panel.release();
  assert.equal(panel.context.signal.aborted, true);
  assert.equal(f.calls.cleanups.length, 1);
});

test('V1-DEMAND-PANEL: отсутствие optional start допускает открытие и закрытие панели', async (t) => {
  const f = await activationFixture(t);

  delete f.module.start;

  const panel = await f.runtime.acquirePanel('ui-module', webEntryV1);

  panel.release();
  assert.equal(panel.context.signal.aborted, true);
  assert.equal(f.calls.imports.length, 1);
});

test('V1-DEMAND-SLOT: popup панели с явным slot получает lease и JSON через общий API', async (t) => {
  const f = await activationFixture(t);
  const wrapper = f.popup();

  await f.flushPromises();
  assert.equal(f.calls.imports.length, 1, 'запрос слота активирует объявленный web-модуль');
  assert.equal(f.calls.starts.length, 1);
  assert.match(wrapper.text(), /Явный источник/u);
  assert.match(wrapper.text(), /42 %/u);

  const request = f.calls.gets.find(({ url }) => url.includes('provider-usage'));

  assert.equal(request.url, '/api/ext/ui-module/provider-usage?providerId=codex');
  assert.equal(request.init.timeoutMs, 20_000);
  assert.equal(request.init.retry, false);
  wrapper.unmount();
  await f.flushPromises();
  assert.equal(request.init.signal.aborted, true);
  assert.equal(f.calls.cleanups.length, 1);
});

for (const [label, overrides] of [
  ['нет декларации', {
    nav: null,
    placements: [],
    contributes: {
    panels: [],
    slots: [],
    commands: [],
    themes: []
  }
  }],
  ['выключен', { enabled: false }],
  ['placement off', { placements: [{ slot: SLOT, enabled: false }] }],
  ['несовместим', {
    enabled: false,
    nav: null,
    compatibility: {
    status: 'incompatible',
    code: 'manifest_incompatible',
    reason: 'Старый'
  }
  }],
  ['только commands/themes', {
    nav: null,
    placements: [],
    contributes: {
    commands: [{ id: 'test', title: 'Проверка' }],
    themes: [{ id: 'dark', title: 'Тёмная' }],
  }
  }],
]) {
  test(`V1-DEMAND-SLOT: ${label} не импортирует ESM и не читает provider-usage`, async (t) => {
    const f = await activationFixture(t, overrides);

    f.popup();
    await f.flushPromises();
    assert.equal(f.calls.imports.length, 0);
    assert.equal(f.calls.gets.filter(({ url }) => url.includes('provider-usage')).length, 0);
  });
}

test('V1-DEMAND-SHARED: pending panel и slot делят import/context/start до последнего release', async (t) => {
  const pending = Promise.withResolvers();

  t.after(() => pending.resolve());

  const f = await activationFixture(t, {}, { load: () => pending.promise });
  const opening = f.runtime.acquirePanel('ui-module', webEntryV1);
  const wrapper = f.popup();

  await f.flushPromises();
  assert.equal(f.calls.imports.length, 1);
  pending.resolve(f.module);

  const panel = await opening;

  await f.flushPromises();
  assert.equal(f.calls.starts.length, 1);
  assert.equal(f.calls.starts[0], panel.context);
  wrapper.unmount();
  await f.flushPromises();
  assert.equal(panel.context.signal.aborted, false);
  assert.equal(f.calls.cleanups.length, 0);
  panel.release();
  assert.equal(f.calls.cleanups.length, 1);
});

test('V1-DEMAND-SHARED: поздний start после отмены освобождается ровно один раз', async (t) => {
  const pending = Promise.withResolvers();

  t.after(() => pending.resolve());

  let context;
  let cleanups = 0;
  const f = await activationFixture(t, {}, { start: async (value) => {
    context = value;
    await pending.promise;

    return () => cleanups += 1;
  } });
  const abort = new AbortController();
  const opening = f.runtime.acquirePanel('ui-module', webEntryV1, { signal: abort.signal });

  opening.catch(() => {});
  await f.flushPromises();
  assert.ok(context, 'спрос панели запускает named start без opt-in');
  abort.abort();
  pending.resolve();
  await assert.rejects(opening);
  await f.flushPromises();
  assert.equal(context.signal.aborted, true);
  assert.equal(cleanups, 1);
});

test('V1-DEMAND-SLOT: server-only JSON сохраняет рабочий путь без импорта ESM', async (t) => {
  const f = await activationFixture(t, {
    entrypoints: {},
    nav: null,
    contributes: {
      panels: [],
      slots: cardV1().contributes.slots,
      settings: [],
      commands: [],
      themes: [],
    },
  });
  const wrapper = f.popup();

  await f.flushPromises();
  assert.match(wrapper.text(), /Явный источник/u);
  assert.equal(f.calls.imports.length, 0);
  wrapper.unmount();
});

for (const reason of ['provider', 'disable', 'placement', 'unmount', 'owner', 'profile', 'offline']) {
  test(`V1-DEMAND-SHARED: ${reason} отзывает pending JSON и не принимает поздний ответ`, async (t) => {
    const pending = Promise.withResolvers();
    let requests = 0;
    const f = await activationFixture(t, {}, { get: async () => {
      requests += 1;

      return requests === 1 ? await pending.promise : { resources: [] };
    } });

    t.after(() => pending.resolve({ resources: [] }));

    const wrapper = f.popup();

    await f.flushPromises();
    assert.equal(f.calls.imports.length, 1, 'pending slot владеет модулем');
    assert.equal(f.calls.starts.length, 1);

    const request = f.calls.gets.find(({ url }) => url.includes('provider-usage'));

    if (reason === 'provider') {
      await wrapper.setProps({ providerId: 'claude' });
    } else if (reason === 'disable') {
      f.plugins.list[0].enabled = false;
    } else if (reason === 'placement') {
      f.plugins.list[0].placements[0].enabled = false;
    } else if (reason === 'unmount') {
      wrapper.unmount();
    } else if (reason === 'owner') {
      f.auth.clientScope = 'other-owner';
    } else if (reason === 'profile') {
      f.shell.snapshot = { status: 'online', profile: { id: 'other-profile' } };
    } else {
      f.shell.snapshot = { status: 'offline', profile: { id: 'first-profile' } };
    }

    await f.flushPromises();
    assert.equal(request.init.signal.aborted, true);
    pending.resolve({ resources: [{ ...resource, label: 'Поздний старый ответ' }] });
    await f.flushPromises();
    assert.equal(wrapper.text().includes('Поздний старый ответ'), false);
  });
}

test('V1-DEMAND-PANEL: slot-only модуль не даёт получить необъявленную панель', async (t) => {
  const f = await activationFixture(t, {
    nav: null,
    contributes: { ...cardV1().contributes, panels: [] },
  });

  await assert.rejects(f.runtime.acquirePanel('ui-module', webEntryV1));
  assert.equal(f.calls.imports.length, 0);
});

test('V1-DEMAND-SHARED: release панели оставляет слот живым до закрытия popup', async (t) => {
  const f = await activationFixture(t);
  const wrapper = f.popup();

  await f.flushPromises();

  const panel = await f.runtime.acquirePanel('ui-module', webEntryV1);

  assert.equal(f.calls.starts.length, 1);
  assert.equal(f.calls.imports.length, 1);
  panel.release();
  assert.equal(panel.context.signal.aborted, false);
  assert.equal(f.calls.cleanups.length, 0);
  assert.match(wrapper.text(), /Явный источник/u);
  wrapper.unmount();
  await f.flushPromises();
  assert.equal(panel.context.signal.aborted, true);
  assert.equal(f.calls.cleanups.length, 1);
});
