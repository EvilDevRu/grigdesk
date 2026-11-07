import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildRouteDef } from '../../server/src/lib/routeGraph.ts';
import { FactoryStateAdapter } from '../../server/src/adapters/factoryState.ts';
import routesApi from '../../server/src/modules/routes/api.ts';
import { RoutesStore } from '../../server/src/modules/routes/store.ts';
import { makeCatalogInput } from '../fixtures/routes-editor.mjs';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = requireFromServer('fastify');

test('RE-H1-01/03: схема конвейера содержит точные исходы, stop, status и владельцев отказа', () => {
  const fixture = makeCatalogInput();
  const machine = fixture.routes.quick.route;
  machine.nodes.find((node) => node.id === 'check').onFailure = {
    build: { rewind: 'build', reset: ['build', 'check'] },
    tests: { stop: 'failed' },
  };
  const graph = buildRouteDef(machine, 'quick', {
    bootstrap: fixture.bootstrap, workspaceMode: 'shared',
  });
  const execution = graph.transitions.filter((edge) => edge.kind === 'execution');
  assert.ok(execution.some((edge) => edge.source === 'build'
    && edge.target === 'gate_accept' && edge.outcome === 'skipped'));
  assert.ok(execution.some((edge) => edge.source === 'check'
    && edge.channel === 'onFailure' && edge.outcome === 'build'
    && edge.action === 'rewind'));
  assert.ok(execution.some((edge) => edge.source === 'gate_accept'
    && edge.action === 'stop' && edge.outcome === 'approved'));
  assert.ok(graph.transitions.some((edge) => edge.source === 'check'
    && edge.target === 'check_status' && edge.kind === 'emits'));
  assert.ok(graph.transitions.some((edge) => edge.source === 'scout'
    && edge.target === 'build' && edge.action === 'escalate'));
  // Выдуманного next нет: каждая линия между этапами опирается на переход машины.
  const drawn = graph.edges.filter(([from, to]) => from !== '_start'
    && from !== 'sandbox' && to !== 'sandbox');
  assert.ok(drawn.length > 0);
  for (const [from, to] of drawn) {
    assert.ok(execution.some((edge) => edge.source === from && edge.target === to),
      `${from} → ${to} нарисован без перехода`);
  }
  assert.equal(graph.nodeOrigins['check_status']?.executable, false);
  assert.equal(graph.nodeOrigins['r:quick:stop:done']?.executable, false);
});

test('RE-H1-03: змейка рисует только этапы, остановки и status остаются в данных', () => {
  const fixture = makeCatalogInput();
  const scout = fixture.bootstrap.nodes[0];
  scout.on.done = { escalate: { routes: ['quick', 'audit', 'deep'] } };
  const graph = buildRouteDef(fixture.routes.quick.route, 'quick', {
    bootstrap: fixture.bootstrap,
  });

  assert.deepEqual(Object.keys(graph.pos), ['scout', 'build', 'check', 'gate_accept', 'sandbox']);
  for (const id of Object.keys(graph.pos)) {
    assert.equal(graph.nodeOrigins[id]?.executable, id !== 'sandbox', id);
  }
  // Чужие маршруты разведки и остановки описаны, но линий в змейке к ним нет.
  assert.equal(graph.nodeOrigins['catalog:route:audit']?.scope, 'synthetic');
  assert.ok(graph.transitions.some((edge) => edge.target === 'catalog:route:deep'));
  assert.equal(graph.edges.some(([, to]) => !(to in graph.pos)), false);
  assert.deepEqual(graph.edges.filter(([from]) => from === 'scout').map(([, to, label]) => [to, label]),
    [['build', '']]);
});

test('RE-H1-04: ответ схемы задачи несёт происхождение узлов змейки', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-graph-origins-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const profilesDir = path.join(root, 'profiles');
  await fs.mkdir(path.join(stateDir, 'logs'), { recursive: true });
  await fs.mkdir(path.join(profilesDir, 'sample'), { recursive: true });
  await fs.writeFile(path.join(stateDir, 't49.pipeline'), [
    'PROFILE=sample',
    'ROUTE=quick',
    'CATALOG_PROTOCOL=route-v2',
    'ATTEMPT_ID=a_0123456789abcdef0123456789abcdef',
    `ROUTE_HASH=${'a'.repeat(64)}`,
    'WF_STATUS=running',
    'SCOUT=done',
    'BUILD=running',
    '',
  ].join('\n'));
  const fixture = makeCatalogInput();
  const def = buildRouteDef(fixture.routes.quick.route, 'quick', { bootstrap: fixture.bootstrap });
  const adapter = new FactoryStateAdapter({ stateDir, profilesDir });
  adapter.isDaemonAlive = () => false;
  adapter.routeDef = async () => def;
  adapter.readTrustedAttempt = async () => ({
    profile: 'sample',
    attempt: 'a_0123456789abcdef0123456789abcdef',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    workspaceMode: 'isolated',
  });

  const graph = await adapter.getTaskGraph('49');

  assert.deepEqual(Object.keys(graph.nodeOrigins).sort(), Object.keys(graph.pos).sort());
  assert.equal(graph.nodeOrigins.sandbox.executable, false);
  assert.equal(graph.nodeOrigins.scout.scope, 'bootstrap');
  assert.equal(graph.nodeOrigins.build.originId, 'build');
  assert.equal(Object.keys(graph.statuses).some((id) => id.includes(':')), false);
});

test('RE-H1-02: граф точного catalogHash читает его bootstrap, не current', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grigdesk-graph-catalog-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new RoutesStore({ baseDir: path.join(root, 'routes') });
  const fixture = makeCatalogInput();
  const { routeHash } = await store.publishRoute('sample', 'quick', fixture.routes.quick);
  const catalog = { schema: 2, profile: 'sample', routes: { quick: routeHash },
    bootstrap: { file: 'bootstrap/scout.json' } };
  fixture.bootstrap.nodes[0].label = 'Разведка V1';
  const v1 = await store.publishCatalog('sample', {
    catalog, bootstrap: fixture.bootstrap, prompts: fixture.bootstrapPrompts,
  }, { expectedCatalogHash: null });
  fixture.bootstrap.nodes[0].label = 'Разведка V2';
  const v2 = await store.publishCatalog('sample', {
    catalog, bootstrap: fixture.bootstrap, prompts: fixture.bootstrapPrompts,
  }, { expectedCatalogHash: v1.catalogHash });
  assert.notEqual(v1.catalogHash, v2.catalogHash);
  const app = Fastify({ logger: false });
  await app.register(routesApi, { store });
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET',
    url: `/api/routes/sample/catalog/${v1.catalogHash}/graph?route=quick` });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().graph.nodes.scout[1], 'Разведка V1');
  assert.equal(response.json().graph.transitions.some((edge) =>
    edge.source === 'scout' && edge.target === 'build' && edge.action === 'escalate'), true);
  const adapter = new FactoryStateAdapter({ stateDir: path.join(root, 'state'),
    profilesDir: path.join(root, 'profiles'), routesDir: path.join(root, 'routes') });
  const pinned = await adapter.routeDef({ CATALOG_PROTOCOL: 'route-v2',
    PROFILE: 'sample', ROUTE: 'quick', ATTEMPT_ID: `a_${'1'.repeat(32)}`,
    ROUTE_HASH: routeHash, CATALOG_HASH: v1.catalogHash }, { workspaceMode: 'shared' });
  assert.equal(pinned.nodes.scout[1], 'Разведка V1');
  assert.deepEqual(pinned.transitions, response.json().graph.transitions);
  const mismatched = await app.inject({ method: 'GET',
    url: `/api/routes/sample/routes/quick/${'a'.repeat(64)}/graph?c=${v1.catalogHash}` });
  assert.equal(mismatched.statusCode, 400);
  await assert.rejects(() => adapter.routeDef({ CATALOG_PROTOCOL: 'route-v2',
    PROFILE: 'sample', ROUTE: 'quick', ATTEMPT_ID: `a_${'1'.repeat(32)}`,
    ROUTE_HASH: 'a'.repeat(64), CATALOG_HASH: v1.catalogHash }),
  /закреплённый маршрут недоступен|не входит/);
});
