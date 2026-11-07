import assert from 'node:assert/strict';
import test from 'node:test';

import { pluginCard } from './helpers/pluginModuleContract.js';
import { serviceFixture } from './helpers/pluginModuleServices.js';

const pluginId = 'ui-module';

/**
 * URL всех ресурсов разделяет поколение, включая независимый background entry.
 * Panel/CSS остаются объявленными, но отсутствие спроса не должно загружать их.
 */
function descriptor(generation = 'generation-1') {
  const prefix = `/api/ext/${pluginId}/module/${generation}`;

  return {
    entry: `${prefix}/panel.js`,
    background: `${prefix}/background.js`,
    css: [`${prefix}/panel.css`],
    locales: { ru: `${prefix}/ru.json`, en: `${prefix}/en.json` },
  };
}

/**
 * Реальный bootstrap и runtime получают только управляемые import/HTTP границы.
 * Probe считает начало, signal и cleanup, не имитируя сам coordinator.
 */
async function backgroundFixture(t, options = {}) {
  const f = await serviceFixture(t, 'pluginRuntime/bootstrap.ts', {
    auths: 'stores/auth.ts',
    shells: 'stores/shell.ts',
    plugins: 'stores/plugins.ts',
    docks: 'stores/dock.ts',
    alerts: 'shared/alerts.ts',
    transport: 'shared/apiClient.ts',
  }, {
    '../shared/desktopSettings.ts': `export const currentDesktopMode = () => ${JSON.stringify(
      options.surface ? 'surface' : 'page')};`,
  });
  const pinia = f.pinia.createPinia();

  f.pinia.setActivePinia(pinia);

  const auth = f.auths.useAuthStore(pinia);
  const shell = f.shells.useShellStore(pinia);
  const plugins = f.plugins.usePluginsStore(pinia);
  const imports = [];
  const starts = [];
  const cleanups = [];
  const listeners = new Set();
  const requests = [];
  const uiStarts = [];
  const panelImports = [];
  let hook = async (context) => () => cleanups.push(context);
  let catalog = [pluginCard({ runtimeGeneration: 'generation-1', entrypoints: { web: descriptor() } })];
  let toasts = [];
  const off = f.ui.subscribeToasts((value) => toasts = value);

  t.mock.method(document, 'hasFocus', () => true);
  t.mock.method(f.transport.api, 'get', async (path) => {
    requests.push(path);

    if (path === '/api/plugins') {
      return { plugins: catalog };
    }

    if (path === '/api/plugins/notifications') {
      return { plugins: [] };
    }

    if (path.endsWith('/ru.json')) {
      return { greeting: 'Привет' };
    }

    if (path.endsWith('/en.json')) {
      return { greeting: 'Hello' };
    }

    assert.equal(path, '/api/probe');

    return { ok: true };
  });

  shell.initialized = true;
  shell.present = true;
  shell.snapshot = { status: 'online', profile: { id: 'fixture-profile' } };

  const router = { currentRoute: f.vue.ref({ path: '/chats', meta: {}, params: {} }), push: async () => {} };
  const dispose = f.installPluginRuntime(pinia, router, {
    subscribe: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    backgroundImport: async (path) => {
      imports.push(path);

      if (path === 'vue') {
        return options.invalidVue ? { ...f.vue, ref: () => ({}) } : f.vue;
      }

      if (path === '@grigdesk/ui') {
        return f.ui;
      }

      assert.ok(path.endsWith('/background.js'));

      if (options.importGate) {
        await options.importGate;
      }

      return options.invalidModule ? {} : { start: (context) => {
        starts.push(context);

        return hook(context);
      } };
    },
    loadPluginModule: async (id) => {
      panelImports.push(id);

      return {
        component: { render: () => null },
        releaseStyles() {},
        start: async (context) => {
          uiStarts.push(context);

          if (context.backgroundReady) {
            await context.backgroundReady();
          }
        },
      };
    },
  });
  const settle = async () => {
    for (let turn = 0; turn < 6; turn += 1) {
      await f.vue.nextTick();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  t.after(() => {
    dispose();
    off();
    f.ui.dismissAllToasts();
    f.ui.setUiLocale('ru');
  });

  return {
    ...f,
    pinia,
    auth,
    shell,
    plugins,
    imports,
    starts,
    cleanups,
    requests,
    uiStarts,
    panelImports,
    settle,
    dispose,
    runtime: f.pluginRuntimeFor(pinia),
    toasts: () => toasts,
    hook: (value) => hook = value,
    catalog: (value) => catalog = value,
    emit: (name, data) => {
      for (const listener of [...listeners]) {
        listener(name, data);
      }
    },
    login: async (scope = 'owner A') => {
      auth.$patch({ ready: true, authenticated: true, clientScope: scope });
      await settle();
    },
  };
}

test('PB-COLD: фон стартует после auth/catalog без panel/CSS, context остаётся readonly', async (t) => {
  const f = await backgroundFixture(t);

  assert.equal(f.starts.length, 0);
  assert.equal(f.imports.length, 0);
  await f.login();
  assert.equal(f.starts.length, 1);
  assert.equal(f.panelImports.length, 0);
  assert.equal(document.querySelectorAll('link[rel="stylesheet"]').length, 0);

  const context = f.starts[0];

  assert.equal(context.pluginId, pluginId);
  assert.equal(context.signal.aborted, false);
  assert.equal(context.t('greeting'), 'Привет');
  assert.equal(f.vue.isReadonly(context.settings), true);
  assert.deepEqual(await context.api.get('/api/probe'), { ok: true });
  f.plugins.list[0].values = { greeting: 'Настройки изменены' };
  f.ui.setUiLocale('en');
  await f.settle();
  assert.equal(context.settings.value.greeting, 'Настройки изменены');
  assert.equal(context.t('greeting'), 'Hello');
  assert.equal(f.starts.length, 1);
  assert.equal(f.cleanups.length, 0);
});

test('PB-READY-ABORT: отзыв фона немедленно отклоняет ожидающую панель до late start', async (t) => {
  const f = await backgroundFixture(t);
  const barrier = Promise.withResolvers();

  f.hook(async (context) => {
    await barrier.promise;

    return () => f.cleanups.push(context);
  });
  await f.login();

  let outcome = 'waiting';
  const panel = f.runtime.acquirePanel(pluginId, descriptor()).then(() => {
    outcome = 'resolved';
  }, () => {
    outcome = 'rejected';
  });

  await f.settle();
  f.plugins.list[0].enabled = false;
  await f.settle();

  try {
    assert.equal(outcome, 'rejected');
  } finally {
    barrier.resolve();
    await panel;
  }

  await f.settle();
  assert.equal(f.cleanups.length, 1);
});

test('PB-LATE-IMPORT: выключение до завершения import не исполняет старый start', async (t) => {
  const barrier = Promise.withResolvers();
  const f = await backgroundFixture(t, { importGate: barrier.promise });

  await f.login();
  assert.equal(f.starts.length, 0);
  assert.ok(f.imports.some((path) => path.endsWith('/background.js')));
  f.plugins.list[0].enabled = false;
  await f.settle();
  barrier.resolve();
  await f.settle();
  assert.equal(f.starts.length, 0);
  assert.equal(f.toasts().length, 0);
});

test('PB-LOAD-TIMEOUT: зависший import ограничен 30 секундами, retry не исполняет late модуль', async (t) => {
  const barrier = Promise.withResolvers();
  const f = await backgroundFixture(t, { importGate: barrier.promise });

  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.login();
  assert.equal(f.starts.length, 0);
  t.mock.timers.tick(30001);
  await f.settle();
  assert.equal(f.toasts().length, 1);
  assert.equal(f.starts.length, 0);
  barrier.resolve();
  await f.settle();
  assert.equal(f.starts.length, 0);
});

test('PB-EXPLICIT-RETRY: кнопка ошибки запускает одну новую попытку без панели', async (t) => {
  const f = await backgroundFixture(t);

  f.hook(async () => {
    throw new Error('Probe failure');
  });
  await f.login();
  assert.equal(f.starts.length, 1);
  f.hook(async (context) => () => f.cleanups.push(context));

  const retry = f.toasts()[0].actions.find((action) => action.id === 'retry');

  assert.ok(retry);
  await retry.run();
  assert.equal(f.starts.length, 2);
  assert.equal(f.toasts().length, 0);
  assert.equal(f.panelImports.length, 0);
});

test('PB-SINGLEFLIGHT: boot и первая панель ждут один start, release панели сохраняет фон', async (t) => {
  const f = await backgroundFixture(t);
  const barrier = Promise.withResolvers();

  f.hook(async (context) => {
    await barrier.promise;

    return () => f.cleanups.push(context);
  });
  await f.login();
  assert.equal(f.starts.length, 1);

  const panel = f.runtime.acquirePanel(pluginId, descriptor());

  await f.settle();
  assert.equal(f.starts.length, 1);
  assert.equal(f.uiStarts.length, 1);
  barrier.resolve();

  const lease = await panel;

  assert.equal(typeof lease.context.backgroundReady, 'function');
  await Promise.all([lease.context.backgroundReady(), lease.context.backgroundReady()]);
  lease.release();
  assert.equal(f.starts[0].signal.aborted, false);
  assert.equal(f.cleanups.length, 0);
  f.dispose();
  assert.equal(f.starts[0].signal.aborted, true);
  assert.equal(f.cleanups.length, 1);
});

for (const mutation of ['disabled', 'removed', 'owner', 'offline', 'update', 'logout']) {
  test(`PB-REVOKE: ${mutation} abort сразу, late cleanup старого start выполняется один раз`, async (t) => {
    const f = await backgroundFixture(t);
    const barrier = Promise.withResolvers();

    f.hook(async (context) => {
      await barrier.promise;

      return () => {
        f.cleanups.push(context);
        context.alerts.clear();
      };
    });
    await f.login();
    assert.equal(f.starts.length, 1);

    const first = f.starts[0];

    if (mutation === 'disabled') {
      f.plugins.list[0].enabled = false;
    } else if (mutation === 'removed') {
      f.plugins.list = [];
    } else if (mutation === 'owner') {
      f.auth.clientScope = 'owner B';
    } else if (mutation === 'offline') {
      f.shell.snapshot = { status: 'offline', profile: { id: 'fixture-profile' } };
    } else if (mutation === 'logout') {
      f.auth.authenticated = false;
    } else {
      f.plugins.list = [pluginCard({
        runtimeGeneration: 'generation-2',
        entrypoints: { web: descriptor('generation-2') },
      })];
    }

    await f.settle();
    assert.equal(first.signal.aborted, true);

    if (mutation === 'owner' || mutation === 'update') {
      assert.equal(f.starts.length, 2);
      f.starts[1].alerts.show({ id: 'new', title: 'Новый фон', sticky: true });
    }

    barrier.resolve();
    await f.settle();
    assert.equal(f.cleanups.filter((context) => context === first).length, 1);

    if (mutation === 'owner' || mutation === 'update') {
      assert.equal(f.starts[1].signal.aborted, false);
      assert.equal(f.toasts().length, 1);
      assert.equal(f.toasts()[0].scope, `plugin-background:${pluginId}`);
    }

    f.dispose();
    await f.settle();
    assert.equal(f.cleanups.filter((context) => context === first).length, 1);
  });
}

test('PB-RETRY: ошибка start видна, явный backgroundReady повторяет одну попытку', async (t) => {
  const f = await backgroundFixture(t);

  f.hook(async () => {
    throw new Error('Probe failure');
  });
  await f.login();
  assert.equal(f.starts.length, 1);
  assert.equal(f.toasts().length, 1);
  assert.equal(f.toasts()[0].tone, 'warning');
  f.emit('state-change', { plugins: true });
  await f.settle();
  assert.equal(f.starts.length, 1);
  f.hook(async (context) => () => f.cleanups.push(context));

  const lease = await f.runtime.acquirePanel(pluginId, descriptor());

  assert.equal(f.starts.length, 2);
  assert.equal(f.toasts().length, 0);
  await lease.context.backgroundReady();
  assert.equal(f.starts.length, 2);
  lease.release();
  assert.equal(f.cleanups.length, 0);
});

test('PB-IMPORT-GATE: неверная общая Vue не исполняет background entry', async (t) => {
  const f = await backgroundFixture(t, { invalidVue: true });

  await f.login();
  assert.equal(f.toasts().length, 1);
  assert.equal(f.starts.length, 0);
  assert.equal(f.imports.some((path) => path.endsWith('/background.js')), false);
  assert.equal(f.panelImports.length, 0);
});

test('PB-ENTRY-CONTRACT: модуль без start даёт локальную ошибку до эффектов', async (t) => {
  const f = await backgroundFixture(t, { invalidModule: true });

  await f.login();
  assert.equal(f.toasts().length, 1);
  assert.equal(f.starts.length, 0);
  assert.equal(f.panelImports.length, 0);
});

test('PB-OPTIONAL: пакет без background сохраняет прежний спрос UI и отсутствие backgroundReady', async (t) => {
  const f = await backgroundFixture(t);
  const web = descriptor();

  delete web.background;
  f.catalog([pluginCard({ runtimeGeneration: 'generation-1', entrypoints: { web } })]);
  await f.login();
  assert.equal(f.imports.length, 0);

  const lease = await f.runtime.acquirePanel(pluginId, web);

  assert.equal(lease.context.backgroundReady, undefined);
  assert.equal(f.uiStarts.length, 1);
  assert.equal(f.starts.length, 0);
  lease.release();
});

for (const state of ['surface', 'disabled', 'incompatible']) {
  test(`PB-ADMISSION: ${state} не импортирует фоновый код`, async (t) => {
    const f = await backgroundFixture(t, { surface: state === 'surface' });

    if (state !== 'surface') {
      f.catalog([pluginCard({
        enabled: state !== 'disabled',
        compatibility: state === 'incompatible'
          ? { status: 'incompatible', code: 'probe', reason: 'Probe' }
          : { status: 'compatible', code: null, reason: null },
        runtimeGeneration: 'generation-1',
        entrypoints: { web: descriptor() },
      })]);
    }

    await f.login();
    assert.equal(f.imports.length, 0);
    assert.equal(f.starts.length, 0);
    assert.equal(f.panelImports.length, 0);
  });
}
