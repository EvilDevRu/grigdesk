import assert from 'node:assert/strict';
import test from 'node:test';

import { pluginCard } from './helpers/pluginModuleContract.js';
import { serviceFixture } from './helpers/pluginModuleServices.js';
import { compileModule, webFile } from './helpers/compile-vue.js';

const pluginId = 'external-probe';

/**
 * Внешняя панель имеет собственные адреса без legacy API и компонентов.
 * Разные nav group не должны ограничивать общие горячие клавиши.
 */
function externalCard(overrides = {}) {
  return pluginCard({
    id: pluginId,
    name: 'Внешняя панель',
    runtimeGeneration: 'generation-1',
    contributes: { panels: [{
      title: 'Внешняя панель',
      group: 'tools',
      hotkey: 'Ctrl+Shift+Digit7',
    }] },
    entrypoints: { web: {
      entry: `/api/ext/${pluginId}/module/generation-1/panel.js`,
      css: [],
      locales: {},
    } },
    ...overrides,
  });
}

/**
 * Настоящие ToolHost, PluginView, PluginModulePanel и stores используют общий bootstrap.
 * Подменяются тяжёлые builtin панели и загрузка внешнего ESM, не route admission.
 */
async function navigationFixture(t, width, options = {}) {
  const builtinStubs = Object.fromEntries([
    'code/CodePanel', 'shelf/TaskShelfPanel',
    'terminal/TerminalPanel', 'ssh/SshPanel', 'db/DbPanel', 'docker/DockerPanel',
  ].map((name) => [`../../views/${name}.vue`,
    'export const __esModule = true; export default { render: () => null };']));
  const f = await serviceFixture(t, 'shared/alertDeepLinks.ts', {
    host: 'shared/layout/ToolHost.vue',
    view: 'views/PluginView.vue',
    bootstrap: 'pluginRuntime/bootstrap.ts',
    docks: 'stores/dock.ts',
    plugins: 'stores/plugins.ts',
    auths: 'stores/auth.ts',
    shells: 'stores/shell.ts',
    settings: 'stores/settings.ts',
    hotkeys: 'stores/hotkeys.ts',
    transport: 'shared/apiClient.ts',
    catalog: 'features/settings/catalog.ts',
  }, builtinStubs);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'history');

  Object.defineProperty(globalThis, 'history', { value: f.browser.history, configurable: true });
  t.after(() => {
    if (previous) {
      Object.defineProperty(globalThis, 'history', previous);
    } else {
      delete globalThis.history;
    }
  });
  f.browser.happyDOM.setWindowSize({ width, height: 900 });

  const { createRouter, createMemoryHistory, RouterView } =
    await import('../../web/node_modules/vue-router/dist/vue-router.mjs');
  const { mount, flushPromises } =
    await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const pinia = f.pinia.createPinia();

  f.pinia.setActivePinia(pinia);

  const plugins = f.plugins.usePluginsStore(pinia);
  const auth = f.auths.useAuthStore(pinia);
  const shell = f.shells.useShellStore(pinia);
  const dock = f.docks.useDockStore(pinia);
  const settings = f.settings.useSettingsStore(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/chats', component: { render: () => null } },
    {
      path: '/ext/:id',
      component: f.view.default,
      meta: { tool: 'ext' },
    },
  ] });
  const imports = [];
  const mounts = [];
  const requests = [];
  const listeners = new Set();
  let response = options.catalog ?? [];

  t.mock.method(f.transport.api, 'get', async (path) => {
    requests.push(path);

    if (path === '/api/plugins') {
      if (response instanceof Error) {
        throw response;
      }

      return typeof response === 'function' ? response() : { plugins: response };
    }

    assert.equal(path, '/api/plugins/notifications');

    return { plugins: [] };
  });
  plugins.list = options.retained ?? [];
  plugins.loaded = options.loaded ?? false;
  shell.initialized = true;
  shell.present = true;
  shell.snapshot = { status: 'online', profile: { id: 'fixture-profile' } };
  settings.setAuthenticated(true);
  await router.push(options.route ?? `/ext/${pluginId}?model=модель+1&version=β`);
  await router.isReady();

  const dispose = f.bootstrap.installPluginRuntime(pinia, router, {
    subscribe: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    loadPluginModule: async (id) => {
      imports.push(id);

      return {
        releaseStyles() {},
        component: f.vue.defineComponent({
          props: ['context', 'active', 'presentation', 'intents'],
          emits: ['consume-intent'],
          setup(props, { emit }) {
            mounts.push(id);

            return () => f.vue.h('section', { 'data-external-probe': id }, [
              f.vue.h('output', { 'data-probe-intents': '' }, JSON.stringify(props.intents)),
              f.vue.h('button', {
                'data-probe-consume': '',
                onClick: () => emit('consume-intent', props.intents?.[0]?.id),
              }, 'Принять'),
            ]);
          },
        }),
      };
    },
  });
  const wrapper = mount({
    setup: () => () => f.vue.h('div', { class: 'shell' }, [
      f.vue.h('main', { class: 'content' }, [f.vue.h(RouterView)]),
      f.vue.h(f.host.default),
    ]),
  }, { attachTo: document.body, global: { plugins: [pinia, router] } });
  const settle = async () => {
    await f.vue.nextTick();
    await flushPromises();
    await f.vue.nextTick();
  };

  t.after(() => {
    wrapper.unmount();
    dispose();
  });

  return {
    ...f,
    pinia,
    plugins,
    auth,
    shell,
    dock,
    settings,
    router,
    wrapper,
    imports,
    mounts,
    requests,
    settle,
    response: (value) => response = value,
    login: async () => {
      auth.$patch({
        ready: true,
        authenticated: true,
        clientScope: 'owner A',
      });
      await settle();
    },
    catalogChanged: async () => {
      for (const listener of [...listeners]) {
        listener('state-change', { plugins: true });
      }

      await settle();
    },
  };
}

for (const width of [899, 900]) {
  test(`EXT-ROUTE: missing→install/on, одна панель и intent при ${width}px`, async (t) => {
    const f = await navigationFixture(t, width);

    await f.login();
    assert.equal(f.wrapper.find('[data-plugin-route-state]')
      .attributes('data-plugin-route-state'), 'missing');
    assert.equal(f.imports.length, 0);
    assert.equal(f.router.currentRoute.value.query.model, 'модель 1');
    await f.wrapper.get('[data-plugin-route-action]').trigger('click');
    assert.equal(f.settings.pageId, 'plugins.installed');
    assert.equal(f.settings.entityId, pluginId);
    f.response([externalCard()]);
    await f.catalogChanged();
    assert.equal(f.wrapper.findAll('[data-external-probe]').length, 1);
    assert.deepEqual(f.imports, [pluginId]);
    assert.deepEqual(f.dock.intents[pluginId].map(({ type, params }) => ({ type, params })), [
      { type: 'open', params: { model: 'модель 1', version: 'β' } },
    ]);
    assert.deepEqual(f.router.currentRoute.value.query, {});
    await f.wrapper.get('[data-probe-consume]').trigger('click');
    assert.equal(f.dock.intents[pluginId], undefined);
    await f.router.push('/chats');
    await f.router.push(`/ext/${pluginId}`);
    await f.settle();
    assert.equal(f.dock.intents[pluginId], undefined);
  });

  for (const status of ['disabled', 'incompatible', 'no-panel', 'load-error']) {
    test(`EXT-STATE: ${status}→ready, чужой dock скрыт до готовности при ${width}px`, async (t) => {
      const card = externalCard();

      if (status === 'disabled') {
        card.enabled = false;
      } else if (status === 'incompatible') {
        card.compatibility = {
          status: 'incompatible',
          code: 'probe',
          reason: 'Понятная причина',
        };
      } else if (status === 'no-panel') {
        card.contributes.panels = [];
      }

      const f = await navigationFixture(t, width, {
        catalog: status === 'load-error' ? new Error('Каталог не прочитан') : [card],
      });

      f.dock.open('terminal');
      await f.login();
      assert.equal(f.wrapper.get('[data-plugin-route-state]').attributes('data-plugin-route-state'), status);
      assert.equal(f.wrapper.findAll('.tool-surface.is-dock').length, 0);
      assert.equal(f.imports.length, 0);
      assert.equal(f.router.currentRoute.value.query.model, 'модель 1');
      f.response([externalCard()]);

      if (status === 'load-error') {
        await f.wrapper.get('[data-plugin-route-action]').trigger('click');
        await f.settle();
      } else {
        await f.catalogChanged();
      }

      assert.equal(f.wrapper.findAll('[data-external-probe]').length, 1);
      assert.equal(f.imports.length, 1);
      assert.equal(f.dock.intents[pluginId].length, 1);
    });
  }
}

test('EXT-ADMISSION: retained карточка не принимает query до свежего catalog/access epoch', async (t) => {
  const barrier = Promise.withResolvers();
  const f = await navigationFixture(t, 900, {
    retained: [externalCard()],
    loaded: true,
    catalog: () => barrier.promise,
  });

  await f.login();
  assert.equal(f.wrapper.get('[data-plugin-route-state]').attributes('data-plugin-route-state'), 'loading');
  assert.equal(f.dock.intents[pluginId], undefined);
  assert.equal(f.router.currentRoute.value.query.model, 'модель 1');
  assert.equal(f.imports.length, 0);
  barrier.resolve({ plugins: [externalCard()] });
  await f.settle();
  assert.equal(f.dock.intents[pluginId].length, 1);
  assert.equal(f.imports.length, 1);
});

test('EXT-DOCK: removal закрывает runtime и сохраняет activeTool/геометрию до reinstall', async (t) => {
  const f = await navigationFixture(t, 900, { route: '/chats', catalog: [externalCard()] });

  await f.login();
  f.dock.open(pluginId);
  f.dock.setExpanded(true);
  await f.settle();
  assert.equal(f.imports.length, 1);
  f.response([]);
  await f.catalogChanged();
  assert.equal(f.dock.activeTool, pluginId);
  assert.equal(f.dock.expandedPreferences[pluginId], true);
  assert.equal(localStorage.getItem('grigdesk-dock-tool'), pluginId);
  assert.equal(f.dock.isOpen, false);
  assert.equal(f.dock.mounted[pluginId], undefined);
  assert.equal(f.dock.runtime[pluginId], undefined);
  f.response([externalCard()]);
  await f.catalogChanged();
  assert.equal(f.imports.length, 1);
  assert.equal(f.dock.activeTool, pluginId);
  f.dock.open(pluginId);
  await f.settle();
  assert.equal(f.dock.isExpanded, true);
  assert.equal(f.imports.length, 2);
});

test('EXT-BUILTIN: /ext/studio3d не подставляет builtin раздел при отсутствии пакета', async (t) => {
  const f = await navigationFixture(t, 900, {
    route: '/ext/studio3d?model=old',
    catalog: [pluginCard({ id: 'studio3d', system: true })],
  });

  await f.login();
  assert.equal(f.wrapper.get('[data-plugin-route-state]').attributes('data-plugin-route-state'), 'missing');
  assert.equal(f.dock.mounted.studio3d, undefined);
  assert.equal(f.router.currentRoute.value.query.model, 'old');
  assert.equal(f.imports.length, 0);
});

for (const width of [899, 900]) {
  test(`EXT-HOTKEY: default/custom/disabled внешней панели группы tools при ${width}px`,
    async (t) => {
      const card = externalCard();

      card.contributes.panels[0].hotkey = 'Ctrl+Shift+Digit8';

      const f = await navigationFixture(t, width, { route: '/chats', catalog: [card] });

      await f.login();

      const hotkeys = f.hotkeys.useHotkeysStore(f.pinia);
      const press = async (code) => {
        document.dispatchEvent(new f.browser.KeyboardEvent('keydown', {
          key: code === 'KeyY' ? 'Y' : '8',
          code,
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }));
        await f.settle();
      };
      const close = async () => {
        await f.router.push('/chats');
        f.dock.close();
        await f.settle();
      };

      await press('Digit8');
      assert.deepEqual(f.imports, [pluginId]);
      assert.equal(f.wrapper.findAll('[data-external-probe]').length, 1);
      await close();
      hotkeys.overrides = { [pluginId]: 'Ctrl+Shift+KeyY' };
      await press('Digit8');
      assert.deepEqual(f.imports, [pluginId]);
      assert.equal(f.router.currentRoute.value.path, '/chats');
      assert.equal(f.dock.isOpen, false);
      await press('KeyY');
      assert.equal(f.wrapper.findAll('[data-external-probe]').length, 1);

      const opened = f.dock.activeTool === pluginId
        || f.router.currentRoute.value.path === `/ext/${pluginId}`;

      assert.equal(opened, true);
      await close();

      const imports = f.imports.length;

      hotkeys.overrides = { [pluginId]: '' };
      await press('Digit8');
      await press('KeyY');
      assert.equal(f.imports.length, imports);
      assert.equal(f.router.currentRoute.value.path, '/chats');
      assert.equal(f.dock.isOpen, false);
    });
}

test('EXT-SETTINGS: старый page и сохранённый адрес выбирают общую карточку studio3d', async (t) => {
  const f = await navigationFixture(t, 900, { route: '/chats' });

  assert.equal(f.catalog.SETTINGS_PAGES.some((page) => page.id === 'tools.studio3d'), false);
  f.settings.requestOpen({ pageId: 'tools.studio3d', entityId: 'foreign-plugin' });
  assert.equal(f.settings.pageId, 'plugins.installed');
  assert.equal(f.settings.entityId, 'studio3d');
  f.settings.selectPage('interface.behavior');
  f.settings.requestOpen({ queryPage: 'tools.studio3d' });
  assert.equal(f.settings.pageId, 'plugins.installed');
  assert.equal(f.settings.entityId, 'studio3d');
  f.settings.isOpen = false;
  localStorage.setItem('grigdesk-settings-page', 'tools.studio3d');
  f.settings.requestOpen();
  assert.equal(f.settings.pageId, 'plugins.installed');
  assert.equal(f.settings.entityId, 'studio3d');
});

test('EXT-REDIRECT: настоящий router сохраняет query при переходе /3d на внешнюю панель', async (t) => {
  const f = await navigationFixture(t, 900, { route: '/chats' });
  const source = await import('node:fs/promises').then(({ readFile }) =>
    readFile(webFile('src/router.ts'), 'utf8'));
  const viewImports = [...source.matchAll(/import\('([^']+\.vue)'\)/g)].map((match) => match[1]);
  const stubs = Object.fromEntries(viewImports.map((file) => [file,
    'export const __esModule = true; export default { render: () => null };']));
  const { router } = await compileModule(webFile('src/router.ts'), { stubs });

  await router.push('/3d?tab=tasks&model=модель+1&version=β');
  await router.isReady();
  assert.equal(router.currentRoute.value.path, '/ext/studio3d');
  assert.deepEqual(router.currentRoute.value.query, {
    tab: 'tasks',
    model: 'модель 1',
    version: 'β',
  });
  assert.equal(router.getRoutes().some((route) => route.path === '/3d' && route.components), false);
  assert.equal(f.imports.length, 0);
});

test('EXT-RETRY-EPOCH: late ответ retry старого owner не подтверждает чужой retained каталог', async (t) => {
  const f = await navigationFixture(t, 900, { catalog: new Error('Ошибка каталога') });
  const barrier = Promise.withResolvers();

  await f.login();
  f.response(() => barrier.promise);
  await f.wrapper.get('[data-plugin-route-action]').trigger('click');
  await f.settle();
  f.response([]);
  f.auth.clientScope = 'owner B';
  await f.settle();
  barrier.resolve({ plugins: [externalCard()] });
  await f.settle();
  assert.equal(f.wrapper.get('[data-plugin-route-state]').attributes('data-plugin-route-state'), 'missing');
  assert.equal(f.plugins.list.length, 0);
  assert.equal(f.imports.length, 0);
  assert.equal(f.dock.intents[pluginId], undefined);
  assert.equal(f.router.currentRoute.value.query.model, 'модель 1');
});

test('EXT-PREFS: cold boot без выбранного пакета сохраняет id и expanded preference', async (t) => {
  const f = await navigationFixture(t, 900, { route: '/chats' });

  f.dock.rememberTool(pluginId);
  f.dock.expandedPreferences[pluginId] = true;
  await f.login();
  assert.equal(f.dock.activeTool, pluginId);
  assert.equal(f.dock.expandedPreferences[pluginId], true);
  assert.equal(localStorage.getItem('grigdesk-dock-tool'), pluginId);
  assert.equal(f.dock.isOpen, false);
  assert.equal(f.imports.length, 0);
});
