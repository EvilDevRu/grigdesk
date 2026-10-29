import assert from 'node:assert/strict';
import test from 'node:test';
import { descriptor, pluginCard } from './helpers/pluginModuleContract.js';
import { serviceFixture } from './helpers/pluginModuleServices.js';
import { deferred, settle } from './helpers/pluginRuntimeUnit.js';

/**
 * Реестр получает управляемые порты загрузки, сохраняя настоящие сервисы и срок контекста.
 * Задержки import, словарей и hook независимы: поздний успех нельзя принять за новый вход.
 */
async function lifecycleFixture(t, options = {}) {
  const f = await serviceFixture(t, 'pluginRuntime/runtime.ts');
  const cards = f.vue.reactive([pluginCard({ webModule: { ...descriptor, startOnLogin: true } })]);
  const calls = {
    loads: [],
    contexts: [],
    starts: [],
    cleanups: []
  };
  const module = {
    component: { render: () => null },
    start: options.start ?? ((context) => {
      calls.starts.push(context);

      return () => calls.cleanups.push(context);
    }),
    releaseStyles: () => {},
  };
  const plugins = { byId: (id) => cards.find((card) => card.id === id) ?? null };
  const registry = f.createPluginRuntime({
    plugins,
    router: { currentRoute: f.vue.ref({
      path: '/chats',
      meta: {},
      params: {}
    }), push: async () => {} },
    dock: {
      isOpen: false,
      activeTool: null,
      runtime: {}
    },
    loadPluginModule: async (id, value, init) => {
      calls.loads.push([id, value, init]);

      return options.load ? await options.load(id, value, init) : module;
    },
    createPluginContext: async (id, value, port, init) => {
      calls.contexts.push([id, init]);

      if (options.context) {
        return await options.context(id, value, port, init);
      }

      return {
        pluginId: id,
        api: {},
        locale: f.ui.uiLocale,
        settings: f.vue.computed(() => port.byId(id)?.values ?? {}),
        t: (key) => key,
      };
    },
  });

  t.after(() => registry.dispose());

  return {
    ...f,
    cards,
    calls,
    module,
    registry,
    descriptor: cards[0].webModule
  };
}

test('PM-SINGLE-RUNTIME: pending load, start и context общие у фона и панелей', async (t) => {
  const pending = deferred();
  const f = await lifecycleFixture(t, { load: () => pending.promise });
  const background = f.registry.startBackground('ui-module', f.descriptor);
  const first = f.registry.acquirePanel('ui-module', f.descriptor, { active: true });
  const second = f.registry.acquirePanel('ui-module', f.descriptor, { active: true });

  await settle();
  assert.equal(f.calls.loads.length, 1);
  assert.equal(f.calls.loads[0][2].styles, false);
  assert.equal(document.querySelectorAll('link[rel="stylesheet"]').length, 0);
  pending.resolve(f.module);

  const [started, panel, another] = await Promise.all([background, first, second]);

  assert.equal(f.calls.contexts.length, 1);
  assert.equal(f.calls.starts.length, 1);
  assert.equal(started.context === panel.context && panel.context === another.context, true);
  assert.equal(f.calls.starts[0] === panel.context, true);

  for (const active of [false, true, false, true]) {
    panel.setActive(active);
  }

  f.cards[0].values = { greeting: 'Новые настройки' };
  f.ui.setUiLocale('en');
  panel.release();
  panel.release();
  another.release();

  const reopened = await f.registry.acquirePanel('ui-module', f.descriptor, { active: true });

  assert.equal(reopened.context === started.context, true);
  assert.equal(f.calls.loads.length, 1);
  assert.equal(f.calls.starts.length, 1);
  assert.equal(f.calls.cleanups.length, 0);
  reopened.release();

  let toasts = [];
  const stopToasts = f.ui.subscribeToasts((value) => toasts = value);

  t.after(() => {
    stopToasts();
    f.ui.dismissAllToasts();
  });
  assert.equal(started.context.alerts.show({
    id: 'pending',
    title: 'Фоновый',
    sticky: true
  }), true);
  assert.equal(toasts.length, 1);
  f.registry.stop('ui-module');
  assert.equal(toasts.length, 0);
  f.registry.stop('ui-module');
  assert.equal(started.context.signal.aborted, true);
  assert.equal(f.calls.cleanups.length, 1);
  f.cards[0].values = { greeting: 'Другой вход' };

  const next = await f.registry.startBackground('ui-module', f.descriptor);

  assert.equal(next.context === started.context, false);
  assert.deepEqual(started.context.settings.value, {});
  assert.equal(started.context.alerts.show({ id: 'old', title: 'Старый владелец' }), false);
  assert.equal(await started.context.panel.open(), false);
  f.ui.setUiLocale('ru');
});

test('PM-SINGLE-RUNTIME: без фона последний unmount отзывает context и подписки', async (t) => {
  const f = await lifecycleFixture(t);
  const panel = await f.registry.acquirePanel('ui-module', descriptor, { active: true });
  const previous = panel.context;

  assert.equal(f.calls.starts.length, 0);
  panel.release();
  assert.equal(previous.signal.aborted, true);

  const next = await f.registry.acquirePanel('ui-module', descriptor, { active: true });

  assert.equal(next.context === previous, false);
  next.release();
});

for (const phase of ['import', 'dictionaries', 'async-start']) {
  for (const reason of ['disable', 'logout']) {
    test(`PM-STOP-RACE: ${reason} во время ${phase} не оживляет старый context`, async (t) => {
      const pending = deferred();
      let captured;
      let lateCleanup = 0;
      const f = await lifecycleFixture(t, {
        ...(phase === 'import' ? { load: () => pending.promise } : {}),
        ...(phase === 'dictionaries' ? { context: async (id, value, port, init) => {
          await pending.promise;

          return {
            pluginId: id,
            api: {},
            locale: { value: 'ru' },
            settings: { value: port.byId(id)?.values ?? {} },
            t: (key) => key,
          };
        } } : {}),
        ...(phase === 'async-start' ? { start: async (context) => {
          captured = context;
          await pending.promise;

          return () => lateCleanup += 1;
        } } : {}),
      });
      const started = f.registry.startBackground('ui-module', f.descriptor);

      started.catch(() => {});
      await settle();

      if (reason === 'disable') {
        f.cards[0].enabled = false;
        f.registry.stop('ui-module');
      } else {
        f.registry.dispose();
      }

      assert.equal(f.calls.loads[0][2].signal.aborted, true);

      if (captured) {
        assert.equal(captured.signal.aborted, true);
        assert.equal(captured.alerts.show({ id: 'late', title: 'Поздний' }), false);
        assert.equal(await captured.panel.open(), false);
        assert.equal(captured.panel.setExpanded(true), false);
        await assert.rejects(captured.askAgent({
          workdir: { kind: 'grigdesk' },
          title: 'Поздний',
          draft: '',
        }));
      }

      pending.resolve(phase === 'import' ? f.module : undefined);
      await started.catch(() => {});
      await settle();
      assert.equal(f.calls.starts.length, 0);
      assert.equal(lateCleanup, phase === 'async-start' ? 1 : 0);
      assert.equal(document.querySelectorAll('link[rel="stylesheet"]').length, 0);
    });
  }
}

test('PM-START-FAILURE: неверный/упавший hook изолирован; no-opt-in не выполняется', async (t) => {
  const f = await lifecycleFixture(t);

  f.module.start = () => {
    throw new Error('Сломанный hook');
  };
  await assert.rejects(f.registry.startBackground('ui-module', f.descriptor));
  f.registry.stop('ui-module');

  const otherDescriptor = {
    entry: '/api/ext/healthy/module/panel.js',
    css: [],
    locales: {},
    startOnLogin: true
  };

  f.cards.push(pluginCard({ id: 'healthy', webModule: otherDescriptor }));
  f.module.start = (context) => {
    f.calls.starts.push(context);

    return () => {
      throw new Error('Сломанный cleanup');
    };
  };
  await f.registry.startBackground('healthy', otherDescriptor);
  assert.equal(f.calls.starts.length, 1);
  assert.doesNotThrow(() => f.registry.stop('healthy'));
  f.cards[0].enabled = true;

  for (const start of [undefined, 42]) {
    f.module.start = start;
    await assert.rejects(f.registry.startBackground('ui-module', f.descriptor));
    f.registry.stop('ui-module');
  }

  f.module.start = () => assert.fail('Нет opt-in, start не должен вызываться');

  const panel = await f.registry.acquirePanel('ui-module', descriptor, { active: true });

  panel.release();
});
