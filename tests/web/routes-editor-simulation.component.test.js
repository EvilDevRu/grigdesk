import assert from 'node:assert/strict';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

test('RE-G3-05: действия сценария хранят cursor в store и останавливаются на 200 шагах',
  async (t) => {
    await installUiBrowser(t, 'http://cockpit.test/#/routes');
    const { createPinia, setActivePinia } = await import(
      '../../web/node_modules/pinia/dist/pinia.mjs'
    );
    const actions = await compileModule(webFile('src/actions/routes/index.ts'));
    assert.equal(typeof actions.startRouteSimulation, 'function');
    assert.equal(typeof actions.stepRouteSimulation, 'function');
    setActivePinia(createPinia());
    const store = actions.useRoutesStore();
    const draft = makeDraft();
    store.opened = { profile: 'sample', draftId: draft.id, readOnly: false };
    store.serverSnapshot = structuredClone(draft);
    store.localDocument = structuredClone(draft);
    const calls = [];
    actions.configureRoutesRuntime(store, { api: {
      stepDraftSimulation: async (_profile, _draftId, input) => {
        calls.push(input);
        return { draftRevision: 1, ok: true, action: { next: 'check' },
          cursor: { ...input.cursor, nodeId: 'check' }, counters: input.counters,
          reset: [], stop: null, escalation: null, requiresHuman: false, issues: [] };
      },
    } });
    actions.startRouteSimulation('route', 'quick', false);
    assert.equal(store.simulation.cursor.nodeId, 'build');
    await actions.stepRouteSimulation({ outcome: 'done', failureOwner: null,
      selectedRouteId: null, humanApproved: false });
    assert.equal(store.simulation.cursor.nodeId, 'check');
    assert.equal(store.simulation.stepIndex, 2);
    assert.equal(calls.length, 1);
    store.simulation.stepIndex = 201;
    await actions.stepRouteSimulation({ outcome: 'done', failureOwner: null,
      selectedRouteId: null, humanApproved: false });
    assert.equal(calls.length, 1);
    assert.match(store.simulation.error, /200/);
  });

test('RE-G3-03: экран показывает запрос решения человека и блокирует терминальный шаг',
  async (t) => {
    const browser = await installUiBrowser(t, 'http://cockpit.test/#/routes');
    const Component = await compileVue(webFile('src/views/routes/RouteSimulation.vue'));
    const { mount } = await import(
      '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
    );
    const draft = makeDraft();
    const simulation = {
      cursor: { scope: 'bootstrap', routeId: null, nodeId: 'scout', terminal: false },
      counters: { noResult: {}, productFailure: {}, rewinds: {} },
      draftRevision: 1, generation: 0, stepIndex: 2, pinned: true,
      busy: false, error: '', stale: false,
      pendingHuman: { outcome: 'done', failureOwner: null,
        selectedRouteId: 'quick', humanApproved: false },
      last: { draftRevision: 1, ok: true, action: { escalate: { routes: ['quick'] } },
        cursor: { scope: 'bootstrap', routeId: null, nodeId: 'scout', terminal: false },
        counters: { noResult: {}, productFailure: {}, rewinds: {} },
        reset: [], stop: null, escalation: ['quick'], requiresHuman: true, issues: [] },
    };
    const wrapper = mount(Component, {
      attachTo: browser.document.querySelector('#mount'),
      props: { document: draft, simulation },
    });
    t.after(() => wrapper.unmount());
    assert.match(wrapper.text(), /решени[ея] человека/i);
    await wrapper.find('[data-test="simulation-approve"]').trigger('click');
    assert.equal(wrapper.emitted('approve')?.length, 1);
    await wrapper.setProps({ simulation: { ...simulation, pendingHuman: null, last: null } });
    assert.equal(wrapper.find('[data-test="simulation-step"]').attributes('disabled') !== undefined,
      true);
    await wrapper.find('[data-test="simulation-route"]').setValue('quick');
    assert.equal(wrapper.find('[data-test="simulation-step"]').attributes('disabled'), undefined);
    await wrapper.setProps({ simulation: {
      ...simulation, cursor: { ...simulation.cursor, terminal: true }, pendingHuman: null,
    } });
    assert.equal(wrapper.find('[data-test="simulation-step"]').attributes('disabled') !== undefined,
      true);
  });
