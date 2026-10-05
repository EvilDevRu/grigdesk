import assert from 'node:assert/strict';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { parseRouteDraft } from '../../shared/routesEditorContracts.ts';
import { toRuntimeCatalogInput } from '../../server/src/modules/routes/draftModel.ts';
import { removeNodes } from '../../web/src/views/routes/routeCommands.ts';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

const UI_STUB = `
import { defineComponent, h } from 'vue';
export const UiButton = defineComponent({ emits: ['click'], setup(_, { emit, slots, attrs }) {
  return () => h('button', { ...attrs, onClick: () => emit('click') }, slots.default?.());
} });
export const UiInput = defineComponent({ props: ['modelValue'], emits: ['update:modelValue'],
  setup(props, { emit, attrs }) { return () => h('input', { ...attrs, value: props.modelValue,
    onInput: (event) => emit('update:modelValue', event.target.value) }); } });
export const UiNumberInput = defineComponent({ props: ['modelValue'], emits: ['update:modelValue'],
  setup(props, { emit, attrs }) { return () => h('input', { ...attrs, type: 'number',
    value: props.modelValue, onInput: (event) => emit('update:modelValue', Number(event.target.value)) }); } });
export const UiSelect = defineComponent({ props: ['modelValue'], emits: ['update:modelValue'],
  setup(props, { emit, attrs, slots }) { return () => h('select', { ...attrs,
    value: props.modelValue,
    onChange: (event) => emit('update:modelValue', event.target.value) }, slots.default?.()); } });
`;

async function fixture(t, initial = makeDraft(), nodeId = 'build',
  routeScope = { kind: 'route', routeId: 'quick' }, policyResult = null) {
  const browser = await installUiBrowser(t, 'http://cockpit.test/#/routes');
  const Component = await compileVue(webFile('src/views/routes/RouteNodeInspector.vue'), {
    stubs: { '../../ui': (UI_STUB) +
      "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";",
      '../../shared/routesApi.ts': `export const routesApi = {
        effectivePolicy: async () => (${JSON.stringify(policyResult)})
      };`,
    },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  let document = initial;
  let selectedId = nodeId;
  const capabilities = { schema: 1,
    commands: [{ id: 'project-check', label: 'Проверка', filesystem: ['state-only'] }],
    contextSections: [], filesystem: ['state-only', 'workspace-write'],
    timeoutClasses: ['standard', 'check', 'build'], retryStrategies: ['none', 'runner-failover'] };
  const wrapper = mount(Component, { attachTo: browser.document.querySelector('#mount'),
    props: { document, nodeId, scope: routeScope, capabilities,
      onChange: (next) => { document = next; void wrapper.setProps({ document }); },
      onSelectNode: (value) => { selectedId = value.nodeId;
        void wrapper.setProps({ nodeId: selectedId }); } } });
  t.after(() => wrapper.unmount());
  return { wrapper, flushPromises, getDocument: () => document,
    getSelected: () => selectedId };
}

test('RE-F7-04: инспектор переименовывает узел и меняет подпись отдельными командами',
  async (t) => {
    const { wrapper, flushPromises, getDocument, getSelected } = await fixture(t);
    await wrapper.find('[data-test="node-new-id"]').setValue('build_fix');
    await wrapper.find('[data-test="node-rename"]').trigger('click');
    await flushPromises();
    assert.equal(getSelected(), 'build_fix');
    assert.equal(getDocument().routes.quick.route.entry, 'build_fix');
    await wrapper.find('[data-test="node-label"]').setValue('Исправление');
    await wrapper.find('[data-test="node-save-label"]').trigger('click');
    assert.equal(getDocument().routes.quick.route.nodes.find((node) => node.id === 'build_fix').label,
      'Исправление');
  });

test('RE-F7-04: инспектор удаляет висячую ссылку на уже удалённый статус', async (t) => {
  const draft = removeNodes(makeDraft(), { kind: 'route', routeId: 'quick' },
    ['check_status']).draft;
  assert.deepEqual(draft.routes.quick.route.nodes.find((node) => node.id === 'check').emits,
    ['check_status']);
  const { wrapper, getDocument } = await fixture(t, draft, 'check');
  await wrapper.find('[data-test="node-remove-emit-check_status"]').trigger('click');
  assert.deepEqual(getDocument().routes.quick.route.nodes.find((node) => node.id === 'check').emits,
    []);
  assert.equal(toRuntimeCatalogInput(getDocument()).ok, true);
});

async function transitionFixture(t, initial = makeDraft(), nodeId = 'build',
  routeScope = { kind: 'route', routeId: 'quick' }) {
  const browser = await installUiBrowser(t, 'http://cockpit.test/#/routes');
  const Component = await compileVue(webFile('src/views/routes/RouteTransitionInspector.vue'), {
    stubs: { '../../ui': (UI_STUB) +
      "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";" },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  let document = initial;
  const wrapper = mount(Component, { attachTo: browser.document.querySelector('#mount'),
    props: { document, nodeId, scope: routeScope,
      onChange: (next) => { document = next; void wrapper.setProps({ document }); } } });
  t.after(() => wrapper.unmount());
  return { wrapper, flushPromises, getDocument: () => document };
}

test('RE-F4-01: agent редактирует policy/fanout/retry и сохраняет неизвестный budgetClass',
  async (t) => {
    const draft = makeDraft();
    draft.routes.quick.route.nodes[0].policy.budgetClass = 'legacy-custom';
    const { wrapper, flushPromises, getDocument } = await fixture(t, draft);
    const change = async (selector, value) => {
      await wrapper.find(selector).setValue(value);
      await flushPromises();
    };
    assert.equal(wrapper.find('[data-test="policy-budget-class"]').element.value, 'legacy-custom');
    await change('[data-test="policy-filesystem"]', 'workspace-write');
    await change('[data-test="policy-browser"]', 'allow');
    assert.equal(getDocument().routes.quick.route.nodes[0].policy.browser, 'allow');
    await change('[data-test="policy-timeout-class"]', 'build');
    assert.equal(getDocument().routes.quick.route.nodes[0].policy.timeoutClass, 'build');
    await change('[data-test="policy-filesystem"]', 'state-only');
    await change('[data-test="fanout-mode"]', 'parallel');
    await change('[data-test="fanout-max"]', '2');
    await change('[data-test="fanout-degrade"]', 'allow-single');
    await change('[data-test="retry-no-result"]', '1');
    await change('[data-test="retry-provider-attempts"]', '2');
    await change('[data-test="retry-provider-strategy"]', 'runner-failover');
    const node = getDocument().routes.quick.route.nodes[0];
    assert.deepEqual(node.policy, { filesystem: 'state-only', browser: 'allow',
      timeoutClass: 'build', budgetClass: 'legacy-custom' });
    assert.deepEqual(node.fanout, { mode: 'parallel', maxExecutors: 2, degrade: 'allow-single' });
    assert.deepEqual(node.retry, { noResult: 1, productFailure: 0,
      providerFailure: { attempts: 2, strategy: 'runner-failover' } });
  });

test('RE-F4-02: command выбирается из capabilities, недоступный ID остаётся видимым',
  async (t) => {
    const draft = makeDraft();
    draft.routes.quick.route.nodes.find((node) => node.id === 'check').commandId = 'old-command';
    const { wrapper, flushPromises, getDocument } = await fixture(t, draft, 'check');
    assert.equal(wrapper.find('[data-test="command-id"]').element.value, 'old-command');
    assert.match(wrapper.text(), /недоступна/i);
    assert.equal(wrapper.findAll('[data-test="command-id"] option')
      .some((option) => option.attributes('value') === 'sh -c'), false);
    await wrapper.find('[data-test="command-id"]').setValue('project-check');
    await flushPromises();
    assert.equal(getDocument().routes.quick.route.nodes.find((node) => node.id === 'check')
      .commandId, 'project-check');
  });

test('RE-F4-03: gate показывает исходы/emits, status меняет key/owner без policy/prompt',
  async (t) => {
    const gateFixture = await fixture(t, makeDraft(), 'gate_accept');
    assert.match(gateFixture.wrapper.text(), /approved/);
    assert.match(gateFixture.wrapper.text(), /rejected/);
    assert.match(gateFixture.wrapper.text(), /Публикует статусы/);
    const gate = gateFixture.getDocument().routes.quick.route.nodes.find((node) =>
      node.id === 'gate_accept');
    assert.equal(Object.hasOwn(gate, 'policy'), false);
    assert.equal(Object.hasOwn(gate, 'prompt'), false);

    const statusFixture = await fixture(t, makeDraft(), 'check_status');
    await statusFixture.wrapper.find('[data-test="status-key"]').setValue('CHECK_RESULT');
    await statusFixture.flushPromises();
    await statusFixture.wrapper.find('[data-test="status-owner"]').setValue('build');
    await statusFixture.flushPromises();
    const machine = statusFixture.getDocument().routes.quick.route;
    const status = machine.nodes.find((node) => node.id === 'check_status');
    assert.equal(status.key, 'CHECK_RESULT');
    assert.equal(status.owner, 'build');
    assert.deepEqual(machine.nodes.find((node) => node.id === 'build').emits, ['check_status']);
    assert.deepEqual(machine.nodes.find((node) => node.id === 'check').emits, []);
    assert.equal(Object.hasOwn(status, 'policy'), false);
    assert.equal(Object.hasOwn(status, 'prompt'), false);
  });

test('RE-F4-04: все on/onFailure редактируются раздельно и не теряют соседние исходы',
  async (t) => {
    const draft = makeDraft();
    draft.routes.quick.route.nodes[0].onFailure = {
      build: { stop: 'human' }, tests: { stop: 'human' },
      environment: { stop: 'human' }, plan: { stop: 'human' },
      human: { stop: 'human' },
    };
    const { wrapper, flushPromises, getDocument } = await transitionFixture(t, draft);
    const change = async (selector, value) => {
      await wrapper.find(selector).setValue(value);
      await flushPromises();
    };
    await change('[data-test="action-on-done"]', 'stop');
    await change('[data-test="stop-kind-on-done"]', 'failed');
    await change('[data-test="action-onFailure-tests"]', 'next');
    await change('[data-test="target-onFailure-tests"]', 'gate_accept');
    const node = getDocument().routes.quick.route.nodes[0];
    assert.deepEqual(node.on.done, { stop: 'failed' });
    assert.deepEqual(node.on.skipped, { next: 'gate_accept' });
    assert.deepEqual(node.onFailure.tests, { next: 'gate_accept' });
    assert.deepEqual(node.onFailure.environment, { stop: 'human' });
    assert.deepEqual(Object.keys(node.onFailure),
      ['build', 'tests', 'environment', 'plan', 'human']);
  });

test('RE-F4-04: escalation редактирует разрешённые маршруты и решение при пине',
  async (t) => {
    const draft = makeDraft();
    draft.routes.audit = structuredClone(draft.routes.quick);
    draft.routes.audit.route.id = 'audit';
    const { wrapper, flushPromises, getDocument } = await transitionFixture(
      t, draft, 'scout', { kind: 'bootstrap' });
    await wrapper.find('[data-test="allow-route-audit"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="escalate-route-on-done-audit"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-test="human-when-pinned"]').setValue('false');
    await flushPromises();
    assert.deepEqual(getDocument().bootstrap.escalation[0], { from: 'scout',
      allowedRoutes: ['quick', 'audit'], requiresHumanWhenPinned: false });
    assert.deepEqual(getDocument().bootstrap.nodes[0].on.done,
      { escalate: { routes: ['quick', 'audit'] } });
  });

test('RE-F4-05: несовместимые режимы объяснены; смена типа требует просмотра потерь',
  async (t) => {
    const draft = makeDraft();
    const build = draft.routes.quick.route.nodes[0];
    build.policy.filesystem = 'workspace-write';
    build.fanout.mode = 'parallel';
    build.retry.providerFailure = { attempts: 1, strategy: 'same-runner' };
    const original = structuredClone(draft);
    const { wrapper, flushPromises, getDocument } = await fixture(t, draft);
    assert.match(wrapper.text(), /same-runner.*не поддерж/i);
    assert.match(wrapper.text(), /parallel.*state-only/i);
    await wrapper.find('[data-test="executor-type"]').setValue('command');
    await flushPromises();
    assert.match(wrapper.text(), /Создай проверяемый результат/);
    assert.match(wrapper.text(), /parallel.*сброш/i);
    assert.match(wrapper.text(), /повторы.*сброш/i);
    await wrapper.find('[data-test="cancel-type-change"]').trigger('click');
    await flushPromises();
    assert.deepEqual(getDocument(), original);
    await wrapper.find('[data-test="executor-type"]').setValue('command');
    await flushPromises();
    await wrapper.find('[data-test="apply-type-change"]').trigger('click');
    await flushPromises();
    const changed = getDocument().routes.quick.route.nodes[0];
    assert.equal(changed.executor, 'command');
    assert.equal(Object.hasOwn(changed, 'prompt'), false);
    assert.deepEqual(changed.fanout, { mode: 'single', maxExecutors: 1, degrade: 'forbid' });
    assert.deepEqual(changed.retry, { noResult: 0, productFailure: 0,
      providerFailure: { attempts: 0, strategy: 'none' } });
  });

test('RE-F4-06: открытие форм всех executor сохраняет runtime после save/read', async (t) => {
  const original = makeDraft();
  const before = toRuntimeCatalogInput(original);
  assert.equal(before.ok, true);
  const { wrapper, flushPromises, getDocument } = await fixture(t, original);
  for (const nodeId of ['build', 'check', 'gate_accept', 'check_status']) {
    await wrapper.setProps({ nodeId });
    await flushPromises();
    assert.match(wrapper.text(), new RegExp(nodeId));
  }
  const read = parseRouteDraft(JSON.parse(JSON.stringify(getDocument())));
  const after = toRuntimeCatalogInput(read);
  assert.equal(after.ok, true);
  assert.deepEqual(after.input, before.input);
  assert.deepEqual(original, makeDraft());
});

test('RE-F4-07: эффективная политика показана отдельно и не попадает в черновик',
  async (t) => {
    const original = makeDraft();
    const policy = { runKey: 'BUILD', primary: 'claude', failover: ['codex'],
      source: 'profile-stage', models: { claude: { exact: 'synthetic-model', family: null,
        version: null, variant: null, effort: 'high' } } };
    const { wrapper, flushPromises, getDocument } = await fixture(
      t, original, 'build', { kind: 'route', routeId: 'quick' }, policy);
    await flushPromises();
    assert.match(wrapper.text(), /synthetic-model/);
    assert.match(wrapper.text(), /claude/);
    assert.match(wrapper.text(), /high/);
    assert.equal(wrapper.find('[data-test="model-input"]').exists(), false);
    assert.equal(wrapper.find('[data-test="provider-input"]').exists(), false);
    assert.deepEqual(getDocument(), original);
  });

test('RE-F4-07: недоступная политика подписана как недоступная', async (t) => {
  const { wrapper, flushPromises } = await fixture(t);
  await flushPromises();
  assert.match(wrapper.text(), /политика запуска недоступна/i);
});
