import assert from 'node:assert/strict';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

function singleRouteBundle(draft) {
  const route = structuredClone(draft.routes.quick);
  route.route.nodes.find((node) => node.id === 'check').on.failed = {
    escalate: { routes: ['audit'] },
  };
  return {
    format: 'cockpit-route-authoring', schema: 1, sourceProfile: 'sample',
    content: {
      routes: { quick: route },
      bootstrap: { schema: 2, kind: 'bootstrap', profile: 'sample', id: 'scout',
        entry: null, sequence: { bootstrap: [] }, nodes: [], escalation: [] },
      bootstrapPrompts: {}, presentation: {}, provenance: {},
    },
    dependencies: ['audit'],
  };
}

test('RE-G4-03/05: файл показывает источник, зависимости и выбор при совпадении ID',
  async (t) => {
    const browser = await installUiBrowser(t, 'http://cockpit.test/#/routes');
    const Component = await compileVue(webFile('src/views/routes/RouteTransferDialog.vue'));
    const { mount, flushPromises } = await import(
      '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
    );
    const draft = makeDraft();
    const wrapper = mount(Component, { attachTo: browser.document.querySelector('#mount'),
      props: { document: draft, profiles: ['sample', 'target'], dirty: false } });
    t.after(() => wrapper.unmount());
    const bundle = singleRouteBundle(draft);
    wrapper.findComponent({ name: 'UiFilePicker' }).vm.$emit('change', [{
      size: 1024, text: async () => JSON.stringify(bundle),
    }]);
    await flushPromises();
    assert.match(wrapper.text(), /Исходный проект: sample/);
    assert.match(wrapper.find('[data-test="transfer-dependencies"]').text(), /audit/);
    await wrapper.find('[data-test="transfer-import-mode"]').setValue('add');
    assert.match(wrapper.text(), /Маршрут quick уже есть/);
    await wrapper.find('[data-test="transfer-collision"]').setValue('rename');
    assert.equal(wrapper.find('[data-test="transfer-new-id"]').exists(), true);
    assert.equal(wrapper.find('[data-test="transfer-import"]').attributes('disabled') !== undefined,
      true);
    await wrapper.find('[data-test="transfer-new-id"]').setValue('imported');
    assert.equal(wrapper.find('[data-test="transfer-import"]').attributes('disabled'), undefined);
  });

test('RE-G4-02: смена целевого проекта оставляет только создание нового черновика',
  async (t) => {
    const browser = await installUiBrowser(t, 'http://cockpit.test/#/routes');
    const Component = await compileVue(webFile('src/views/routes/RouteTransferDialog.vue'));
    const { mount, flushPromises } = await import(
      '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
    );
    const draft = makeDraft();
    const wrapper = mount(Component, { attachTo: browser.document.querySelector('#mount'),
      props: { document: draft, profiles: ['sample', 'target'], dirty: false } });
    t.after(() => wrapper.unmount());
    wrapper.findComponent({ name: 'UiFilePicker' }).vm.$emit('change', [{
      size: 1024, text: async () => JSON.stringify(singleRouteBundle(draft)),
    }]);
    await flushPromises();
    await wrapper.find('[data-test="transfer-import-mode"]').setValue('add');
    await wrapper.find('[data-test="transfer-target-profile"]').setValue('target');
    assert.equal(wrapper.find('[data-test="transfer-import-mode"]').element.value, 'new');
    assert.equal(wrapper.text().includes('Добавить в открытый черновик'), false);
  });

test('RE-G4-01/05: web actions передают точную ревизию и перечитывают результат PATCH',
  async (t) => {
    await installUiBrowser(t, 'http://cockpit.test/#/routes');
    const { createPinia, setActivePinia } = await import(
      '../../web/node_modules/pinia/dist/pinia.mjs'
    );
    const actions = await compileModule(webFile('src/actions/routes/index.ts'));
    setActivePinia(createPinia());
    const store = actions.useRoutesStore();
    const draft = makeDraft();
    const bundle = singleRouteBundle(draft);
    const changed = structuredClone(draft);
    changed.revision = 2;
    changed.routes.quick.prompts['prompts/build.base.md'] = 'Импортировано.\n';
    store.opened = { profile: 'sample', draftId: draft.id, readOnly: false };
    store.serverSnapshot = structuredClone(draft);
    store.localDocument = structuredClone(draft);
    const calls = [];
    actions.configureRoutesRuntime(store, { api: {
      exportDraftTransfer: async (...args) => { calls.push(['export', ...args]); return bundle; },
      addRouteTransfer: async (...args) => { calls.push(['add', ...args]);
        return { draft: changed, cancelled: false,
          unresolvedDependencies: ['audit'], issues: [] }; },
      draft: async () => changed,
    } });
    const exported = await actions.exportRouteTransfer('quick');
    assert.equal(exported, bundle);
    assert.deepEqual(calls[0], ['export', 'sample', draft.id, 'quick']);
    await actions.addRouteTransfer(bundle, 'replace');
    assert.equal(calls[1][0], 'add');
    assert.equal(calls[1][3].expectedRevision, 1);
    assert.equal(calls[1][3].collision, 'replace');
    assert.equal(store.serverSnapshot.revision, 2);
    assert.equal(store.localDocument.routes.quick.prompts['prompts/build.base.md'],
      'Импортировано.\n');
  });
