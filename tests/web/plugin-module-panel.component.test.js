import { measured } from './helpers/performance-surface.js';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';
import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { descriptor, pluginCard } from './helpers/pluginModuleContract.js';
import { deferred } from './helpers/pluginRuntimeUnit.js';

/**
 * Панель и её граница ошибок настоящие; только асинхронные порты управляются тестом.
 * UI и context используют один реальный locale ref без сети или данных владельца.
 */
async function panelFixture(t, options = {}) {
  const browser = await installUiBrowser(t);
  const present = await access(webFile('src/views/ext/PluginModulePanel.vue')).then(() => true, () => false);

  assert.equal(present, true, 'Не реализована Vue-панель пользовательского модуля');

  const [vue, utils, ui] = await Promise.all([
    import('../../web/node_modules/vue/index.mjs'),
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileModule(webFile('src/ui.ts')),
  ]);
  const state = {

    calls: [],

    releases: [],

    store: vue.reactive({ card: pluginCard() }),

    ui,

    load: options.load,

    context: options.context,
    styles: options.styles ?? (async () => () => {}),
    listeners: new Set(),
    backgroundStarts: 0,
    backgroundCleanups: 0,
    usingRegistry: false,
    panelActive: vue.ref(true),

  };
  const child = {
    props: ['context', 'active', 'compact', 'presentation'],
    /**
     * Локальный ввод и счётчик mount различают скрытие панели и пересоздание компонента.
     * Событие регистрируется в Vue scope, чтобы проверять настоящий путь снятия подписки.
     */
    setup(props) {
      const text = vue.ref('');

      state.mounts = (state.mounts || 0) + 1;
      props.context.events?.on('tick', () => {
        state.deliveries = (state.deliveries || 0) + 1;
      });

      return () => vue.h('section', { 'data-module-child': props.context.pluginId }, [
        vue.h(ui.UiInput, {
          modelValue: text.value,
          'onUpdate:modelValue': (value) => {
             text.value = value;
          },
        }),
        vue.h(ui.UiButton, {}, () => props.context.t('greeting')),
        vue.h('output', {}, JSON.stringify(props.context.settings.value)),
        vue.h('span', {}, `${props.active}/${props.compact}/${props.presentation}`),
      ]);
    },
  };

  state.load ??= async (id) => ({
    component: child,
    releaseStyles: () => state.releases.push(id),
    start: () => {
      state.backgroundStarts += 1;

      return () => state.backgroundCleanups += 1;
    },
  });
  state.context ??= async (id) => ({

    pluginId: id,

    api: {},

    locale: ui.uiLocale,

    settings: vue.readonly(vue.computed(() => state.store.card.values)),

    t: () => ui.uiLocale.value === 'ru' ? 'Привет' : 'Hello',

  });
  globalThis.__modulePanelTest = state;

  const eventStubs = {
    '../composables/useSse.ts': `
      export const sseSubscribe = (listener) => {
        const listeners = globalThis.__modulePanelTest.listeners;
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
    `,
  };

  if (options.events) {
    const exists = await access(webFile('src/pluginRuntime/events.ts')).then(() => true, () => false);

    assert.equal(exists, true, 'Не реализована доставка событий скрытой панели');

    const { createPluginEvents } = await compileModule(webFile('src/pluginRuntime/events.ts'), {
      stubs: eventStubs,
    });
    const baseContext = state.context;

    state.context = async (...args) => ({
      ...await baseContext(...args),
      events: createPluginEvents(args[0], {
        signal: args[3].signal,
        panelActive: state.panelActive,
        backgroundActive: vue.ref(false),
      }),
    });
  }

  state.runtime = {
    acquirePanel: async (id, value, init) => {
      state.calls.push([id, value, init]);

      const loaded = await state.load(id, value, init);
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          loaded.releaseStyles();
        }
      };

      try {
        const context = await state.context(id, value, state.store, init);

        return {
          component: loaded.component,
          context,
          release,
          setActive: (active) => state.panelActive.value = active,
        };
      } catch (error) {
        release();

        throw error;
      }
    },
    stop: () => state.backgroundCleanups += 1,
    dispose: () => state.backgroundCleanups += 1,
  };

  if (options.realRuntime) {
    const exists = await access(webFile('src/pluginRuntime/runtime.ts')).then(() => true, () => false);

    assert.equal(exists, true, 'Не реализован общий registry фонового модуля и панели');

    const { createPluginRuntime } = await compileModule(webFile('src/pluginRuntime/runtime.ts'), {
      stubs: eventStubs,
    });

    state.store.card.entrypoints = { web: options.descriptor };
    state.store.card.contributes = { panels: [{}], slots: [{
      slot: 'provider.popover.after-bars', kind: 'provider-usage',
    }] };
    state.store.card.placements = [{ slot: 'provider.popover.after-bars', enabled: true }];
    state.runtime = createPluginRuntime({
      plugins: { byId: () => state.store.card },
      router: { currentRoute: vue.ref({
        path: '/chats',
        meta: {},
        params: {}
      }), push: async () => {} },
      dock: {
        isOpen: false,
        activeTool: null,
        runtime: {}
      },
      loadPluginModule: (...args) => {
        state.calls.push(args);

        return state.load(...args);
      },
      createPluginContext: state.context,
    });
    t.after(() => state.runtime.dispose());
    await state.runtime.acquireSlot('ui-module', 'provider.popover.after-bars');
  }

  const facade = Object.keys(ui).map((name) =>
    `export const ${name} = globalThis.__modulePanelTest.ui.${name};`).join('\n');
  const panel = await compileVue(webFile('src/views/ext/PluginModulePanel.vue'), {
    stubs: {

      '../../pluginRuntime/loader.ts': `
        export const loadPluginModule = (...args) => {
          globalThis.__modulePanelTest.calls.push(args);
          return globalThis.__modulePanelTest.load(...args);
        };
      `,

      '../../pluginRuntime/bootstrap.ts': `
        export const pluginRuntimeFor = () => {
          globalThis.__modulePanelTest.usingRegistry = true;
          return globalThis.__modulePanelTest.runtime;
        };
      `,

      '../../pluginRuntime/styles.ts': `
        export const loadPluginStyles = (...args) => globalThis.__modulePanelTest.styles(...args);
      `,

      '../../pluginRuntime/context.ts': `
        export const createPluginContext = (...args) => globalThis.__modulePanelTest.context(...args);
      `,

      '../../stores/plugins.ts': `
        export const usePluginsStore = () => ({ byId: () => globalThis.__modulePanelTest.store.card });
      `,

      '../../ui.ts': facade,

    },
  });
  let clicks = 0;
  const panelProps = vue.reactive({

     pluginId: 'ui-module',

    descriptor: options.descriptor ?? descriptor,

    label: 'Модуль проверки'

  });
  const root = utils.mount({
    setup: () => () => vue.h('main', {}, [
      vue.h(ui.UiButton, { class: 'healthy', onClick: () => {
         clicks += 1;
      } }, () => 'Сосед'),
      vue.h(panel, panelProps),
    ]),
  }, { attachTo: document.body });
  const wrapper = root.findComponent(panel);
  const settle = async () => {
    await utils.flushPromises();
    await vue.nextTick();
  };

  t.after(() => {
    root.unmount();
    ui.setUiLocale('ru');
    delete globalThis.__modulePanelTest;
  });
  await settle();

  return {

    browser,
    vue,
    ui,
    root,
    wrapper,
    state,
    settle,

    updateProps: async (patch) => {
       Object.assign(panelProps, patch);
      await settle();
    },

    clicks: () => clicks,

  };
}

test('PM-PANEL: default получает context/props, язык и values сохраняют DOM/ввод', async (t) => {
  const f = await panelFixture(t);

  await f.updateProps({

     active: true,

    compact: true,

    presentation: 'dock'

  });
  await f.settle();
  assert.match(f.wrapper.text(), /true\/true\/dock/);

  const input = f.wrapper.get('input');

  await input.setValue('Черновик');
  f.ui.setUiLocale('en');
  f.state.store.card.values = { greeting: 'Обновлено' };
  await f.settle();
  assert.match(f.wrapper.text(), /Hello/);
  assert.match(f.wrapper.text(), /Обновлено/);
  assert.equal(f.wrapper.get('input').element === input.element, true);
  assert.equal(f.wrapper.get('input').element.value, 'Черновик');
  assert.equal(f.state.calls.length, 1);
  await f.root.get('.healthy').trigger('click');
  assert.equal(f.clicks(), 1);
});

for (const variant of ['unsupported', 'import', 'empty-default', 'css', 'json', 'setup', 'render']) {
  test(`PM-FAILURES: ${variant} локализуется RU/EN, сосед работает, CSS освобождён`, async (t) => {
    const failure = Object.assign(new Error('<b>Внутренняя ошибка</b>'), {
      code: variant === 'unsupported' ? 'unsupported' : 'load-failed',
    });
    const releases = [];
    const broken = variant === 'setup'
      ? { setup: () => {
         throw failure;
      } }
      : { render: () => {
         throw failure;
      } };
    const f = await panelFixture(t, {
      load: async () => {
        if (['unsupported', 'import', 'empty-default'].includes(variant)
          || variant === 'css' && !globalThis.__modulePanelTest.usingRegistry) {
          throw failure;
        }

        return { component: broken, releaseStyles: () => releases.push('css') };
      },
      ...(variant === 'css' ? { styles: async () => {
        throw failure;
      } } : {}),
      ...(variant === 'json' ? { context: async () => {
         throw failure;
      } } : {}),
    });
    const key = variant === 'unsupported' ? 'core.pluginModuleUnsupported'
      : ['setup', 'render'].includes(variant)
        ? 'core.pluginModuleRenderFailed' : 'core.pluginModuleLoadFailed';

    const russian = f.ui.t(key, { name: 'Модуль проверки' });

    assert.ok(russian && russian !== key && russian.includes('Модуль проверки'));
    assert.ok(f.wrapper.text().includes(russian));
    assert.equal(f.wrapper.find('[data-module-child]').exists(), false);
    assert.equal(f.wrapper.find('b').exists(), false);
    f.ui.setUiLocale('en');
    await f.settle();

    const english = f.ui.t(key, { name: 'Модуль проверки' });

    assert.ok(english && english !== key && english.includes('Модуль проверки'));
    assert.notEqual(english, russian);
    assert.ok(f.wrapper.text().includes(english));
    await f.root.get('.healthy').trigger('click');
    assert.equal(f.clicks(), 1);

    if (['setup', 'render', 'json'].includes(variant)) {
      assert.equal(releases.length, 1);
    }
  });
}

test('PM-PANEL-RACE: смена id и unmount игнорируют старый load и освобождают его CSS', async (t) => {
  const pending = [];
  const released = [];
  const f = await panelFixture(t, {
    load: (id) => {
      const value = deferred();

      pending.push({ id, ...value });

      return value.promise;
    },
  });

  await f.updateProps({ pluginId: 'new-module', descriptor: {

    entry: '/api/ext/new-module/module/panel.js',
    css: [],
    locales: {},

  } });
  await f.settle();
  assert.equal(pending.length, 2);
  assert.equal(f.state.calls[0][2].signal.aborted, true);
  pending[1].resolve({
    component: { render: () => f.vue.h('p', { 'data-latest': '' }, 'Новый') },
    releaseStyles: () => released.push('new'),
  });
  await f.settle();
  pending[0].resolve({
    component: { render: () => f.vue.h('p', { 'data-stale': '' }, 'Старый') },
    releaseStyles: () => released.push('old'),
  });
  await f.settle();
  assert.equal(f.wrapper.find('[data-latest]').exists(), true);
  assert.equal(f.wrapper.find('[data-stale]').exists(), false);
  assert.deepEqual(released, ['old']);

  await f.updateProps({ pluginId: 'last-module', descriptor: {

    entry: '/api/ext/last-module/module/panel.js',
    css: [],
    locales: {},

  } });
  await f.settle();
  f.root.unmount();
  pending[2].resolve({
    component: { render: () => f.vue.h('p', {}, 'Поздний') },
    releaseStyles: () => released.push('last'),
  });
  await f.settle();
  assert.deepEqual(released.sort(), ['last', 'new', 'old']);
  assert.equal(document.querySelectorAll('[data-ui-modal-root]').length, 0);
});


test('PM-PANEL-HIDDEN-STATE: active=false → true сохраняет DOM, ввод и один mount', async (t) => {
  const f = await panelFixture(t);
  const input = f.wrapper.get('input');

  await input.setValue('Скрытый черновик');
  await f.updateProps({ active: false });
  assert.equal(f.wrapper.get('input').element === input.element, true);
  await f.updateProps({ active: true });
  assert.equal(f.wrapper.get('input').element === input.element, true);
  assert.equal(f.wrapper.get('input').element.value, 'Скрытый черновик');
  assert.equal(f.state.mounts, 1);
  assert.equal(f.state.calls.length, 1);
});


test('PM-PANEL-VISIBILITY: active=false снимает доставку, DOM и ввод сохраняются', async (t) => {
  const f = await panelFixture(t, { events: true });
  const input = f.wrapper.get('input');
  const emit = () => {
    for (const listener of f.state.listeners) {
      listener('plugin-event', {
        pluginId: 'ui-module',
        event: 'tick',
        data: 1
      });
    }
  };

  await input.setValue('Черновик с подпиской');
  emit();
  assert.equal(f.state.deliveries, 1);
  await f.updateProps({ active: false });
  emit();
  assert.equal(f.state.deliveries, 1);
  assert.equal(f.wrapper.get('input').element === input.element, true);
  await f.updateProps({ active: true });
  emit();
  assert.equal(f.state.deliveries, 2);
  assert.equal(f.wrapper.get('input').element.value, 'Черновик с подпиской');
  assert.equal(f.state.mounts, 1);
});

for (const failed of [false, true]) {
  test(`PM-PANEL-CSS-ORDER: стили до mount, отказ локален (failed=${failed})`, async (t) => {
    const pending = deferred();
    const stylesCalls = [];
    const f = await panelFixture(t, {
      realRuntime: true,
      descriptor: { ...descriptor, startOnLogin: true },
      styles: async (urls, signal) => {
        stylesCalls.push([urls, signal]);
        await pending.promise;

        if (failed) {
          throw new Error('CSS панели недоступен');
        }

        return () => stylesCalls.push('released');
      },
    });

    assert.equal(f.wrapper.find('[data-module-child]').exists(), false,
      'Компонент не должен монтироваться до завершения CSS');
    assert.equal(stylesCalls.length, 1);
    assert.deepEqual(stylesCalls[0][0], descriptor.css);
    pending.resolve();
    await f.settle();

    if (failed) {
      assert.equal(f.wrapper.find('[data-module-child]').exists(), false);

      for (const locale of ['ru', 'en']) {
        f.ui.setUiLocale(locale);
        await f.settle();
        assert.ok(f.wrapper.text().includes(f.ui.t('core.pluginModuleLoadFailed', {
          name: 'Модуль проверки',
        })));
      }
    } else {
      assert.equal(f.wrapper.find('[data-module-child]').exists(), true);
      f.root.unmount();
      assert.equal(stylesCalls.at(-1), 'released');
    }

    assert.equal(f.state.backgroundStarts, 1);
    assert.equal(f.state.backgroundCleanups, 0);
  });
}

test('PM-PUBLIC-PROPS: четыре presentation и compact сохраняют props, DOM и один mount', async (t) => {
  const f = await panelFixture(t);
  const input = f.wrapper.get('input');

  await input.setValue('Черновик всех режимов');

  for (const presentation of ['page', 'dock', 'hidden', 'placeholder']) {
    for (const compact of [false, true]) {
      for (const active of [false, true]) {
        await f.updateProps({
          active,
          compact,
          presentation,
        });
        assert.ok(f.wrapper.text().includes(`${active}/${compact}/${presentation}`));
        assert.equal(f.wrapper.get('input').element === input.element, true);
        assert.equal(f.wrapper.get('input').element.value, 'Черновик всех режимов');
        assert.equal(f.state.mounts, 1);
        assert.equal(f.state.calls.length, 1);
      }
    }
  }
});

test('PERF: модульная панель ждёт CSS, отказ ресурсов завершает открытие как error', async (t) => {
  const pending = Promise.withResolvers();
  const f = await panelFixture(t, { styles: () => pending.promise });
  const surface = measured(t, f.wrapper, 'other', 'tool');

  await surface.paint();
  assert.equal(surface.log.snapshot().entries.some((row) => row.data.phase === 'ready'), false);
  pending.reject(new Error('fixture CSS failure'));
  await f.settle();
  await surface.paint();
  assert.equal(surface.log.snapshot().entries.at(-1).data.phase, 'error');
});
