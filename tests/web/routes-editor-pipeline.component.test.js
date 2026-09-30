import assert from 'node:assert/strict';
import test from 'node:test';

import { compilePipelineView } from './helpers/pipeline-view.js';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

const PREFIX = '__routesEditorPipeline';

test('RE-H1-04: графический scope ворот не попадает в API решения', async (t) => {
  const browser = await installUiBrowser(t, 'http://cockpit.test/#/pipeline');
  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  const graph = {
    daemonAlive: true, route: 'quick', readOnly: false,
    nodes: { 'r:quick:gate_accept': ['human', 'Приёмка'],
      'r:quick:stop:done': ['code', 'Завершено'] },
    pos: { 'r:quick:gate_accept': [140, 55], 'r:quick:stop:done': [480, 55] },
    edges: [['r:quick:gate_accept', 'r:quick:stop:done', 'approved', 'plain', 'h']],
    keys: { 'r:quick:gate_accept': 'GATE_ACCEPT' },
    statuses: { 'r:quick:gate_accept': 'wait', 'r:quick:stop:done': 'pending' },
    nodeOrigins: {
      'r:quick:gate_accept': { scope: 'route', originId: 'gate_accept', executable: true },
      'r:quick:stop:done': { scope: 'synthetic', originId: null, executable: false },
    },
    nodeMeta: { 'r:quick:gate_accept': {} },
    progress: { done: 0, total: 1, current: 'r:quick:gate_accept' },
  };
  const task = { task: 42, profile: 'sample', route: 'quick', readOnly: false,
    daemonAlive: true, attempt: 'synthetic-attempt', result: null, stall: null };
  const posts = [];
  globalThis[`${PREFIX}Api`] = {
    async get(url) {
      if (url === '/api/tasks') return { tasks: [task] };
      if (url === '/api/tasks/42/graph') return graph;
      if (url === '/api/factory/runners') return { runners: ['claude'] };
      if (url.startsWith('/api/tasks/42/findings?')) {
        return {
          profile: task.profile,
          attemptId: task.attempt,
          findings: { deferred: [] },
        };
      }
      return {};
    },
    async post(url, body) { posts.push([url, body]); return { ok: true, resumed: true }; },
  };
  globalThis[`${PREFIX}ConfirmDialog`] = async () => true;
  globalThis[`${PREFIX}AlertDialog`] = async () => {};
  globalThis[`${PREFIX}FactoryGraph`] = {
    name: 'FactoryGraph', props: ['graph', 'loopsOn'], emits: ['node'],
    template: '<div class="fg-stub"></div>',
  };
  globalThis[`${PREFIX}UiStore`] = defineStore('routes-editor-h1-ui', {
    actions: { openTask() {} },
  });
  globalThis[`${PREFIX}TasksStore`] = defineStore('routes-editor-h1-tasks', {
    actions: { async load() { return {}; }, title() { return null; },
      async setStageRunner() { return { ok: true }; } },
  });
  globalThis[`${PREFIX}BoardStore`] = defineStore('routes-editor-h1-board', {
    state: () => ({ data: null }), actions: { async load() {} },
  });
  const wrapper = mount(await compilePipelineView(PREFIX), {
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()], stubs: { teleport: true } },
  });
  t.after(() => {
    wrapper.unmount();
    for (const suffix of ['Api', 'ConfirmDialog', 'AlertDialog', 'FactoryGraph',
      'UiStore', 'TasksStore', 'BoardStore']) delete globalThis[`${PREFIX}${suffix}`];
  });
  await flushPromises();
  const emitNode = async (id, label) => {
    wrapper.findComponent(globalThis[`${PREFIX}FactoryGraph`]).vm.$emit('node', {
      id, label, subtitle: '', status: 'wait',
    });
    await flushPromises();
  };
  await emitNode('r:quick:stop:done', 'Завершено');
  assert.equal(wrapper.find('.smodal').exists(), false);
  await emitNode('r:quick:gate_accept', 'Приёмка');
  assert.equal(wrapper.find('.gate-sect').exists(), true);
  await wrapper.get('.gate-sect .btn.good').trigger('click');
  await flushPromises();
  assert.deepEqual(posts, [['/api/tasks/42/gate/GATE_ACCEPT/approve', {
    comment: '',
    profile: task.profile,
    attempt: task.attempt,
  }]]);
});

test('RE-H1-04: synthetic stop и status не получают кнопку запуска на SVG', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, component] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/views/pipeline/FactoryGraph.vue')),
  ]);
  const wrapper = mount(component, { attachTo: browser.document.querySelector('#mount'),
    props: { graph: {
      pos: { gate_accept: [140, 55], 'r:quick:stop:done': [480, 55] },
      nodes: { gate_accept: ['human', 'Приёмка'],
        'r:quick:stop:done': ['code', 'Завершено'] },
      edges: [['gate_accept', 'r:quick:stop:done', 'approved', 'plain', 'h']],
      nodeOrigins: { gate_accept: { scope: 'route', originId: 'gate_accept', executable: true },
        'r:quick:stop:done': { scope: 'synthetic', originId: null, executable: false } },
    } } });
  t.after(() => wrapper.unmount());
  assert.equal(wrapper.get('[data-node="gate_accept"]').attributes('role'), 'button');
  assert.equal(wrapper.get('[data-node="r:quick:stop:done"]').attributes('role'), undefined);
  await wrapper.get('[data-node="r:quick:stop:done"]').trigger('click');
  assert.equal(wrapper.emitted('node'), undefined);
});
