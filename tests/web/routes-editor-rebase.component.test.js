import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { compileModule } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { makeDraft } from '../fixtures/routes-editor.mjs';

process.env.NODE_ENV = 'test';

const uiStub = `
  import { defineComponent, h } from 'vue';
  export const UiButton = defineComponent({ props: { disabled: Boolean }, emits: ['click'],
    setup(props, { emit, attrs, slots }) {
      return () => h('button', { ...attrs, disabled: props.disabled,
        onClick: () => emit('click') }, slots.default?.());
    },
  });
  export const UiSelect = defineComponent({ props: ['modelValue'], emits: ['update:modelValue'],
    setup(props, { emit, attrs, slots }) {
      return () => h('select', { ...attrs, value: props.modelValue,
        onChange: (event) => emit('update:modelValue', event.target.value) }, slots.default?.());
    },
  });
`;

test('RE-G2-02/03: конфликтующие route и bootstrap требуют двух явных решений', async (t) => {
  const browser = await installUiBrowser(t, 'http://cockpit.test/#/routes');
  const Component = await compileVue(webFile('src/views/routes/RouteRebaseDialog.vue'), {
    stubs: { '../../ui': uiStub },
  });
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const preview = { draftId: '11111111-1111-4111-8111-111111111111', draftRevision: 2,
    baseCatalogHash: 'a'.repeat(64), currentCatalogHash: 'b'.repeat(64),
    conflicts: [
      { scope: 'route', routeId: 'quick', base: { title: 'База' },
        mine: { title: 'Мой quick' }, current: { title: 'Серверный quick' } },
      { scope: 'bootstrap', routeId: null, base: { prompt: 'База' },
        mine: { prompt: 'Моя разведка' }, current: { prompt: 'Чужая разведка' } },
    ] };
  const confirms = [];
  const wrapper = mount(Component, { attachTo: browser.document.querySelector('#mount'),
    props: { preview, busy: false, onConfirm: (value) => confirms.push(value) } });
  t.after(() => wrapper.unmount());
  assert.match(wrapper.text(), /Мой quick/);
  assert.match(wrapper.text(), /Серверный quick/);
  assert.equal(wrapper.find('[data-test="rebase-confirm"]').attributes('disabled'), '');
  await wrapper.find('[data-test="rebase-choice-route-quick"]').setValue('mine');
  await wrapper.find('[data-test="rebase-choice-bootstrap"]').setValue('current');
  await wrapper.find('[data-test="rebase-confirm"]').trigger('click');
  assert.deepEqual(confirms, [[
    { scope: 'route', routeId: 'quick', choice: 'mine' },
    { scope: 'bootstrap', routeId: null, choice: 'current' },
  ]]);
});

test('RE-G2-05: успешный rebase сбрасывает старую проверку и сравнение', async () => {
  const { createPinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );
  const actions = await compileModule(webFile('src/actions/routes/index.ts'));
  assert.equal(typeof actions.previewDraftRebase, 'function');
  assert.equal(typeof actions.applyDraftRebase, 'function');
  setActivePinia(createPinia());
  const store = actions.useRoutesStore();
  const draft = makeDraft();
  const baseHash = 'a'.repeat(64);
  const currentHash = 'b'.repeat(64);
  draft.baseCatalogHash = baseHash;
  store.opened = { profile: 'sample', draftId: draft.id, readOnly: false };
  store.serverSnapshot = structuredClone(draft);
  store.localDocument = structuredClone(draft);
  store.validatedRevision = 1;
  store.validatedGeneration = 0;
  store.validatedCapabilitiesHash = 'c'.repeat(64);
  store.compareReport = { draftId: draft.id, draftRevision: 1,
    currentCatalogHash: baseHash, sourceMode: 'editor', sourceRevision: 1,
    capabilitiesHash: 'c'.repeat(64), changes: [] };
  store.compareGeneration = 0;
  const preview = { draftId: draft.id, draftRevision: 1,
    baseCatalogHash: baseHash, currentCatalogHash: currentHash, conflicts: [] };
  const calls = [];
  actions.configureRoutesRuntime(store, { api: {
    previewRebase: async () => preview,
    rebaseDraft: async (...args) => {
      calls.push(args);
      return { ...structuredClone(draft), revision: 2, baseCatalogHash: currentHash };
    },
  } });
  await actions.previewDraftRebase();
  assert.deepEqual(store.rebasePreview, preview);
  await actions.applyDraftRebase([]);
  assert.deepEqual(calls, [['sample', draft.id, {
    expectedDraftRevision: 1, expectedCatalogHash: currentHash, resolutions: [],
  }]]);
  assert.equal(store.serverSnapshot.revision, 2);
  assert.equal(store.serverSnapshot.baseCatalogHash, currentHash);
  assert.equal(store.validatedRevision, null);
  assert.equal(store.compareReport, null);
  assert.equal(store.rebasePreview, null);
});

test('RE-G2-04: 409 после preview сохраняет локальный документ и требует новый preview',
  async () => {
    const { createPinia, setActivePinia } = await import(
      '../../web/node_modules/pinia/dist/pinia.mjs'
    );
    const actions = await compileModule(webFile('src/actions/routes/index.ts'));
    setActivePinia(createPinia());
    const store = actions.useRoutesStore();
    const draft = makeDraft();
    draft.baseCatalogHash = 'a'.repeat(64);
    store.opened = { profile: 'sample', draftId: draft.id, readOnly: false };
    store.serverSnapshot = structuredClone(draft);
    store.localDocument = structuredClone(draft);
    const preview = { draftId: draft.id, draftRevision: 1,
      baseCatalogHash: draft.baseCatalogHash,
      currentCatalogHash: 'b'.repeat(64), conflicts: [] };
    let calls = 0;
    actions.configureRoutesRuntime(store, { api: {
      previewRebase: async () => preview,
      rebaseDraft: async () => {
        calls += 1;
        throw Object.assign(new Error('Каталог уже другой'), { status: 409 });
      },
    } });
    await actions.previewDraftRebase();
    await actions.applyDraftRebase([]);
    assert.equal(calls, 1);
    assert.equal(store.localDocument.routes.quick.route.title, 'Быстрый маршрут');
    assert.equal(store.serverSnapshot.revision, 1);
    assert.equal(store.rebasePreview, null);
    assert.match(store.rebaseError, /Каталог уже другой/);
  });
