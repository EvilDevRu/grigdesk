import assert from 'node:assert/strict';
import test from 'node:test';

import { makeAgentNode, makeDraft } from '../fixtures/routes-editor.mjs';
import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

test('SW-B1: перестановка сохраняет полный reset', async () => {
  const commands = await compileModule(webFile('src/views/routes/routeCommands.ts'));
  const draft = makeDraft();

  draft.routes.other = structuredClone(draft.routes.quick);
  draft.routes.other.route.id = 'other';
  draft.routes.quick.route.nodes.push(makeAgentNode({ id: 'review' }));
  draft.routes.quick.route.sequence.main.splice(2, 0, 'review');
  draft.routes.quick.route.nodes[1].onFailure = {
    build: { rewind: 'build', reset: ['build', 'check'] },
    human: { stop: 'human' },
    environment: { stop: 'human' },
  };

  const before = structuredClone(draft);
  const result = commands.moveStage(draft, { kind: 'route', routeId: 'quick' }, 'review', 'main', 1);
  const route = result.draft.routes.quick.route;

  assert.deepEqual(result.issues, []);
  assert.deepEqual(route.sequence.main, ['build', 'review', 'check', 'gate_accept']);
  assert.deepEqual(route.nodes[1].onFailure.build.reset, ['build', 'review', 'check']);
  assert.deepEqual(route.nodes[3].on.rejected.reset, ['build', 'review', 'check', 'gate_accept']);
  assert.deepEqual(route.nodes[1].onFailure.human, { stop: 'human' });
  assert.deepEqual(route.nodes[1].on, before.routes.quick.route.nodes[1].on);
  assert.deepEqual(result.draft.routes.quick.prompts, before.routes.quick.prompts);
  assert.deepEqual(result.draft.routes.other, before.routes.other);
  assert.deepEqual(draft, before);
});

test('SW-B2: обычный граф сохраняет hover и focus', async (t) => {
  const browser = await installUiBrowser(t);
  const component = await compileVue(webFile('src/views/pipeline/FactoryGraph.vue'));
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      reference: true,
      interactive: true,
      selectedNode: 'check',
      graph: {
        pos: { build: [140, 55], check: [480, 55] },
        nodes: { build: ['agent', 'Сборка', ''], check: ['code', 'Проверка', ''] },
        edges: [['_start', 'build', '', 'pass', 'h'], ['build', 'check', '', 'pass', 'h']],
      },
    },
  });

  t.after(() => wrapper.unmount());
  assert.equal(wrapper.get('[data-node="check"]').classes().includes('selected'), true);
  assert.equal(wrapper.findAll('.edge-related').length, 0);

  for (const [enter, leave] of [['mouseenter', 'mouseleave'], ['focusin', 'focusout']]) {
    await wrapper.get('[data-node="check"]').trigger(enter);
    assert.equal(wrapper.get('[data-source="build"]').classes().includes('edge-related'), true);
    assert.equal(wrapper.get('[data-source="_start"]').classes().includes('edge-muted'), true);
    await wrapper.get('[data-node="check"]').trigger(leave);
    assert.equal(wrapper.findAll('.edge-related').length, 0);
  }
});
