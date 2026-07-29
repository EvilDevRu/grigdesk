import assert from 'node:assert/strict';
import test from 'node:test';

import { graphForRoute } from '../../server/src/lib/factory-graph.js';

test('graph can map internal visual nodes to the canonical runner stage per route', () => {
  const graph = {
    default_route: 'feature',
    nodes: {},
    keys: { plan: 'PLANS' },
    runner_keys: {
      '*': { plan: 'PLAN' },
      feature: { skeptic: 'PLAN' },
      debug: { skeptic: 'SKEPTIC' },
    },
    routes: {
      feature: { pos: { plan: [0, 0], skeptic: [1, 0] }, edges: [] },
      debug: { pos: { skeptic: [1, 0] }, edges: [] },
    },
  };
  assert.deepEqual(graphForRoute(graph, 'feature').runnerKeys, {
    plan: 'PLAN',
    skeptic: 'PLAN',
  });
  assert.deepEqual(graphForRoute(graph, 'debug').runnerKeys, {
    skeptic: 'SKEPTIC',
  });
});
