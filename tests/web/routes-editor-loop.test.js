import assert from 'node:assert/strict';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { parseRouteDraft } from '../../shared/pipeline/routesContracts.ts';
import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

const commands = await compileModule(webFile('src/views/routes/routeCommands.ts'));
const scope = { kind: 'route', routeId: 'quick' };

// Черновик с парой режима «цикл»: build — исполнитель, check — ведущий. Смысл пары
// проверяет схема публикации; редактору важно не потерять и не оборвать ссылки.
function loopDraft() {
  const draft = makeDraft();
  draft.routes.quick.route.loop = { lead: 'check', worker: 'build' };
  return draft;
}

test('черновик сохраняет пару цикла без потерь', () => {
  const original = loopDraft();
  const parsed = parseRouteDraft(original);

  assert.deepEqual(parsed.routes.quick.route.loop, { lead: 'check', worker: 'build' });
});

test('пара цикла с лишним полем — ошибка формы черновика', () => {
  const draft = loopDraft();
  draft.routes.quick.route.loop.extra = 'x';

  assert.throws(() => parseRouteDraft(draft), /loop/);
});

test('переименование исполнителя переносит ссылку роли цикла', () => {
  const original = loopDraft();
  const snapshot = structuredClone(original);
  const result = commands.renameNode(original, scope, 'build', 'author');
  const machine = result.draft.routes.quick.route;

  assert.deepEqual(machine.loop, { lead: 'check', worker: 'author' });
  assert.deepEqual(original, snapshot);
});

test('удаление ведущего называет висячую связь роли цикла', () => {
  const result = commands.removeNodes(loopDraft(), scope, ['check']);
  const paths = result.issues
    .filter((issue) => issue.code === 'dangling_reference')
    .map((issue) => issue.path);

  assert.ok(paths.includes('loop.lead'));
});

// Пробный сценарий цикла: потолок кругов живёт в профиле, поэтому сценарий несёт свой и
// передаёт его в каждом шаге; предел шагов цикла вмещает потолок 300 (601 шаг).
async function simulationStore(t, draft) {
  await installUiBrowser(t, 'http://cockpit.test/#/routes');
  const { createPinia, setActivePinia } = await import(
    '../../web/node_modules/pinia/dist/pinia.mjs'
  );
  const actions = await compileModule(webFile('src/actions/routes/index.ts'));
  setActivePinia(createPinia());
  const store = actions.useRoutesStore();
  store.opened = { profile: 'sample', draftId: draft.id, readOnly: false };
  store.serverSnapshot = structuredClone(draft);
  store.localDocument = structuredClone(draft);
  const calls = [];
  actions.configureRoutesRuntime(store, { api: {
    stepDraftSimulation: async (_profile, _draftId, input) => {
      calls.push(input);
      return { draftRevision: 1, ok: true, action: { next: 'check' },
        cursor: input.cursor, counters: input.counters,
        reset: [], stop: null, escalation: null, requiresHuman: false, issues: [] };
    },
  } });
  return { actions, store, calls };
}

const observation = { outcome: 'done', failureOwner: null, selectedRouteId: null,
  humanApproved: false };

test('сценарий цикла передаёт выбранный потолок кругов в каждом шаге', async (t) => {
  const { actions, store, calls } = await simulationStore(t, loopDraft());

  actions.startRouteSimulation('route', 'quick', false, 7);
  assert.equal(store.simulation.loopMaxRounds, 7);
  await actions.stepRouteSimulation(observation);
  assert.equal(calls[0].loopMaxRounds, 7);

  store.simulation.stepIndex = 201;
  await actions.stepRouteSimulation(observation);
  assert.equal(calls.length, 2, 'двести первый шаг цикла разрешён');
  store.simulation.stepIndex = 1201;
  await actions.stepRouteSimulation(observation);
  assert.equal(calls.length, 2);
  assert.match(store.simulation.error, /1200/);
});

test('сценарий цикла без выбора берёт потолок 20, неверный потолок не стартует', async (t) => {
  const { actions, store } = await simulationStore(t, loopDraft());

  actions.startRouteSimulation('route', 'quick', false);
  assert.equal(store.simulation.loopMaxRounds, 20);
  store.simulation = null;
  actions.startRouteSimulation('route', 'quick', false, 301);
  assert.equal(store.simulation, null);
  assert.match(store.simulationError, /1 до 300/);
});

test('обычный маршрут не несёт потолка кругов, предел шагов прежний', async (t) => {
  const { actions, store, calls } = await simulationStore(t, makeDraft());

  actions.startRouteSimulation('route', 'quick', false, 7);
  assert.equal(store.simulation.loopMaxRounds, null);
  await actions.stepRouteSimulation(observation);
  assert.equal(Object.hasOwn(calls[0], 'loopMaxRounds'), false);
  store.simulation.stepIndex = 201;
  await actions.stepRouteSimulation(observation);
  assert.equal(calls.length, 1);
  assert.match(store.simulation.error, /200/);
});

test('панель сценария спрашивает потолок только у маршрута с циклом', async (t) => {
  const browser = await installUiBrowser(t, 'http://cockpit.test/#/routes');
  const Component = await compileVue(webFile('src/views/routes/RouteSimulation.vue'));
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const draft = loopDraft();
  draft.routes.plain = structuredClone(draft.routes.quick);
  delete draft.routes.plain.route.loop;
  const wrapper = mount(Component, {
    attachTo: browser.document.querySelector('#mount'),
    props: { document: draft, simulation: null },
  });
  t.after(() => wrapper.unmount());
  const field = () => wrapper.find('[data-test="simulation-loop-max-rounds"]');

  await wrapper.find('[data-test="simulation-start-target"]').setValue('plain');
  assert.equal(field().exists(), false);
  await wrapper.find('[data-test="simulation-start"]').trigger('click');
  assert.deepEqual(wrapper.emitted('start')?.[0], ['route', 'plain', false, null]);

  await wrapper.find('[data-test="simulation-start-target"]').setValue('quick');
  assert.equal(field().exists(), true);
  await field().setValue('3');
  await wrapper.find('[data-test="simulation-start"]').trigger('click');
  assert.deepEqual(wrapper.emitted('start')?.[1], ['route', 'quick', false, 3]);
});
