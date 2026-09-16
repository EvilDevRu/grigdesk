// Диалог настроек плагина: группа «Размещение» по слотам манифеста и область по
// исполнителям из живого реестра. Тумблеры и галочки правят черновик записи, а кнопка
// «Сохранить» уносит значения и размещения одним запросом.
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { compilePluginsCatalog } from './helpers/plugins-catalog.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { placementsOf, registerPlacement, resetPlacements } from '../../web/src/plugins/registry.ts';

process.env.NODE_ENV = 'test';

const FORECAST_PLUGIN = {
  id: 'usage-forecast',
  system: true,
  name: 'Прогноз лимитов',
  version: '0.1.0',
  description: 'Хватит ли окна до сброса.',
  category: 'dev',
  nav: null,
  settings: [
    { key: 'providers', label: 'Исполнители', type: 'providers', default: [], hint: 'У остальных блока нет.' },
    { key: 'showIdle', label: 'Показывать стоящие полосы', type: 'checkbox', default: true },
  ],
};

function makeProvidersStore() {
  return {
    providers: [
      { id: 'claude', name: 'Claude', available: true, models: [] },
      { id: 'codex', name: 'GPT (Codex)', available: true, models: [] },
    ],
    usage: {},
    mcp: {},
    loaded: true,
    showAllModels: false,
    visibleModels: () => [],
    modelOf: () => ({ id: '', model: null, provider: null }),
    async load() {},
    async loadUsage() {},
    async saveSetting() { return { ok: true }; },
    async loadMcp() { return { state: 'ok', servers: [] }; },
    async runUsageAction() { return { ok: true }; },
  };
}

/**
 * Настоящий Pinia store с подменой только HTTP: тест видит момент, когда ответ
 * сохранения становится рабочими значениями и влияет на живой слот.
 */
async function makePluginsStore({ settings = FORECAST_PLUGIN.settings, values } = {}) {
  const { createPinia, setActivePinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs');
  const saved = [];
  const control = { error: '', beforeSave: async () => {} };
  const record = {
    ...FORECAST_PLUGIN,
    settings,
    enabled: true,
    values: values ?? { providers: ['codex'], showIdle: true },
    placements: [{
      slot: 'provider.popover.after-bars',
      label: 'Всплывашка исполнителя в топбаре, под полосами лимитов',
      enabled: true,
    }],
  };

  globalThis.__pluginPlacementsApi = {
    async put(_url, payload) {
      const body = structuredClone(payload);

      saved.push({ id: record.id, ...body });
      await control.beforeSave();

      if (control.error) {
        throw new Error(control.error);
      }

      return {
        values: body.values,
        placements: record.placements.map((placement) => ({
          ...placement,
          enabled: body.placements[placement.slot],
        })),
      };
    },
  };

  const { usePluginsStore } = await compileModule(webFile('src/stores/plugins.js'), {
    stubs: { '../shared/apiClient.ts': 'export const api = globalThis.__pluginPlacementsApi;' },
  });

  setActivePinia(createPinia());
  const store = usePluginsStore();

  store.loaded = true;
  store.list = [record];

  return {
    saved,
    control,
    plugin: store.byId(record.id),
    store,
  };
}

/**
 * Каталог и слот читают один store. Компонент размещения намеренно прост: проверяется
 * применение настроек хостом, без запросов и расчётов самого прогноза.
 */
async function mountPlacements(t, options = {}) {
  const prefix = '__pluginPlacements';
  const browser = await installUiBrowser(t, 'http://cockpit.test/#/settings');
  const prov = makeProvidersStore();
  const fixture = await makePluginsStore(options);
  const { defineComponent, h } = await import('../../web/node_modules/vue/index.mjs');

  globalThis[`${prefix}Stores`] = {
    usePluginsStore: () => fixture.store,
    useProvidersStore: () => prov,
  };
  globalThis.__pluginPlacementsRegistry = { placementsOf };

  const [{ mount, flushPromises }, PluginsCatalog, PluginSlot] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compilePluginsCatalog({ prefix }),
    compileVue(webFile('src/plugins/PluginSlot.vue'), {
      stubs: {
        '../stores/plugins.js': `
          export const usePluginsStore = () => globalThis.__pluginPlacementsStores.usePluginsStore();
        `,
        './registry.ts': `
          export const placementsOf = (...args) => globalThis.__pluginPlacementsRegistry.placementsOf(...args);
        `,
      },
    }),
  ]);
  const Component = defineComponent({ setup: () => () => h('span', { class: 'forecast-fixture' }, 'Прогноз') });

  resetPlacements();
  registerPlacement({ pluginId: 'usage-forecast', slot: 'provider.popover.after-bars', component: Component });
  const slot = mount(PluginSlot, {
    props: { name: 'provider.popover.after-bars', context: { providerId: 'codex' } },
  });
  const wrapper = mount(PluginsCatalog, {
    attachTo: browser.document.querySelector('#mount'),
    global: { stubs: { teleport: true } },
  });

  t.after(() => {
    wrapper.unmount();
    slot.unmount();
    resetPlacements();
    delete globalThis[`${prefix}Stores`];
    delete globalThis.__pluginPlacementsApi;
    delete globalThis.__pluginPlacementsRegistry;
  });
  await flushPromises();

  async function open() {
    await wrapper.get('[data-plugin-id="usage-forecast"] .plugin-tile-open').trigger('click');
    await flushPromises();
  }

  async function close() {
    const button = wrapper.findAll('.pd-actions button').find((item) => item.text() === 'Закрыть');

    await button.trigger('click');
    await flushPromises();
  }

  return { ...fixture, wrapper, slot, open, close, flushPromises };
}

test('диалог показывает размещения и область, а сохраняет их одним запросом', async (t) => {
  const { wrapper, slot, plugin, saved, open, flushPromises } = await mountPlacements(t);

  await open();
  const dialog = wrapper.find('.ui-dialog');

  assert.ok(dialog.exists(), 'модалка параметров не открылась');

  // Размещение — по слоту манифеста, с подписью места и его именем.
  const placements = dialog.find('[data-role="plugin-placements"]');

  assert.ok(placements.exists(), 'группы «Размещение» нет');
  assert.match(placements.text(), /Всплывашка исполнителя в топбаре/);
  assert.match(placements.text(), /provider\.popover\.after-bars/);
  assert.match(placements.text(), /1 из 1 включено/);

  const placementBox = placements.get('input[type="checkbox"]');

  assert.equal(placementBox.element.checked, true);
  await placementBox.setValue(false);
  assert.equal(plugin.placements[0].enabled, true);
  assert.equal(slot.find('.forecast-fixture').exists(), true);
  assert.match(placements.text(), /0 из 1 включено/);

  // Область — галочка на каждого исполнителя из реестра; отмечен только Codex.
  const scope = dialog.find('[data-role="plugin-providers"]');

  assert.ok(scope.exists(), 'области по исполнителям нет');
  const boxes = scope.findAll('input[type="checkbox"]');

  assert.deepEqual(boxes.map((box) => box.element.checked), [false, true]);
  assert.match(scope.text(), /У остальных блока нет/);
  assert.doesNotMatch(scope.text(), /значит все/);

  await boxes[1].setValue(false);
  assert.deepEqual(plugin.values.providers, ['codex']);
  assert.match(scope.text(), /Ни один не отмечен — значит все/);

  await boxes[0].setValue(true);
  assert.deepEqual(plugin.values.providers, ['codex']);

  await dialog.get('.plugin-save').trigger('click');
  await flushPromises();

  assert.deepEqual(saved, [{
    id: 'usage-forecast',
    values: { providers: ['claude'], showIdle: true },
    placements: { 'provider.popover.after-bars': false },
  }]);
  assert.deepEqual(plugin.values.providers, ['claude']);
  assert.equal(plugin.placements[0].enabled, false);
  assert.equal(slot.find('.forecast-fixture').exists(), false);
});

test('закрытие формы отбрасывает черновик параметров и размещений без влияния на слот', async (t) => {
  const { wrapper, slot, plugin, saved, open, close } = await mountPlacements(t);

  await open();
  await wrapper.get('[data-role="plugin-placements"] input').setValue(false);
  await wrapper.get('[data-role="plugin-providers"] input').setValue(true);
  await close();

  assert.equal(saved.length, 0);
  assert.equal(slot.find('.forecast-fixture').exists(), true);
  assert.deepEqual(plugin.values.providers, ['codex']);
  await open();
  assert.equal(wrapper.get('[data-role="plugin-placements"] input').element.checked, true);
  assert.deepEqual(
    wrapper.findAll('[data-role="plugin-providers"] input').map((input) => input.element.checked),
    [false, true],
  );
});

test('ошибка сохранения оставляет черновик для повтора и не меняет рабочее размещение', async (t) => {
  const { wrapper, slot, plugin, control, open, flushPromises } = await mountPlacements(t);

  control.error = 'Сеть недоступна';
  await open();
  await wrapper.get('[data-role="plugin-placements"] input').setValue(false);
  await wrapper.get('.plugin-save').trigger('click');
  await flushPromises();

  assert.match(wrapper.get('.pd-error').text(), /Сеть недоступна/);
  assert.equal(wrapper.get('[data-role="plugin-placements"] input').element.checked, false);
  assert.equal(plugin.placements[0].enabled, true);
  assert.equal(slot.find('.forecast-fixture').exists(), true);

  control.error = '';
  await wrapper.get('.plugin-save').trigger('click');
  await flushPromises();

  assert.equal(wrapper.find('.pd-error').exists(), false);
  assert.equal(slot.find('.forecast-fixture').exists(), false);
});

test('плагин с одними размещениями попадает в фильтр и сохраняет выбранное место', async (t) => {
  const { wrapper, slot, saved, open, flushPromises } = await mountPlacements(t, { settings: [], values: {} });
  const filter = wrapper.findAll('button').find((button) => button.text().startsWith('С параметрами'));

  assert.match(filter.text(), /С параметрами 1/);
  await filter.trigger('click');
  assert.equal(wrapper.find('[data-plugin-id="usage-forecast"]').exists(), true);
  assert.match(wrapper.get('.plugin-tile-meta').text(), /1 параметр/);

  await open();
  await wrapper.get('[data-role="plugin-placements"] input').setValue(false);
  await wrapper.get('.plugin-save').trigger('click');
  await flushPromises();

  assert.deepEqual(saved, [{
    id: 'usage-forecast',
    values: {},
    placements: { 'provider.popover.after-bars': false },
  }]);
  assert.equal(slot.find('.forecast-fixture').exists(), false);
});

test('запоздалое сохранение не подменяет черновик заново открытой формы', async (t) => {
  const { wrapper, slot, control, open, close, flushPromises } = await mountPlacements(t);
  let complete;

  control.beforeSave = () => new Promise((resolve) => {
    complete = resolve;
  });
  await open();
  await wrapper.get('[data-role="plugin-placements"] input').setValue(false);
  await wrapper.get('.plugin-save').trigger('click');
  await flushPromises();
  await close();
  await open();

  assert.equal(wrapper.get('[data-role="plugin-placements"] input').element.checked, true);
  complete();
  await flushPromises();

  assert.equal(slot.find('.forecast-fixture').exists(), false, 'отправленное сохранение принято сервером');
  assert.equal(wrapper.get('[data-role="plugin-placements"] input').element.checked, true);
  assert.equal(wrapper.get('.plugin-save').classes().includes('saved'), false);
});
