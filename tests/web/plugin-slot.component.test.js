// Слоты плагинов: реестр размещений упорядочивает записи, `<PluginSlot>` рисует только
// включённые плагины с включённым размещением, а упавший компонент плагина показывает
// сообщение на своём месте и не роняет соседей.
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import {
  placementsOf,
  registerPlacement,
  resetPlacements,
} from '../../web/src/plugins/registry.ts';

const PLUGINS_STUB = `
  export const usePluginsStore = () => globalThis.__pluginSlotStore;
`;
// Компилятор тестов бандлит локальные файлы: у собранного слота была бы своя копия
// реестра. Прокидываем реестр теста через глобал — тем же путём, что и сторы.
const REGISTRY_STUB = `
  export const placementsOf = (...args) => globalThis.__pluginSlotRegistry.placementsOf(...args);
`;

function pluginsStore({ loaded = true, enabled = {}, placements = {} } = {}) {
  return {
    loaded,
    enabled: (id) => enabled[id] !== false,
    placementEnabled: (id, slot) => placements[`${id}:${slot}`] !== false,
  };
}

test('реестр: порядок по order и id, повтор заменяет запись, отмена снимает её', () => {
  resetPlacements();
  const a = () => null;
  const b = () => null;

  registerPlacement({ pluginId: 'zeta', slot: 'provider.popover.after-bars', component: a, order: 10 });
  registerPlacement({ pluginId: 'alpha', slot: 'provider.popover.after-bars', component: b, order: 10 });
  const off = registerPlacement({ pluginId: 'late', slot: 'provider.popover.after-bars', component: a });

  assert.deepEqual(
    placementsOf('provider.popover.after-bars').map((p) => p.pluginId),
    ['alpha', 'zeta', 'late'],
  );

  registerPlacement({ pluginId: 'zeta', slot: 'provider.popover.after-bars', component: b, order: 1 });
  assert.deepEqual(
    placementsOf('provider.popover.after-bars').map((p) => p.pluginId),
    ['zeta', 'alpha', 'late'],
  );

  off();
  assert.deepEqual(placementsOf('provider.popover.after-bars').map((p) => p.pluginId), ['zeta', 'alpha']);
  resetPlacements();
  assert.deepEqual(placementsOf('provider.popover.after-bars'), []);
});

test('слот рисует включённые размещения с контекстом, а упавший плагин — сообщением', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount, flushPromises, defineComponent, h }, PluginSlot] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs')
      .then(async (utils) => ({ ...utils, ...(await import('../../web/node_modules/vue/index.mjs')) })),
    compileVue(webFile('src/plugins/PluginSlot.vue'), {
      stubs: {
        '../stores/plugins.js': PLUGINS_STUB,
        './registry.ts': REGISTRY_STUB,
      },
    }),
  ]);

  const Fine = defineComponent({
    props: { providerId: { type: String, required: true } },
    setup: (props) => () => h('i', { class: 'fine' }, `fine:${props.providerId}`),
  });
  const Broken = defineComponent({
    setup: () => () => {
      throw new Error('нет данных для рисования');
    },
  });

  globalThis.__pluginSlotRegistry = { placementsOf };
  resetPlacements();
  registerPlacement({ pluginId: 'fine', slot: 'provider.popover.after-bars', component: Fine, order: 2 });
  registerPlacement({ pluginId: 'broken', slot: 'provider.popover.after-bars', component: Broken, order: 1 });
  registerPlacement({ pluginId: 'off', slot: 'provider.popover.after-bars', component: Fine, order: 3 });
  registerPlacement({ pluginId: 'hidden', slot: 'provider.popover.after-bars', component: Fine, order: 4 });
  t.after(() => resetPlacements());

  globalThis.__pluginSlotStore = pluginsStore({
    enabled: { off: false },
    placements: { 'hidden:provider.popover.after-bars': false },
  });

  const wrapper = mount(PluginSlot, {
    attachTo: browser.document.querySelector('#mount'),
    props: { name: 'provider.popover.after-bars', context: { providerId: 'codex' } },
  });

  t.after(() => wrapper.unmount());
  // Сообщение об ошибке появляется перерисовкой после захвата — ждём тик.
  await flushPromises();

  assert.equal(wrapper.findAll('.fine').length, 1);
  assert.equal(wrapper.get('.fine').text(), 'fine:codex');
  assert.match(wrapper.text(), /Плагин «broken» не отрисовался/);
  assert.equal(
    wrapper.get('[data-context="plugin-slot-failure"]').attributes('data-ui-tooltip'),
    'нет данных для рисования',
  );
  assert.doesNotMatch(wrapper.text(), /off|hidden/);

  // Пока список плагинов не загружен — слот пуст, а не «мигает».
  globalThis.__pluginSlotStore = pluginsStore({ loaded: false });
  const empty = mount(PluginSlot, {
    props: { name: 'provider.popover.after-bars', context: { providerId: 'codex' } },
  });

  t.after(() => empty.unmount());
  assert.equal(empty.text(), '');
});
