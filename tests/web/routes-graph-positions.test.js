import assert from 'node:assert/strict';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { buildRouteGraph } from '../../shared/pipeline/routeGraphView.ts';

process.env.NODE_ENV = 'test';

test('RE-G2-01: ручные позиции переопределяют змейку только для известных узлов', () => {
  const draft = makeDraft();
  const source = draft.routes.quick.route;
  const machine = {
    entry: source.entry,
    loop: null,
    sequence: { main: source.sequence.main ?? [], tail: [] },
    nodes: source.nodes,
  };
  const graph = buildRouteGraph(machine, 'quick', {
    workspaceMode: 'shared',
    positions: { build: [900, 40], ghost: [1, 2] },
  });

  const displayOf = (originId) => Object.entries(graph.nodeOrigins)
    .find(([, value]) => value.originId === originId)?.[0];

  assert.deepEqual(graph.pos[displayOf('build')], [900, 40]);
  assert.equal(displayOf('ghost'), undefined);
  assert.notDeepEqual(graph.pos[displayOf('check')], [900, 40]);
  assert.ok(Number.isFinite(graph.pos[displayOf('check')][0]));
});
