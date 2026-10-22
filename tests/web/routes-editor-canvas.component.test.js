import assert from 'node:assert/strict';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { toRuntimeCatalogInput } from '../../server/src/modules/routes/draftModel.ts';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

const UI_STUB = `
import { defineComponent, h } from 'vue';
export { default as UiField } from './src/components/composites/UiField.vue';
export { default as UiIconButton } from './src/components/primitives/UiIconButton.vue';
export const UiSvgPressable = defineComponent({ emits: ['click'],
  setup(_, { emit, attrs, slots }) { return () => h('g', {
    ...attrs, role: 'button', tabindex: 0,
    onClick: (event) => emit('click', event),
    onKeydown: (event) => { if (event.key === 'Enter') emit('click', event); },
  }, slots.default?.()); } });
export const UiButton = defineComponent({ emits: ['click'],
  setup(_, { emit, attrs, slots }) { return () => h('button', {
    ...attrs, onClick: (event) => emit('click', event),
    onKeydown: (event) => { if (event.key === 'Enter') emit('click', event); },
  }, slots.default?.()); } });
export const UiInput = defineComponent({ props: ['modelValue'], emits: ['update:modelValue'],
  setup(props, { emit, attrs }) { return () => h('input', { ...attrs, value: props.modelValue,
    onInput: (event) => emit('update:modelValue', event.target.value) }); } });
export const UiSelect = defineComponent({ props: ['modelValue'], emits: ['update:modelValue'],
  setup(props, { emit, attrs, slots }) { return () => h('select', { ...attrs,
    value: props.modelValue,
    onChange: (event) => emit('update:modelValue', event.target.value) }, slots.default?.()); } });
`;

async function fixture(t, initial = makeDraft(), scope = { kind: 'route', routeId: 'quick' }) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/routes');
  const Component = await compileVue(webFile('src/views/routes/RouteCanvas.vue'), {
    stubs: { '../../ui': (UI_STUB) +
      "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";" },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  let document = initial;
  const selected = [];
  const focused = [];
  const wrapper = mount(Component, { attachTo: browser.document.querySelector('#mount'),
    props: { document, scope,
      onSelectNode: (value) => selected.push(value),
      onFocusField: (value) => focused.push(value),
      onChange: (next) => { document = next; void wrapper.setProps({ document }); },
    } });
  t.after(() => wrapper.unmount());
  return { wrapper, selected, focused, flushPromises, getDocument: () => document };
}

async function stageFixture(t) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/routes');
  const Component = await compileVue(webFile('src/views/routes/RouteStageList.vue'), {
    stubs: { '../../ui': (UI_STUB) +
      "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";" },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  let document = makeDraft();
  let selectedNodeId = '';
  const scope = { kind: 'route', routeId: 'quick' };
  const wrapper = mount(Component, { attachTo: browser.document.querySelector('#mount'),
    props: { document, scope, selectedNodeId,
      onSelectNode: (value) => {
        selectedNodeId = value.nodeId;
        void wrapper.setProps({ selectedNodeId });
      },
      onChange: (next) => { document = next; void wrapper.setProps({ document }); },
    } });
  t.after(() => wrapper.unmount());
  return { wrapper, flushPromises, getDocument: () => document,
    getSelected: () => selectedNodeId };
}

test('RE-F5-01: узел и issue выбирают правильный scope/id и фокус поля', async (t) => {
  const draft = makeDraft();
  draft.routes.audit = structuredClone(draft.routes.quick);
  draft.routes.audit.route.id = 'audit';
  draft.routes.audit.route.nodes[0].label = 'Сборка аудита';
  const { wrapper, selected, focused, flushPromises } = await fixture(t, draft);
  await wrapper.find('[data-node="build"]').trigger('click');
  assert.deepEqual(selected, [{ scope: { kind: 'route', routeId: 'quick' }, nodeId: 'build' }]);
  assert.equal(wrapper.text().includes('Сборка аудита'), false);
  const issue = { code: 'prompt_required', severity: 'error', scope: 'route',
    routeId: 'quick', nodeId: 'build',
    path: '/routes/quick/route/nodes/0/prompt/blocks/0', message: 'Инструкция пуста' };
  await wrapper.setProps({ focusedIssue: issue });
  await flushPromises();
  assert.deepEqual(focused, [{ scope: { kind: 'route', routeId: 'quick' },
    nodeId: 'build', path: issue.path }]);
});

test('RE-F5-02: холст рисует схему конвейера — этапы, склеенные исходы и выбор узла',
  async (t) => {
    const draft = makeDraft();
    const before = toRuntimeCatalogInput(draft);
    const { wrapper, getDocument } = await fixture(t, draft);
    const drawn = wrapper.findAll('[data-node]').map((node) => node.attributes('data-node'));
    const edge = (from, to) => wrapper.find(`[data-source="${from}"][data-destination="${to}"]`);

    // Остановки и status — исходы, а не этапы: в змейке их нет, стенд зависит от профиля.
    assert.deepEqual(drawn, ['build', 'check', 'gate_accept']);
    assert.match(edge('build', 'check').find('text').text(), /done/);
    assert.match(edge('build', 'gate_accept').find('text').text(), /skipped/);
    assert.equal(edge('gate_accept', 'build').find('path').classes().includes('e-fail'), true);
    assert.ok(wrapper.find('svg marker').exists());
    // Подзаголовок узла — его ID: по нему задаются переходы.
    assert.match(wrapper.find('[data-node="check"] .node-detail').text(), /check/);

    await wrapper.setProps({ selectedNodeId: 'check' });
    assert.equal(wrapper.find('[data-node="check"]').classes().includes('selected'), true);
    assert.equal(wrapper.find('[data-node="check"]').attributes('aria-current'), 'true');
    assert.equal(wrapper.find('[data-node="build"]').classes().includes('selected'), false);
    assert.deepEqual(toRuntimeCatalogInput(getDocument()), before);
  });

test('RE-F5-03: соединение исхода вызывает один setTransition; оба исхода видны на линии',
  async (t) => {
    const { wrapper, flushPromises, getDocument } = await fixture(t);
    await wrapper.find('[data-test="connect-source"]').setValue('build');
    await wrapper.find('[data-test="connect-outcome"]').setValue('done');
    await wrapper.find('[data-test="connect-start"]').trigger('click');
    await wrapper.find('[data-node="gate_accept"]').trigger('click');
    await flushPromises();
    const build = getDocument().routes.quick.route.nodes.find((node) => node.id === 'build');
    assert.deepEqual(build.on.done, { next: 'gate_accept' });
    assert.deepEqual(build.on.skipped, { next: 'gate_accept' });
    const lines = wrapper.findAll('[data-source="build"][data-destination="gate_accept"]');
    assert.equal(lines.length, 1);
    assert.match(lines[0].find('text').text(), /done/);
    assert.match(lines[0].find('text').text(), /skipped/);
    assert.equal(wrapper.find('[data-source="build"][data-destination="check"]').exists(), false);
  });

test('RE-F5-04: масштаб и поиск берегут выбор и runtime', async (t) => {
  const draft = makeDraft();
  const before = toRuntimeCatalogInput(draft);
  const { wrapper, selected, getDocument } = await fixture(t, draft);
  const width = () => wrapper.find('svg.graph').attributes('style');
  const natural = width();
  await wrapper.find('[data-test="zoom-in"]').trigger('click');
  assert.notEqual(width(), natural);
  await wrapper.find('[data-test="zoom-reset"]').trigger('click');
  assert.equal(width(), natural);
  for (let step = 0; step < 5; step += 1) {
    await wrapper.find('[data-test="zoom-out"]').trigger('click');
  }
  // Ниже половины натурального размера текст узлов не читается: масштаб там упирается.
  assert.equal(wrapper.find('[data-test="zoom-out"]').attributes('disabled'), '');
  await wrapper.find('[data-test="search-nodes"]').setValue('check');
  await wrapper.find('[data-test="search-nodes"]').trigger('keydown', { key: 'Enter' });
  assert.equal(selected.at(-1).nodeId, 'check');
  assert.deepEqual(toRuntimeCatalogInput(getDocument()), before);
});

test('RE-F5-06: разведка на холсте показывает маршруты, из которых выбирает', async (t) => {
  const draft = makeDraft();
  draft.bootstrap.nodes[0].on.done = { escalate: { routes: ['quick', 'audit'] } };
  const { wrapper, selected } = await fixture(t, draft, { kind: 'bootstrap' });
  const drawn = wrapper.findAll('[data-node]').map((node) => node.attributes('data-node'));

  assert.deepEqual(drawn, ['scout', 'catalog:route:quick', 'catalog:route:audit']);
  assert.equal(wrapper.find('[data-node="catalog:route:audit"]').attributes('role'), undefined);
  await wrapper.find('[data-node="catalog:route:audit"]').trigger('click');
  await wrapper.find('[data-node="scout"]').trigger('click');
  assert.deepEqual(selected, [{ scope: { kind: 'bootstrap' }, nodeId: 'scout' }]);
});

test('RE-F5-07: незаконченный черновик с удалённым входом рисуется без падения', async (t) => {
  const draft = makeDraft();
  draft.routes.quick.route.entry = 'ghost';
  draft.routes.quick.route.sequence.main.unshift('ghost');
  const { wrapper } = await fixture(t, draft);
  const drawn = wrapper.findAll('[data-node]').map((node) => node.attributes('data-node'));

  assert.deepEqual(drawn, ['build', 'check', 'gate_accept']);
  assert.equal(wrapper.find('[data-source="_start"]').exists(), false);
});

test('RE-F5-05: список и клавиатура добавляют, переставляют, соединяют и удаляют с preview',
  async (t) => {
    const { wrapper, flushPromises, getDocument, getSelected } = await stageFixture(t);
    const list = wrapper.find('.route-stage-list');
    await list.trigger('keydown', { key: 'Insert' });
    await flushPromises();
    assert.equal(getSelected(), 'agent');
    assert.ok(getDocument().routes.quick.route.nodes.some((node) => node.id === 'agent'));
    assert.equal(getDocument().routes.quick.prompts['prompts/agent.base.md'], '');

    await wrapper.find('[data-test="stage-select-check"]').trigger('keydown', { key: 'Enter' });
    await list.trigger('keydown', { key: 'ArrowUp', altKey: true });
    await flushPromises();
    assert.deepEqual(getDocument().routes.quick.route.sequence.main.slice(0, 2), ['check', 'build']);

    await wrapper.find('[data-test="stage-select-build"]').trigger('keydown', { key: 'Enter' });
    await wrapper.find('[data-test="stage-outcome"]').setValue('done');
    await wrapper.find('[data-test="stage-target"]').setValue('gate_accept');
    await wrapper.find('[data-test="stage-connect"]').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    assert.deepEqual(getDocument().routes.quick.route.nodes.find((node) => node.id === 'build').on.done,
      { next: 'gate_accept' });

    await wrapper.find('[data-test="stage-select-gate_accept"]')
      .trigger('keydown', { key: 'Enter' });
    await list.trigger('keydown', { key: 'Delete' });
    assert.match(wrapper.find('[data-test="stage-delete-preview"]').text(), /build.*skipped/);
    assert.ok(getDocument().routes.quick.route.nodes.some((node) => node.id === 'gate_accept'));

    const monaco = browserTextArea(list.element.ownerDocument);
    list.element.append(monaco);
    monaco.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    assert.ok(getDocument().routes.quick.route.nodes.some((node) => node.id === 'gate_accept'));
    await wrapper.find('[data-test="stage-confirm-delete"]').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    assert.equal(getDocument().routes.quick.route.nodes.some((node) => node.id === 'gate_accept'), false);
    assert.match(wrapper.find('[data-test="stage-issues"]').text(), /связь|Связь/);
  });

function browserTextArea(document) {
  const element = document.createElement('textarea');
  element.className = 'monaco-editor';
  return element;
}
