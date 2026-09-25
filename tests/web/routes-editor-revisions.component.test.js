import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { makeDraft } from '../fixtures/routes-editor.mjs';
import { compileModule } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

const UiButtonStub = `
  import { defineComponent, h } from 'vue';
  export const UiButton = defineComponent({
    props: { disabled: Boolean },
    emits: ['click'],
    setup(props, { emit, slots, attrs }) {
      return () => h('button', { ...attrs, disabled: props.disabled,
        onClick: () => emit('click') }, slots.default?.());
    },
  });
  export const UiTextarea = defineComponent({
    props: ['modelValue'], emits: ['update:modelValue'],
    setup(props, { emit, attrs }) {
      return () => h('textarea', { ...attrs, value: props.modelValue,
        onInput: (event) => emit('update:modelValue', event.target.value) });
    },
  });
  export const UiSelect = defineComponent({
    props: ['modelValue'], emits: ['update:modelValue'],
    setup(props, { emit, attrs, slots }) {
      return () => h('select', { ...attrs, value: props.modelValue,
        onChange: (event) => emit('update:modelValue', event.target.value) }, slots.default?.());
    },
  });
`;

test('RE-G1-03: история открывает exact hash и создаёт черновик из выбранной ревизии',
  async (t) => {
    const browser = await installUiBrowser(t, 'http://cockpit.test/#/routes');
    const Component = await compileVue(webFile('src/views/routes/RouteRevisionHistory.vue'), {
      stubs: { '../../ui': UiButtonStub },
    });
    const { mount } = await import(
      '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
    );
    const oldHash = 'a'.repeat(64);
    const currentHash = 'b'.repeat(64);
    const revisions = [
      { catalogHash: currentHash, createdAt: '2026-01-02T00:00:00.000Z',
        isCurrent: true, integrity: 'ok', routes: { quick: 'c'.repeat(64) } },
      { catalogHash: oldHash, createdAt: '2026-01-01T00:00:00.000Z',
        isCurrent: false, integrity: 'ok', routes: { quick: 'd'.repeat(64) } },
    ];
    const viewed = [];
    const created = [];
    const wrapper = mount(Component, { attachTo: browser.document.querySelector('#mount'),
      props: { revisions, busy: false,
        onView: (hash) => viewed.push(hash),
        onCreate: (hash) => created.push(hash) } });
    t.after(() => wrapper.unmount());
    await wrapper.find(`[data-test="view-${oldHash}"]`).trigger('click');
    await wrapper.find(`[data-test="create-${oldHash}"]`).trigger('click');
    assert.deepEqual(viewed, [oldHash]);
    assert.deepEqual(created, [oldHash]);
  });

test('RE-G1-01: сравнение выбирает две произвольные целые ревизии', async (t) => {
  const browser = await installUiBrowser(t, 'http://cockpit.test/#/routes');
  const Component = await compileVue(webFile('src/views/routes/RouteRevisionHistory.vue'), {
    stubs: { '../../ui': UiButtonStub },
  });
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const hashes = ['a', 'b', 'c'].map((letter) => letter.repeat(64));
  const revisions = hashes.map((catalogHash, index) => ({ catalogHash,
    createdAt: `2026-01-0${index + 1}T00:00:00.000Z`, isCurrent: index === 0,
    integrity: 'ok', routes: {} }));
  const comparisons = [];
  const wrapper = mount(Component, { attachTo: browser.document.querySelector('#mount'),
    props: { revisions, busy: false, onCompare: (...pair) => comparisons.push(pair) } });
  t.after(() => wrapper.unmount());
  await wrapper.find('[data-test="revision-from"]').setValue(hashes[2]);
  await wrapper.find('[data-test="revision-to"]').setValue(hashes[1]);
  await wrapper.find('[data-test="compare-revisions"]').trigger('click');
  assert.deepEqual(comparisons, [[hashes[2], hashes[1]]]);
});

test('RE-G1-04: повреждённая ревизия видна с причиной, откат недоступен', async (t) => {
  const browser = await installUiBrowser(t, 'http://cockpit.test/#/routes');
  const Component = await compileVue(webFile('src/views/routes/RouteRevisionHistory.vue'), {
    stubs: { '../../ui': UiButtonStub },
  });
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const hash = 'c'.repeat(64);
  const wrapper = mount(Component, { attachTo: browser.document.querySelector('#mount'),
    props: { busy: false, revisions: [{ catalogHash: hash,
      createdAt: '2026-01-01T00:00:00.000Z', isCurrent: false,
      integrity: 'ROUTES_V2_CORRUPTED', routes: null }] } });
  t.after(() => wrapper.unmount());
  assert.match(wrapper.text(), /Повреждена: ROUTES_V2_CORRUPTED/);
  assert.doesNotMatch(wrapper.text(), /пустой каталог/i);
  assert.equal(wrapper.find(`[data-test="rollback-${hash}"]`).attributes('disabled'), '');
  assert.equal(wrapper.find(`[data-test="create-${hash}"]`).attributes('disabled'), '');
});

test('RE-G1-05: комментарий уходит с публикацией того же проверенного снимка', async () => {
  const { createPinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );
  const actions = await compileModule(webFile('src/actions/routes/index.ts'));
  setActivePinia(createPinia());
  const store = actions.useRoutesStore();
  const draft = makeDraft();
  store.opened = { profile: 'sample', draftId: draft.id, readOnly: false };
  store.serverSnapshot = structuredClone(draft);
  store.localDocument = structuredClone(draft);
  store.validatedRevision = draft.revision;
  store.validatedGeneration = 0;
  store.validatedCapabilitiesHash = 'b'.repeat(64);
  store.compareReport = { draftId: draft.id, draftRevision: draft.revision,
    currentCatalogHash: null, sourceMode: 'editor', sourceRevision: 1,
    capabilitiesHash: 'b'.repeat(64), changes: [] };
  store.compareGeneration = 0;
  const calls = [];
  actions.configureRoutesRuntime(store, { api: {
    publishDraft: async (...args) => {
      calls.push(args);
      return { operationId: '22222222-2222-4222-8222-222222222222', state: 'committed' };
    },
  }, operationId: () => '22222222-2222-4222-8222-222222222222' });
  await actions.publishComparedDraft('Проверена новая инструкция.');
  assert.equal(calls[0][2].comment, 'Проверена новая инструкция.');
});

test('RE-G1-05: диалог передаёт введённый комментарий при подтверждении', async (t) => {
  const browser = await installUiBrowser(t, 'http://cockpit.test/#/routes');
  const Component = await compileVue(webFile('src/views/routes/RoutePublishDialog.vue'), {
    stubs: { '../../ui': UiButtonStub },
  });
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const draft = makeDraft();
  const report = { draftId: draft.id, draftRevision: 1,
    currentCatalogHash: null, sourceMode: 'editor', sourceRevision: 1,
    capabilitiesHash: 'b'.repeat(64), changes: [] };
  const comments = [];
  const wrapper = mount(Component, { attachTo: browser.document.querySelector('#mount'),
    props: { report, canPublish: true, onConfirm: (comment) => comments.push(comment) } });
  t.after(() => wrapper.unmount());
  await wrapper.find('[data-test="publication-comment"]').setValue('Проверена инструкция.');
  await wrapper.find('[data-test="confirm-publish"]').trigger('click');
  assert.deepEqual(comments, ['Проверена инструкция.']);
});
