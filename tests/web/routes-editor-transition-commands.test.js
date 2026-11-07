import assert from 'node:assert/strict';
import test from 'node:test';

import { makeAgentNode, makeDraft } from '../fixtures/routes-editor.mjs';
import { projectRouteMachine } from '../../shared/pipeline/routeProjection.ts';
import { compileModule, webFile } from './helpers/compile-vue.js';

process.env.NODE_ENV = 'test';

const commands = await compileModule(webFile('src/views/routes/routeCommands.ts'));
const scope = { kind: 'route', routeId: 'quick' };

test('RE-F3-01: rewind вычисляет непрерывный reset и пересчитывает после вставки этапа', () => {
  const first = makeDraft();
  const result = commands.setTransition(first, scope, 'gate_accept', 'rejected',
    { rewind: 'build', reset: [] });
  assert.deepEqual(result.draft.routes.quick.route.nodes.find((node) => node.id === 'gate_accept')
    .on.rejected, { rewind: 'build', reset: ['build', 'check', 'gate_accept'] });
  const inserted = makeDraft();
  inserted.routes.quick.route.nodes.push(makeAgentNode({ id: 'review' }));
  inserted.routes.quick.route.sequence.main = ['build', 'check', 'review', 'gate_accept'];
  const withReview = commands.setTransition(inserted, scope, 'gate_accept', 'rejected',
    { rewind: 'build', reset: ['build', 'gate_accept'] });
  assert.deepEqual(withReview.draft.routes.quick.route.nodes.find((node) => node.id === 'gate_accept')
    .on.rejected.reset, ['build', 'check', 'review', 'gate_accept']);
  assert.deepEqual(first, makeDraft());
});

test('RE-F3-02: перемещение меняет порядок/фазу, показывает неверный next, координаты сохраняет',
  () => {
    const original = makeDraft();
    original.presentation['route:quick:check'] = { x: 123, y: 456 };
    const beforePresentation = structuredClone(original.presentation);
    const result = commands.moveStage(original, scope, 'check', 'tail', 0);
    const machine = result.draft.routes.quick.route;
    assert.deepEqual(machine.sequence.main, ['build', 'gate_accept']);
    assert.deepEqual(machine.sequence.tail, ['check']);
    assert.equal(machine.nodes.find((node) => node.id === 'check').phase, 'tail');
    assert.deepEqual(machine.nodes.find((node) => node.id === 'check').on.done,
      { next: 'gate_accept' });
    assert.ok(result.issues.some((issue) => issue.code === 'next_backwards'
      && issue.path?.includes('check.on.done')));
    assert.deepEqual(machine.nodes.find((node) => node.id === 'gate_accept').on.rejected.reset,
      ['build', 'gate_accept']);
    assert.deepEqual(result.draft.presentation, beforePresentation);
    assert.deepEqual(original.presentation, beforePresentation);
  });

test('RE-F3-03: исход хранит одно действие, stop human/done различны, onFailure полон', () => {
  const original = makeDraft();
  const invalid = commands.setTransition(original, scope, 'build', 'failed',
    { next: 'check', stop: 'done' });
  assert.equal(invalid.draft, original);
  assert.ok(invalid.issues.some((issue) => issue.code === 'transition_action_invalid'));
  const human = commands.setTransition(original, scope, 'build', 'failed', { stop: 'human' });
  const done = commands.setTransition(original, scope, 'build', 'failed', { stop: 'done' });
  assert.deepEqual(human.draft.routes.quick.route.nodes[0].on.failed, { stop: 'human' });
  assert.deepEqual(done.draft.routes.quick.route.nodes[0].on.failed, { stop: 'done' });
  const enabled = commands.setFailureRoutes(original, scope, 'build', true);
  assert.deepEqual(enabled.draft.routes.quick.route.nodes[0].onFailure, {
    build: null, tests: null, environment: null, plan: null, human: null,
  });
  const one = commands.setTransition(enabled.draft, scope, 'build', 'tests',
    { stop: 'failed' }, 'onFailure');
  assert.deepEqual(one.draft.routes.quick.route.nodes[0].onFailure, {
    build: null, tests: { stop: 'failed' }, environment: null, plan: null, human: null,
  });
});

test('RE-F3-04: escalation ограничен allowedRoutes и сохраняет human-правило; status не цель',
  () => {
    const original = makeDraft();
    original.routes.audit = structuredClone(original.routes.quick);
    original.routes.audit.route.id = 'audit';
    const bootstrap = { kind: 'bootstrap' };
    const configured = commands.setEscalation(original, bootstrap, 'scout', ['audit'], true);
    assert.deepEqual(configured.draft.bootstrap.escalation, [{ from: 'scout',
      allowedRoutes: ['audit'], requiresHumanWhenPinned: true }]);
    const bad = commands.setTransition(configured.draft, bootstrap, 'scout', 'done',
      { escalate: { routes: ['quick'] } });
    assert.equal(bad.draft, configured.draft);
    assert.ok(bad.issues.some((issue) => issue.code === 'escalation_route_unavailable'));
    const good = commands.setTransition(configured.draft, bootstrap, 'scout', 'done',
      { escalate: { routes: ['audit'] } });
    assert.deepEqual(good.draft.bootstrap.nodes[0].on.done,
      { escalate: { routes: ['audit'] } });
    assert.equal(good.draft.bootstrap.escalation[0].requiresHumanWhenPinned, true);
    const status = commands.setTransition(original, scope, 'build', 'done',
      { next: 'check_status' });
    assert.equal(status.draft, original);
    assert.ok(status.issues.some((issue) => issue.code === 'status_target'));
  });

test('RE-F3-05: null-исход хранится как незавершённая связь и рисуется проблемой', () => {
  const original = makeDraft();
  const result = commands.setTransition(original, scope, 'build', 'done', null);
  assert.equal(result.draft.routes.quick.route.nodes.find((node) => node.id === 'build').on.done,
    null);
  const graph = projectRouteMachine(result.draft.routes.quick.route,
    { scope: 'route', routeId: 'quick' });
  assert.ok(graph.issues.some((issue) => issue.code === 'transition_required'
    && issue.nodeId === 'build' && issue.path.endsWith('/on/done')));
  assert.equal(graph.edges.some((edge) => edge.source === 'r:quick:build'
    && edge.outcome === 'done'), false);
  assert.deepEqual(original, makeDraft());
});
