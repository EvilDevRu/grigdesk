process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import test from 'node:test';
import { compileVue, webFile, singletonUrl } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { modelDto, versionDto } from './helpers/studio3d-fixtures.js';

test('WL-01/02 библиотека и дерево родителей', async (t) => {
  await installUiBrowser(t);

  const { reactive } = await import(singletonUrl('vue'));
  const { mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.cjs.js');
  const calls = [];
  const store = reactive({
    query: '',
    filters: {},
    models: [modelDto({ name: 'Пётр', spent: 85 })],
    total: 2,
    broken: [],
    busy: 0,
    state: { providers: [] },
    search: (value) => calls.push(['search', value]),
    loadModels: (append) => calls.push(['models', append])
  });

  globalThis.__studioLibrary = store;

  const Library = await compileVue(webFile('src/views/studio3d/LibraryPanel.vue'), { stubs: {
    '../../stores/studio3d.ts': 'export const useStudio3dStore=()=>globalThis.__studioLibrary;',
    '../../shared/projectsApi.ts': 'export const projectsApi={list:async()=>[]};',
  } });
  const panel = mount(Library);

  t.after(() => panel.unmount());
  assert.match(panel.text(), /Пётр/);
  assert.match(panel.text(), /потрачено 85/);
  await panel.get('input[type="search"]').setValue('герой');
  assert.deepEqual(calls[0], ['search', 'герой']);
  await panel.get('[data-context="studio-filter-origin"]').setValue('agent');
  assert.equal(store.filters.origin, 'agent');
  await panel.findAll('button').find((button) => button.text() === 'Показать ещё').trigger('click');
  assert.equal(calls.some((call) => call[0] === 'models' && call[1] === true), true);
  await panel.get('[data-context="studio-model-card"]').trigger('click');
  assert.deepEqual(panel.emitted('open')[0], ['fixture-model']);
  store.models = [];
  await panel.vm.$nextTick();
  assert.match(panel.text(), /Модели не найдены/);

  store.filters = {};
  await panel.vm.$nextTick();
  assert.match(panel.text(), /Здесь будут ваши модели/);
  await panel.findAll('button').find((button) => button.text() === 'Создать модель').trigger('click');
  assert.equal(panel.emitted('create').length, 1);

  const Tree = await compileVue(webFile('src/views/studio3d/VersionTree.vue'));
  const parent = versionDto({
    id: 'parent',
    status: 'ready',
    label: 'Родитель'
  });
  const child = versionDto({
    id: 'child',
    parent: 'parent',
    seq: 2,
    label: 'Потомок'
  });
  const tree = mount(Tree, { props: {
    versions: [child, parent],
    selected: 'parent',
    main: 'parent'
  } });

  t.after(() => tree.unmount());

  const rows = tree.findAll('[data-context="studio-version-row"]');

  assert.match(rows[0].text(), /★.*Родитель/);
  assert.equal(rows[0].attributes('aria-pressed'), 'true');
  assert.equal(rows[1].attributes('aria-pressed'), 'false');
  assert.match(rows[1].text(), /Потомок/);
  assert.match(rows[1].attributes('style'), /18px/);
  assert.equal(rows[1].find('[role="progressbar"]').attributes('aria-valuenow'), '30');
  await rows[1].trigger('click');
  assert.deepEqual(tree.emitted('select')[0], ['child']);
  await tree.get('[aria-label="Свернуть Родитель"]').trigger('click');
  assert.equal(tree.findAll('[data-context="studio-version-row"]').length, 1);
});
