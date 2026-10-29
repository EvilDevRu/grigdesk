import assert from 'node:assert/strict';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';
import { toRuntimeCatalogInput } from '../../server/src/modules/routes/draftModel.ts';
import { projectRouteCatalog } from '../../shared/pipeline/routeProjection.ts';
import { addNode, renameNode, setEscalation, setTransition } from '../../web/src/views/routes/routeCommands.ts';
import { createRoute, cloneRoute, renameRoute, removeRoute,
  inspectRouteReferences, copyNodesFromRoute } from '../../web/src/views/routes/catalogCommands.ts';

const bootstrapScope = { kind: 'bootstrap' };

const UI_STUB = `
export * from './src/ui.ts';
import { defineComponent, h } from 'vue';
export { default as UiField } from './src/components/composites/UiField.vue';
export const UiButton = defineComponent({ emits: ['click'],
  setup(_, { emit, attrs, slots }) { return () => h('button', { ...attrs,
    onClick: () => emit('click') }, slots.default?.()); } });
export const UiInput = defineComponent({ props: ['modelValue'], emits: ['update:modelValue'],
  setup(props, { emit, attrs }) { return () => h('input', { ...attrs, value: props.modelValue,
    onInput: (event) => emit('update:modelValue', event.target.value) }); } });
export const UiSelect = defineComponent({ props: ['modelValue'], emits: ['update:modelValue'],
  setup(props, { emit, attrs, slots }) { return () => h('select', { ...attrs,
    value: props.modelValue,
    onChange: (event) => emit('update:modelValue', event.target.value) }, slots.default?.()); } });
export const UiSelectableRow = defineComponent({ emits: ['select'],
  setup(_, { emit, attrs, slots }) { return () => h('button', { ...attrs,
    onClick: () => emit('select') }, slots.default?.()); } });
`;

async function catalogFixture(t, initial, initialSelection = '') {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/routes');
  const Component = await compileVue(webFile('src/views/routes/RouteCatalog.vue'), {
    stubs: { '../../ui.ts': (UI_STUB) +
      "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";", '../../ui': (UI_STUB) +
      "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";" },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  let document = initial;
  let selectedRouteId = initialSelection;
  const wrapper = mount(Component, { attachTo: browser.document.querySelector('#mount'),
    props: { drafts: [], selectedDraftId: null, document, selectedRouteId,
      onChange: (next) => { document = next; void wrapper.setProps({ document }); },
      onSelectRoute: (id) => { selectedRouteId = id;
        void wrapper.setProps({ selectedRouteId }); },
    } });
  t.after(() => wrapper.unmount());
  return { wrapper, flushPromises, getDocument: () => document,
    getSelected: () => selectedRouteId };
}

test('RE-F7-01: редактор bootstrap использует свои entry, scope и prompt', async (t) => {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/routes');
  const Component = await compileVue(webFile('src/views/routes/RouteBootstrapEditor.vue'), {
    stubs: {
      '../../ui': (UI_STUB) +
        "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";",
      './RouteCanvas.vue': `export default { props: ['scope'],
        template: '<div data-test="bootstrap-canvas">{{ scope.kind }}</div>' };`,
      './RouteStageList.vue': `export default { props: ['scope'],
        template: '<div data-test="bootstrap-stage-list">{{ scope.kind }}</div>' };`,
      './RouteNodeInspector.vue': `export default { template: '<div />' };`,
      './RouteTransitionInspector.vue': `export default { template: '<div />' };`,
      './RoutePromptEditor.vue': `
        import { defineComponent, h } from 'vue';
        export default defineComponent({ props: ['scope'], emits: ['change'],
          setup(props, { emit }) { return () => h('button', {
            'data-test': 'bootstrap-prompt-change', onClick: () => emit('change', {
              bundle: { route: globalThis.__bootstrapEditorHarness.bootstrap,
                prompts: { 'bootstrap/prompts/scout.base.md': 'Новая разведка.\\n' } },
              historyGroup: 'prompt:bootstrap:bootstrap/prompts/scout.base.md',
            }),
          }, props.scope); } });`,
    },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  let document = makeDraft();
  globalThis.__bootstrapEditorHarness = { bootstrap: document.bootstrap };
  const promptChanges = [];
  const wrapper = mount(Component, { attachTo: browser.document.querySelector('#mount'),
    props: { document, selectedNodeId: 'scout',
      onChange: (next) => { document = next; void wrapper.setProps({ document }); },
      onPromptChange: (value) => promptChanges.push(value),
    } });
  t.after(() => { wrapper.unmount(); delete globalThis.__bootstrapEditorHarness; });
  assert.equal(wrapper.find('[data-test="bootstrap-canvas"]').text(), 'bootstrap');
  assert.equal(wrapper.find('[data-test="bootstrap-stage-list"]').text(), 'bootstrap');
  await wrapper.find('[data-test="bootstrap-entry"]').setValue('');
  await flushPromises();
  assert.equal(document.bootstrap.entry, null);
  await wrapper.find('[data-test="bootstrap-entry"]').setValue('scout');
  await wrapper.find('[data-test="bootstrap-prompt-change"]').trigger('click');
  assert.equal(promptChanges[0].prompts['bootstrap/prompts/scout.base.md'],
    'Новая разведка.\n');
  assert.equal(promptChanges[0].historyGroup,
    'prompt:bootstrap:bootstrap/prompts/scout.base.md');
});

test('RE-F7-01: форма каталога создаёт и копирует маршрут без мышиной схемы', async (t) => {
  const draft = makeDraft();
  draft.routes = {};
  const { wrapper, flushPromises, getDocument, getSelected } = await catalogFixture(t, draft);
  await wrapper.find('[data-test="route-new-id"]').setValue('quick');
  await wrapper.find('[data-test="route-new-title"]').setValue('Быстрый маршрут');
  await wrapper.find('[data-test="route-create"]').trigger('click');
  await flushPromises();
  assert.equal(getSelected(), 'quick');
  assert.equal(getDocument().routes.quick.route.title, 'Быстрый маршрут');
  await wrapper.find('[data-test="route-bootstrap-mode"]').setValue('required');
  await wrapper.find('[data-test="route-save-properties"]').trigger('click');
  assert.equal(getDocument().routes.quick.route.bootstrap, 'required');
  await wrapper.find('[data-test="route-copy-id"]').setValue('audit');
  await wrapper.find('[data-test="route-copy"]').trigger('click');
  await flushPromises();
  assert.equal(getDocument().routes.audit.route.id, 'audit');
});

test('RE-F7-02: форма переименовывает маршрут и выбирает новый ID', async (t) => {
  const { wrapper, getDocument, getSelected } = await catalogFixture(t, makeDraft(), 'quick');
  await wrapper.find('[data-test="route-rename-id"]').setValue('quick_fix');
  await wrapper.find('[data-test="route-rename"]').trigger('click');
  assert.equal(getSelected(), 'quick_fix');
  assert.deepEqual(getDocument().bootstrap.escalation[0].allowedRoutes, ['quick_fix']);
});

test('RE-F7-03: удаление в форме показывает ссылки и оставляет проблемы явно', async (t) => {
  let draft = cloneRoute(makeDraft(), 'quick', 'audit').draft;
  draft = setEscalation(draft, bootstrapScope, 'scout', ['quick', 'audit'], true).draft;
  draft = setTransition(draft, bootstrapScope, 'scout', 'done',
    { escalate: { routes: ['quick', 'audit'] } }).draft;
  const { wrapper, getDocument, getSelected } = await catalogFixture(t, draft, 'audit');
  await wrapper.find('[data-test="route-remove"]').trigger('click');
  assert.match(wrapper.find('[data-test="route-remove-preview"]').text(), /bootstrap.*allowedRoutes/);
  assert.ok(getDocument().routes.audit);
  await wrapper.find('[data-test="route-confirm-remove"]').trigger('click');
  assert.equal(getSelected(), 'quick');
  assert.equal(Object.hasOwn(getDocument().routes, 'audit'), false);
  assert.match(wrapper.find('[data-test="route-catalog-issues"]').text(), /Ссылка на маршрут/);
});

test('RE-F7-05: форма копирует выбранные этапы с предупреждениями', async (t) => {
  const draft = createRoute(makeDraft(), 'audit').draft;
  const { wrapper, getDocument } = await catalogFixture(t, draft, 'audit');
  await wrapper.find('[data-test="route-node-source"]').setValue('quick');
  await wrapper.find('[data-test="route-node-copy-build"]').trigger('click');
  await wrapper.find('[data-test="route-node-copy-check"]').trigger('click');
  await wrapper.find('[data-test="route-copy-nodes"]').trigger('click');
  assert.deepEqual(getDocument().routes.audit.route.sequence.main,
    ['build_copy', 'check_copy']);
  assert.match(wrapper.find('[data-test="route-catalog-issues"]').text(), /вне копируемой группы/);
});

test('RE-F7-01: quick создаётся с нуля, audit копируется, bootstrap выбирает оба', () => {
  let draft = makeDraft();
  draft.routes = {};
  draft = createRoute(draft, 'quick', 'Быстрый маршрут').draft;
  assert.deepEqual(Object.keys(draft.routes), ['quick']);
  assert.equal(draft.routes.quick.route.entry, null);
  draft = addNode(draft, { kind: 'route', routeId: 'quick' }, 'agent', () => 'BUILD').draft;
  draft.routes.quick.prompts['prompts/build.base.md'] = 'Сделай результат.\n';
  for (const [outcome, stop] of [
    ['done', 'done'], ['skipped', 'human'], ['failed', 'failed'], ['exhausted', 'human'],
  ]) {
    draft = setTransition(draft, { kind: 'route', routeId: 'quick' }, 'build',
      outcome, { stop }).draft;
  }
  draft = cloneRoute(draft, 'quick', 'audit').draft;
  assert.deepEqual(Object.keys(draft.routes).sort(), ['audit', 'quick']);
  draft = setEscalation(draft, bootstrapScope, 'scout', ['quick', 'audit'], true).draft;
  draft = setTransition(draft, bootstrapScope, 'scout', 'done',
    { escalate: { routes: ['quick', 'audit'] } }).draft;
  assert.deepEqual(draft.bootstrap.escalation[0].allowedRoutes, ['quick', 'audit']);
  assert.deepEqual(draft.bootstrap.nodes[0].on.done.escalate.routes, ['quick', 'audit']);
  const executable = toRuntimeCatalogInput(draft);
  assert.equal(executable.ok, true, JSON.stringify(executable.issues));
  assert.equal(executable.input.routes.audit.route.id, 'audit');
});

test('RE-F7-02: rename route меняет все ссылки каталога, исходный снимок неизменен', () => {
  let draft = makeDraft();
  draft = cloneRoute(draft, 'quick', 'audit').draft;
  draft.bootstrap.escalation[0].allowedRoutes.push('audit');
  draft.bootstrap.nodes[0].on.done.escalate.routes.push('audit');
  draft.routes.audit.route.nodes[0].on.failed = { escalate: { routes: ['quick'] } };
  draft.routes.audit.route.nodes[0].onFailure = {
    build: { escalate: { routes: ['quick'] } },
  };
  draft.routes.audit.route.escalation.push({
    from: 'build', allowedRoutes: ['quick'], requiresHumanWhenPinned: true,
  });
  draft.presentation['r:quick:build'] = { x: 200, y: 120 };
  const original = structuredClone(draft);
  const result = renameRoute(draft, 'quick', 'quick_fix');
  assert.equal(result.issues.length, 0);
  assert.deepEqual(Object.keys(result.draft.routes).sort(), ['audit', 'quick_fix']);
  assert.equal(result.draft.routes.quick_fix.route.id, 'quick_fix');
  assert.deepEqual(result.draft.bootstrap.escalation[0].allowedRoutes, ['quick_fix', 'audit']);
  assert.deepEqual(result.draft.bootstrap.nodes[0].on.done.escalate.routes, ['quick_fix', 'audit']);
  assert.deepEqual(result.draft.routes.audit.route.nodes[0].on.failed.escalate.routes,
    ['quick_fix']);
  assert.deepEqual(result.draft.routes.audit.route.nodes[0].onFailure.build.escalate.routes,
    ['quick_fix']);
  assert.deepEqual(result.draft.routes.audit.route.escalation[0].allowedRoutes, ['quick_fix']);
  assert.deepEqual(result.draft.presentation['r:quick_fix:build'], { x: 200, y: 120 });
  assert.equal(Object.hasOwn(result.draft.presentation, 'r:quick:build'), false);
  assert.deepEqual(draft, original);
});

test('RE-F7-03: удаление оставляет видимые ссылки, publish блокируется до явного решения', () => {
  let draft = cloneRoute(makeDraft(), 'quick', 'audit').draft;
  draft = setEscalation(draft, bootstrapScope, 'scout', ['quick', 'audit'], true).draft;
  draft = setTransition(draft, bootstrapScope, 'scout', 'done',
    { escalate: { routes: ['quick', 'audit'] } }).draft;
  assert.equal(inspectRouteReferences(draft, 'audit').length, 2);
  const removed = removeRoute(draft, 'audit');
  assert.equal(Object.hasOwn(removed.draft.routes, 'audit'), false);
  assert.equal(removed.issues.length, 2);
  const invalid = toRuntimeCatalogInput(removed.draft);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some((issue) => issue.code === 'route_reference_missing'));
  const fixedAllowed = setEscalation(removed.draft, bootstrapScope, 'scout', ['quick'], true).draft;
  const fixed = setTransition(fixedAllowed, bootstrapScope, 'scout', 'done',
    { escalate: { routes: ['quick'] } }).draft;
  assert.equal(toRuntimeCatalogInput(fixed).ok, true);
  const empty = removeRoute(fixed, 'quick').draft;
  assert.deepEqual(Object.keys(empty.routes), []);
  assert.ok(toRuntimeCatalogInput(empty).issues.some((issue) => issue.code === 'catalog_empty'));
});

test('RE-F7-04: одинаковый node ID bootstrap/route сохраняет раздельные выбор и координаты', () => {
  const draft = makeDraft();
  draft.presentation['b:scout'] = { x: 25, y: 30 };
  draft.presentation['r:quick:build'] = { x: 200, y: 180 };
  const renamed = renameNode(draft, { kind: 'route', routeId: 'quick' }, 'build', 'scout');
  assert.deepEqual(renamed.draft.presentation['b:scout'], { x: 25, y: 30 });
  assert.deepEqual(renamed.draft.presentation['r:quick:scout'], { x: 200, y: 180 });
  assert.equal(Object.hasOwn(renamed.draft.presentation, 'r:quick:build'), false);
  const graph = projectRouteCatalog(renamed.draft);
  assert.ok(graph.bootstrap.nodes.some((node) => node.id === 'b:scout'
    && node.origin.scope === 'bootstrap'));
  assert.ok(graph.routes.quick.nodes.some((node) => node.id === 'r:quick:scout'
    && node.origin.scope === 'route'));
});

test('RE-F7-05: копирование узлов из другого маршрута отделяет инструкции и показывает зависимости',
  () => {
    const source = makeDraft();
    const original = structuredClone(source);
    const empty = createRoute(source, 'audit').draft;
    const copied = copyNodesFromRoute(empty, 'quick', 'audit', ['build', 'check'],
      (suggested) => `${suggested}_COPY`);
    assert.notEqual(copied.draft, empty);
    assert.ok(copied.issues.some((issue) => issue.code === 'external_reference'));
    const audit = copied.draft.routes.audit;
    assert.deepEqual(audit.route.sequence.main, ['build_copy', 'check_copy']);
    assert.deepEqual(audit.route.nodes.find((node) => node.id === 'build_copy').on.done,
      { next: 'check_copy' });
    assert.equal(audit.route.nodes.find((node) => node.id === 'build_copy').on.skipped, null);
    const copiedFile = audit.route.nodes.find((node) => node.id === 'build_copy').prompt.blocks[0].file;
    assert.equal(audit.prompts[copiedFile], source.routes.quick.prompts['prompts/build.base.md']);
    audit.prompts[copiedFile] = 'Новая инструкция копии.\n';
    assert.equal(source.routes.quick.prompts['prompts/build.base.md'],
      'Создай проверяемый результат.\n');
    assert.equal(copied.draft.routes.quick.prompts['prompts/build.base.md'],
      'Создай проверяемый результат.\n');
    assert.deepEqual(source, original);
  });
