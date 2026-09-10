import assert from 'node:assert/strict';
import test from 'node:test';

import { graphForRoute } from '../../server/src/lib/factoryGraph.ts';

// Профиль на route-v2 держит nodes/routes в graph.json только ради read-only показа старых
// реестров, а после чистки не держит вовсе. Исторический реестр (без CATALOG_PROTOCOL) такого
// профиля всё равно ведёт в legacy-ветку — ответ должен называть причину, а не спотыкаться
// внутри на undefined: сообщение уезжает человеку в UI как есть.
test('graph for a route that has no legacy markup names the reason', () => {
  const v2Shaped = { capabilities: ['route-v2'], default_route: 'feature' };
  assert.throws(() => graphForRoute(v2Shaped, 'feature'), (err) => {
    assert.match(err.message, /нет разметки маршрута «feature»/);
    assert.match(err.message, /route-v2/);
    return true;
  });
});

test('graph for an unknown route lists the routes the file does have', () => {
  const graph = {
    default_route: 'gone',
    routes: { debug: { pos: { plan: [0, 0] }, edges: [] } },
  };
  assert.throws(() => graphForRoute(graph, 'quick'), (err) => {
    assert.match(err.message, /есть только debug/);
    return true;
  });
});

// Существующий маршрут по-прежнему собирается, в том числе через default_route.
test('graph still falls back to default_route', () => {
  const graph = {
    default_route: 'debug',
    routes: { debug: { vb: '0 0 1 1', pos: { plan: [0, 0] }, edges: [] } },
  };
  assert.deepEqual(graphForRoute(graph, 'quick').pos, { plan: [0, 0] });
});
