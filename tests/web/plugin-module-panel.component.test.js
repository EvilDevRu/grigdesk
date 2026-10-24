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

  };
  const child = {
    props: ['context', 'active', 'compact', 'presentation'],
    setup(props) {
      const text = vue.ref('');

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
  });
  state.context ??= async (id) => ({

    pluginId: id,

    api: {},

    locale: ui.uiLocale,

    settings: vue.readonly(vue.computed(() => state.store.card.values)),

    t: () => ui.uiLocale.value === 'ru' ? 'Привет' : 'Hello',

  });
  globalThis.__modulePanelTest = state;

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

    descriptor,

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
        if (['unsupported', 'import', 'empty-default', 'css'].includes(variant)) {
          throw failure;
        }

        return { component: broken, releaseStyles: () => releases.push('css') };
      },
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
