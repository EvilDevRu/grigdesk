import assert from 'node:assert/strict';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

test('RE-E6-01: проблема адресует узел и путь, правка делает отчёт устаревшим', async (t) => {
  const browser = await installUiBrowser(t, 'http://cockpit.test/#/routes');
  const { createPinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );
  const Component = await compileVue(webFile('src/views/routes/RouteProblems.vue'), {
    stubs: { '../../ui': (`
      import { defineComponent, h } from 'vue';
      export const UiButton = defineComponent({ emits: ['click'], setup(_, { emit, slots, attrs }) {
        return () => h('button', { ...attrs, onClick: () => emit('click') }, slots.default?.());
      } });
    `) +
      "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";" },
  });
  const { mount } = await import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs');
  const issue = { code: 'prompt_required', severity: 'error', scope: 'route',
    routeId: 'quick', nodeId: 'build', path: '/routes/quick/route/nodes/0/prompt/blocks/0',
    message: 'Добавьте инструкцию' };
  const focused = [];
  const wrapper = mount(Component, {
    attachTo: browser.document.querySelector('#mount'),
    props: { issues: [issue], stale: false, onFocus: (value) => focused.push(value) },
  });
  t.after(() => wrapper.unmount());
  assert.match(wrapper.text(), /Добавьте инструкцию/);
  await wrapper.find('[data-test="focus-issue"]').trigger('click');
  assert.deepEqual(focused, [issue]);

  const section = await compileModule(webFile('src/actions/routes/index.ts'));
  setActivePinia(createPinia());
  const store = section.useRoutesStore();
  const draft = makeDraft();
  store.opened = { profile: 'sample', draftId: draft.id, readOnly: false };
  store.serverSnapshot = structuredClone(draft);
  store.localDocument = structuredClone(draft);
  store.validatedRevision = draft.revision;
  store.validatedGeneration = 0;
  store.validatedCapabilitiesHash = 'b'.repeat(64);
  assert.equal(store.canPublish, true);
  section.applyLocalChange((local) => { local.title = 'Правка после проверки'; });
  assert.equal(store.canPublish, false);
  section.cancelDraftSave();
});

test('RE-E6-02: клиент держит сравнение с точной ревизией, current и source', async () => {
  const { createPinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );
  const section = await compileModule(webFile('src/actions/routes/index.ts'));
  setActivePinia(createPinia());
  const store = section.useRoutesStore();
  const draft = makeDraft();
  const hash = 'a'.repeat(64);
  store.opened = { profile: 'sample', draftId: draft.id, readOnly: false };
  store.serverSnapshot = structuredClone(draft);
  store.localDocument = structuredClone(draft);
  const report = { draftId: draft.id, draftRevision: 1,
    currentCatalogHash: hash, sourceMode: 'editor', sourceRevision: 3,
    capabilitiesHash: 'b'.repeat(64), changes: [{ scope: 'route', routeId: 'quick',
      kind: 'changed', before: { prompts: { base: 'Старая инструкция' } },
      after: { prompts: { base: 'Новая инструкция' } } }] };
  section.configureRoutesRuntime(store, { api: { compareDraft: async () => report } });
  await section.compareDraft();
  assert.deepEqual(store.compareReport, report);
  assert.equal(store.compareGeneration, 0);
});

test('RE-E6-02: публикация отправляет показанные revision/hash/source и один operationId',
  async () => {
    const { createPinia, setActivePinia } = await import(
      '../../web/node_modules/pinia/dist/pinia.mjs'
    );
    const section = await compileModule(webFile('src/actions/routes/index.ts'));
    setActivePinia(createPinia());
    const store = section.useRoutesStore();
    const draft = makeDraft();
    const currentCatalogHash = 'a'.repeat(64);
    store.opened = { profile: 'sample', draftId: draft.id, readOnly: false };
    store.serverSnapshot = structuredClone(draft);
    store.localDocument = structuredClone(draft);
    store.validatedRevision = 1;
    store.validatedGeneration = 0;
    store.validatedCapabilitiesHash = 'b'.repeat(64);
    store.compareReport = { draftId: draft.id, draftRevision: 1,
      currentCatalogHash, sourceMode: 'editor', sourceRevision: 3,
      capabilitiesHash: 'b'.repeat(64), changes: [] };
    store.compareGeneration = 0;
    const calls = [];
    section.configureRoutesRuntime(store, {
      operationId: () => '22222222-2222-4222-8222-222222222222',
      api: { publishDraft: async (...args) => {
        calls.push(args);
        return { operationId: '22222222-2222-4222-8222-222222222222',
          requestHash: 'c'.repeat(64), draftId: draft.id, draftRevision: 1,
          fromCatalogHash: currentCatalogHash, toCatalogHash: 'd'.repeat(64),
          sourceRevision: 3, state: 'committed', currentChanged: true,
          createdAt: '2026-01-01T00:00:00.000Z' };
      } },
    });
    await section.publishComparedDraft();
    assert.deepEqual(calls, [['sample', draft.id, {
      expectedRevision: 1, expectedCatalogHash: currentCatalogHash,
      expectedSourceRevision: 3, operationId: '22222222-2222-4222-8222-222222222222',
    }]]);
  });

test('RE-E6-03: правка после compare запрещает подтверждение старого снимка', async () => {
  const { createPinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );
  const section = await compileModule(webFile('src/actions/routes/index.ts'));
  setActivePinia(createPinia());
  const store = section.useRoutesStore();
  const draft = makeDraft();
  store.opened = { profile: 'sample', draftId: draft.id, readOnly: false };
  store.serverSnapshot = structuredClone(draft);
  store.localDocument = structuredClone(draft);
  store.validatedRevision = 1;
  store.validatedGeneration = 0;
  store.validatedCapabilitiesHash = 'b'.repeat(64);
  store.compareReport = { draftId: draft.id, draftRevision: 1,
    currentCatalogHash: 'a'.repeat(64), sourceMode: 'editor', sourceRevision: 3,
    capabilitiesHash: 'b'.repeat(64), changes: [] };
  store.compareGeneration = 0;
  const calls = [];
  section.configureRoutesRuntime(store, { api: { publishDraft: async (...args) => {
    calls.push(args);
  } } });
  assert.equal(store.canConfirmPublish, true);
  section.applyLocalChange((local) => { local.title = 'Новее сравнения'; });
  assert.equal(store.canConfirmPublish, false);
  await section.publishComparedDraft();
  assert.equal(calls.length, 0);
  section.cancelDraftSave();
});

test('RE-E6-02: compare показывает человеку инструкции и политики до подтверждения',
  async (t) => {
    const browser = await installUiBrowser(t, 'http://cockpit.test/#/routes');
    const Component = await compileVue(webFile('src/views/routes/RouteCompare.vue'), {
      stubs: { '../../ui': (`
        import { defineComponent, h } from 'vue';
        export const UiButton = defineComponent({ emits: ['click'], setup(_, { emit, slots, attrs }) {
          return () => h('button', { ...attrs, onClick: () => emit('click') }, slots.default?.());
        } });
      `) +
        "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";" },
    });
    const { mount } = await import(
      '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
    );
    const before = makeDraft().routes.quick;
    const after = structuredClone(before);
    after.prompts['prompts/build.base.md'] = 'Новая инструкция.\n';
    after.route.nodes[0].policy.filesystem = 'workspace';
    const report = { draftId: makeDraft().id, draftRevision: 2,
      currentCatalogHash: 'a'.repeat(64), sourceMode: 'editor', sourceRevision: 3,
      capabilitiesHash: 'b'.repeat(64), changes: [{ scope: 'route', routeId: 'quick',
        kind: 'changed', before, after }] };
    let opened = false;
    const wrapper = mount(Component, { attachTo: browser.document.querySelector('#mount'),
      props: { report, canPublish: true, onPublish: () => { opened = true; } } });
    t.after(() => wrapper.unmount());
    assert.match(wrapper.text(), /Создай проверяемый результат/);
    assert.match(wrapper.text(), /Новая инструкция/);
    assert.match(wrapper.text(), /state-only/);
    assert.match(wrapper.text(), /workspace/);
    await wrapper.find('[data-test="open-publish"]').trigger('click');
    assert.equal(opened, true);
  });

test('RE-E6-04: переход источника требует согласия и свежего compare', async () => {
  const { createPinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );
  const section = await compileModule(webFile('src/actions/routes/index.ts'));
  setActivePinia(createPinia());
  const store = section.useRoutesStore();
  const draft = makeDraft();
  const hash = 'a'.repeat(64);
  store.opened = { profile: 'sample', draftId: draft.id, readOnly: false };
  store.serverSnapshot = structuredClone(draft);
  store.localDocument = structuredClone(draft);
  const capabilities = { schema: 1, commands: [], contextSections: [], filesystem: [],
    timeoutClasses: [], retryStrategies: [] };
  store.editorInfo = { profile: 'sample', source: { mode: 'profile-script', revision: 0 },
    currentCatalogHash: hash, capabilitiesHash: 'b'.repeat(64), capabilities, issues: [] };
  store.compareReport = { draftId: draft.id, draftRevision: 1,
    currentCatalogHash: hash, sourceMode: 'profile-script', sourceRevision: 0,
    capabilitiesHash: 'b'.repeat(64), changes: [] };
  const compareBeforeSwitch = JSON.parse(JSON.stringify(store.compareReport));
  store.compareGeneration = 0;
  const switched = { ...JSON.parse(JSON.stringify(store.editorInfo)),
    source: { mode: 'editor', revision: 1 } };
  const calls = [];
  section.configureRoutesRuntime(store, { api: {
    switchSource: async (...args) => { calls.push(['put', ...args]); return switched; },
    editor: async () => { calls.push(['editor']); return switched; },
    compareDraft: async () => {
      calls.push(['compare']);
      return { ...compareBeforeSwitch,
        sourceMode: 'editor', sourceRevision: 1 };
    },
  } });
  await section.enableEditorSource(async () => false);
  assert.equal(calls.length, 0);
  assert.equal(store.compareReport.sourceMode, 'profile-script');
  await section.enableEditorSource(async () => true);
  assert.deepEqual(calls, [
    ['put', 'sample', { mode: 'editor', expectedSourceRevision: 0,
      expectedCatalogHash: hash }], ['editor'], ['compare'],
  ]);
  assert.equal(store.compareReport.sourceRevision, 1);
  assert.equal(store.editorInfo.source.mode, 'editor');
});

test('RE-E6-05: timeout и двойной клик узнают один committed receipt по operationId',
  async () => {
    const { createPinia, setActivePinia } = await import(
      '../../web/node_modules/pinia/dist/pinia.mjs'
    );
    const section = await compileModule(webFile('src/actions/routes/index.ts'));
    setActivePinia(createPinia());
    const store = section.useRoutesStore();
    const draft = makeDraft();
    store.opened = { profile: 'sample', draftId: draft.id, readOnly: false };
    store.serverSnapshot = structuredClone(draft);
    store.localDocument = structuredClone(draft);
    store.validatedRevision = 1;
    store.validatedGeneration = 0;
    store.validatedCapabilitiesHash = 'b'.repeat(64);
    store.compareReport = { draftId: draft.id, draftRevision: 1,
      currentCatalogHash: null, sourceMode: 'editor', sourceRevision: 1,
      capabilitiesHash: 'b'.repeat(64), changes: [] };
    store.compareGeneration = 0;
    const operationId = '22222222-2222-4222-8222-222222222222';
    const receipt = { operationId, requestHash: 'c'.repeat(64), draftId: draft.id,
      draftRevision: 1, fromCatalogHash: null, toCatalogHash: 'd'.repeat(64),
      sourceRevision: 1, state: 'committed', currentChanged: true,
      createdAt: '2026-01-01T00:00:00.000Z' };
    let rejectPublish;
    const pending = new Promise((_, reject) => { rejectPublish = reject; });
    let publishCalls = 0;
    const statuses = [];
    section.configureRoutesRuntime(store, {
      operationId: () => operationId,
      api: {
        publishDraft: async () => { publishCalls += 1; return pending; },
        publicationStatus: async (...args) => { statuses.push(args); return receipt; },
      },
    });
    const first = section.publishComparedDraft();
    const second = section.publishComparedDraft();
    assert.equal(publishCalls, 1);
    rejectPublish(Object.assign(new Error('Истекло ожидание'), { name: 'TimeoutError' }));
    await Promise.all([first, second]);
    assert.deepEqual(statuses, [['sample', operationId]]);
    assert.deepEqual(store.receipt, receipt);
    assert.equal(store.pendingOperationId, null);
    assert.equal(store.opened.readOnly, true);
  });

test('RE-E6-06: подтверждение показывает точный снимок и отправляет одно действие',
  async (t) => {
    const browser = await installUiBrowser(t, 'http://cockpit.test/#/routes');
    const Component = await compileVue(webFile('src/views/routes/RoutePublishDialog.vue'), {
      stubs: { '../../ui': (`
        import { defineComponent, h } from 'vue';
        export const UiButton = defineComponent({ emits: ['click'], setup(_, { emit, slots, attrs }) {
          return () => h('button', { ...attrs, onClick: () => emit('click') }, slots.default?.());
        } });
        export const UiTextarea = defineComponent({
          props: ['modelValue'], emits: ['update:modelValue'],
          setup(props, { emit, attrs }) {
            return () => h('textarea', { ...attrs, value: props.modelValue,
              onInput: (event) => emit('update:modelValue', event.target.value) });
          },
        });
      `) +
        "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";" },
    });
    const { mount } = await import(
      '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
    );
    const report = { draftId: makeDraft().id, draftRevision: 4,
      currentCatalogHash: 'a'.repeat(64), sourceMode: 'editor', sourceRevision: 3,
      capabilitiesHash: 'b'.repeat(64), changes: [] };
    let confirms = 0;
    const wrapper = mount(Component, { attachTo: browser.document.querySelector('#mount'),
      props: { report, canPublish: true, onConfirm: () => { confirms += 1; } } });
    t.after(() => wrapper.unmount());
    assert.match(wrapper.text(), /r4/);
    assert.match(wrapper.text(), /aaaaaaaaaaaa/);
    assert.match(wrapper.text(), /источник r3/);
    await wrapper.find('[data-test="confirm-publish"]').trigger('click');
    assert.equal(confirms, 1);
  });

test('RE-E6-07: 404 статуса после timeout оставляет operationId для новой проверки',
  async () => {
    const { createPinia, setActivePinia } = await import(
      '../../web/node_modules/pinia/dist/pinia.mjs'
    );
    const section = await compileModule(webFile('src/actions/routes/index.ts'));
    setActivePinia(createPinia());
    const store = section.useRoutesStore();
    const draft = makeDraft();
    store.opened = { profile: 'sample', draftId: draft.id, readOnly: false };
    store.serverSnapshot = structuredClone(draft);
    store.localDocument = structuredClone(draft);
    store.validatedRevision = 1;
    store.validatedGeneration = 0;
    store.validatedCapabilitiesHash = 'b'.repeat(64);
    store.compareReport = { draftId: draft.id, draftRevision: 1,
      currentCatalogHash: null, sourceMode: 'editor', sourceRevision: 1,
      capabilitiesHash: 'b'.repeat(64), changes: [] };
    store.compareGeneration = 0;
    const operationId = '22222222-2222-4222-8222-222222222222';
    let uuids = 0;
    let statuses = 0;
    let publishes = 0;
    const receipt = { operationId, requestHash: 'c'.repeat(64), draftId: draft.id,
      draftRevision: 1, fromCatalogHash: null, toCatalogHash: 'd'.repeat(64),
      sourceRevision: 1, state: 'committed', currentChanged: true,
      createdAt: '2026-01-01T00:00:00.000Z' };
    section.configureRoutesRuntime(store, {
      operationId: () => { uuids += 1; return operationId; },
      api: {
        publishDraft: async () => {
          publishes += 1;
          throw Object.assign(new Error('Истекло ожидание'), { name: 'TimeoutError' });
        },
        publicationStatus: async () => {
          statuses += 1;
          if (statuses === 1) throw Object.assign(new Error('Пока не найдено'), { status: 404 });
          return receipt;
        },
      },
    });
    await section.publishComparedDraft();
    assert.equal(store.publicationOutcome, 'unknown');
    assert.equal(store.pendingOperationId, operationId);
    assert.equal(store.receipt, null);
    await section.checkPublicationOutcome();
    assert.deepEqual(store.receipt, receipt);
    assert.equal(store.pendingOperationId, null);
    assert.equal(uuids, 1);
    assert.equal(publishes, 1);
    assert.equal(statuses, 2);
  });

test('RE-E6-07: неизвестная операция остаётся за своим черновиком при переключении',
  async () => {
    const { createPinia, setActivePinia } = await import(
      '../../web/node_modules/pinia/dist/pinia.mjs'
    );
    const section = await compileModule(webFile('src/actions/routes/index.ts'));
    setActivePinia(createPinia());
    const store = section.useRoutesStore();
    const first = makeDraft();
    const second = { ...makeDraft(), id: '33333333-3333-4333-8333-333333333333' };
    const firstOperation = '44444444-4444-4444-8444-444444444444';
    const secondOperation = '55555555-5555-4555-8555-555555555555';
    const ids = [firstOperation, secondOperation];
    const calls = [];
    const receipt = { operationId: firstOperation, requestHash: 'c'.repeat(64),
      draftId: first.id, draftRevision: first.revision, fromCatalogHash: null,
      toCatalogHash: 'd'.repeat(64), sourceRevision: 1, state: 'committed',
      currentChanged: true, createdAt: '2026-01-01T00:00:00.000Z' };
    let statusCount = 0;
    section.configureRoutesRuntime(store, {
      operationId: () => ids.shift(),
      api: {
        draft: async (_profile, draftId) => draftId === first.id ? first : second,
        publishDraft: async (_profile, draftId, input) => {
          calls.push([draftId, input.operationId]);
          if (draftId === first.id) {
            throw Object.assign(new Error('Истекло ожидание'), { name: 'TimeoutError' });
          }
          return { ...receipt, operationId: secondOperation, draftId: second.id };
        },
        publicationStatus: async (_profile, operationId) => {
          calls.push(['status', operationId]);
          statusCount += 1;
          if (statusCount === 1) throw Object.assign(new Error('Пока не найдено'), { status: 404 });
          return receipt;
        },
      },
    });
    const prepare = (draft) => {
      store.validatedRevision = draft.revision;
      store.validatedGeneration = store.editGeneration;
      store.validatedCapabilitiesHash = 'b'.repeat(64);
      store.compareReport = { draftId: draft.id, draftRevision: draft.revision,
        currentCatalogHash: null, sourceMode: 'editor', sourceRevision: 1,
        capabilitiesHash: 'b'.repeat(64), changes: [] };
      store.compareGeneration = store.editGeneration;
    };
    await section.loadDraft('sample', first.id);
    prepare(first);
    await section.publishComparedDraft();
    assert.equal(store.publicationOutcome, 'unknown');
    await section.loadDraft('sample', second.id);
    prepare(second);
    await section.publishComparedDraft();
    assert.deepEqual(calls.slice(0, 3), [
      [first.id, firstOperation], ['status', firstOperation], [second.id, secondOperation],
    ]);
    await section.loadDraft('sample', first.id);
    assert.equal(store.pendingOperationId, firstOperation);
    await section.checkPublicationOutcome();
    assert.equal(store.receipt?.draftId, first.id);
  });
