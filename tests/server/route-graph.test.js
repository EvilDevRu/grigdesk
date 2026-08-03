import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRouteDef } from '../../server/src/lib/route-graph.js';

const stop = { stop: 'human' };

const machine = {
  entry: 'hunt_access',
  sequence: {
    main: ['hunt_access', 'verify', 'triage', 'gate_accept'],
    tail: ['retro'],
  },
  nodes: [
    {
      id: 'hunt_access',
      executor: 'agent',
      runKey: 'HUNT_ACCESS',
      label: 'Доступ',
      policy: { filesystem: 'state-only' },
      on: {
        done: { next: 'verify' },
        skipped: { next: 'verify' },
        failed: stop,
        exhausted: stop,
      },
    },
    {
      id: 'verify',
      executor: 'agent',
      runKey: 'VERIFY',
      label: 'Проверка',
      policy: { filesystem: 'state-only' },
      on: {
        done: { next: 'triage' },
        skipped: stop,
        failed: stop,
        exhausted: stop,
      },
    },
    {
      id: 'triage',
      executor: 'agent',
      runKey: 'TRIAGE',
      label: 'Отчёт',
      policy: { filesystem: 'state-only' },
      on: {
        done: { next: 'gate_accept' },
        skipped: stop,
        failed: stop,
        exhausted: stop,
      },
    },
    {
      id: 'gate_accept',
      executor: 'gate',
      runKey: 'GATE_ACCEPT',
      label: 'Приёмка поиска',
      on: {
        approved: { next: 'retro' },
        rejected: { rewind: 'triage', reset: ['triage', 'gate_accept'] },
      },
    },
    {
      id: 'retro',
      executor: 'agent',
      runKey: 'RETRO',
      label: 'Ретро',
      policy: { filesystem: 'state-only' },
      on: {
        done: { stop: 'done' },
        skipped: { stop: 'done' },
        failed: stop,
        exhausted: stop,
      },
    },
  ],
};

test('route graph derives optional nodes from non-stop skipped transitions', () => {
  const graph = buildRouteDef(machine, 'hunt');

  assert.deepEqual(graph.optional, ['hunt_access']);
  assert.equal(graph.nodes.hunt_access[1], 'Доступ');
  assert.equal(graph.nodes.ship, undefined);
  assert.ok(graph.edges.some((edge) => (
    edge[0] === 'gate_accept'
    && edge[1] === 'triage'
    && edge[2] === '✗ rejected'
    && edge[3] === 'fail'
  )));
});

test('route graph omits the sandbox diamond for shared workspace mode', () => {
  const shared = buildRouteDef(machine, 'hunt', { workspaceMode: 'shared' });
  assert.equal(shared.nodes.sandbox, undefined);
  assert.equal('sandbox' in shared.pos, false);
  assert.ok(!shared.edges.some((edge) => edge[0] === 'sandbox' || edge[1] === 'sandbox'));

  // Без режима (isolated и исторические прогоны) ромб остаётся как был.
  const isolated = buildRouteDef(machine, 'hunt');
  assert.ok(isolated.nodes.sandbox);
  assert.ok(isolated.edges.some((edge) => edge[0] === 'sandbox' && edge[3] === 'plain'));
  assert.ok(isolated.edges.some((edge) => edge[1] === 'sandbox' && edge[4] === 'to_sandbox'));
});

test('route graph renders typed failure-owner rewinds explicitly', () => {
  const withOwners = structuredClone(machine);
  const verify = withOwners.nodes.find((node) => node.id === 'verify');
  verify.onFailure = {
    build: { rewind: 'hunt_access', reset: ['hunt_access', 'verify'] },
    tests: stop,
    environment: stop,
    plan: stop,
    human: stop,
  };

  const graph = buildRouteDef(withOwners, 'hunt');
  assert.ok(graph.edges.some((edge) => (
    edge[0] === 'verify'
    && edge[1] === 'hunt_access'
    && edge[2] === '✗ failed:build'
    && edge[3] === 'fail'
  )));
});
