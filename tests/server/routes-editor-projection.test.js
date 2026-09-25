import assert from 'node:assert/strict';
import test from 'node:test';

import { makeCatalogInput } from '../fixtures/routes-editor.mjs';
import { projectRouteMachine } from '../../shared/routeProjection.ts';

test('RE-A3-01: линия skipped строится по переходу, а не по соседству sequence', () => {
  const machine = makeCatalogInput().routes.quick.route;
  const graph = projectRouteMachine(machine, { scope: 'route', routeId: 'quick' });
  const skipped = graph.edges.find((edge) => (
    edge.source === 'r:quick:build' && edge.channel === 'on' && edge.outcome === 'skipped'
  ));

  assert.equal(skipped?.target, 'r:quick:gate_accept');
  assert.equal(graph.edges.some((edge) => (
    edge.source === 'r:quick:build' && edge.outcome === 'skipped' && edge.target === 'r:quick:check'
  )), false);
});

test('RE-A3-02: два исхода в одну цель остаются разными связями', () => {
  const machine = makeCatalogInput().routes.quick.route;
  machine.nodes[0].on.skipped = { next: 'check' };
  const graph = projectRouteMachine(machine, { scope: 'route', routeId: 'quick' });
  const edges = graph.edges.filter((edge) => (
    edge.source === 'r:quick:build' && edge.target === 'r:quick:check'
  ));

  assert.deepEqual(new Set(edges.map((edge) => edge.outcome)), new Set(['done', 'skipped']));
  assert.equal(new Set(edges.map((edge) => edge.id)).size, 2);
});

test('RE-A3-03: stop и все владельцы onFailure представлены явно', () => {
  const machine = makeCatalogInput().routes.quick.route;
  const check = machine.nodes.find((node) => node.id === 'check');
  check.onFailure = {
    build: { rewind: 'build', reset: ['build', 'check'] },
    tests: { stop: 'failed' },
    environment: { stop: 'human' },
    plan: { stop: 'human' },
    human: { stop: 'human' },
  };
  const graph = projectRouteMachine(machine, { scope: 'route', routeId: 'quick' });

  assert.deepEqual(new Set(graph.edges.filter((edge) => edge.action === 'stop').map((edge) => (
    edge.target
  ))), new Set(['r:quick:stop:failed', 'r:quick:stop:human', 'r:quick:stop:done']));
  assert.deepEqual(new Set(graph.edges.filter((edge) => edge.channel === 'onFailure').map((edge) => (
    edge.outcome
  ))), new Set(['build', 'tests', 'environment', 'plan', 'human']));
});

test('RE-A3-04: rewind несёт reset, status связан только как результат владельца', () => {
  const machine = makeCatalogInput().routes.quick.route;
  const graph = projectRouteMachine(machine, { scope: 'route', routeId: 'quick' });
  const rewind = graph.edges.find((edge) => (
    edge.source === 'r:quick:gate_accept' && edge.outcome === 'rejected'
  ));

  assert.equal(rewind?.action, 'rewind');
  assert.deepEqual(rewind?.reset, ['build', 'check', 'gate_accept']);
  assert.ok(graph.edges.some((edge) => (
    edge.kind === 'emits' && edge.source === 'r:quick:check'
      && edge.target === 'r:quick:check_status'
  )));
  assert.equal(graph.edges.some((edge) => (
    edge.kind === 'execution' && edge.target === 'r:quick:check_status'
  )), false);
});

test('RE-A3-05: null и недостающая цель дают диагностику без падения графа', () => {
  const machine = makeCatalogInput().routes.quick.route;
  machine.nodes[0].on.done = null;
  machine.nodes.find((node) => node.id === 'check').on.done = { next: 'missing' };

  const graph = projectRouteMachine(machine, { scope: 'route', routeId: 'quick' });

  assert.deepEqual(new Set(graph.issues.map((issue) => issue.code)), new Set([
    'transition_required',
    'transition_target_missing',
  ]));
  assert.ok(graph.issues.some((issue) => issue.path === '/routes/quick/route/nodes/0/on/done'));
  assert.ok(graph.nodes.some((node) => node.id === 'r:quick:missing:missing' && !node.editable));
});
