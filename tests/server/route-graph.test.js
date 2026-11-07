import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRouteDef } from '../../server/src/lib/routeGraph.ts';

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

test('маршрут без разведки показывает вход в проверяющего и не добавляет SCOUT', () => {
  const direct = structuredClone(machine);
  direct.bootstrap = 'skip';
  direct.entry = 'verify';
  const graph = buildRouteDef(direct, 'hunt', { workspaceMode: 'shared' });

  assert.equal(graph.nodes.scout, undefined);
  assert.equal(graph.keys.scout, undefined);
  assert.equal(graph.runnerKeys.scout, undefined);
  assert.ok(graph.edges.some(([from, to]) => from === '_start' && to === 'verify'));
  assert.ok(!graph.edges.some(([from, to]) => from === 'scout' || to === 'scout'));

  const isolated = buildRouteDef(direct, 'hunt');
  assert.ok(isolated.edges.some(([from, to]) => from === 'sandbox' && to === 'verify'));
});

test('разведка при явном входе ведёт к entry, а не к первому узлу раскладки', () => {
  const graph = buildRouteDef({ ...machine, entry: 'verify' }, 'hunt', {
    bootstrap: {
      entry: 'scout', sequence: { bootstrap: ['scout'] },
      nodes: [{ id: 'scout', executor: 'agent', runKey: 'SCOUT',
        on: { done: { escalate: { routes: ['hunt'] } } } }],
    },
  });

  assert.ok(graph.nodes.scout);
  assert.ok(graph.edges.some(([from, to]) => from === 'scout' && to === 'verify'));
  assert.ok(!graph.edges.some(([from, to]) => from === 'scout' && to === 'hunt_access'));
  const routeOnly = buildRouteDef({ ...machine, entry: 'verify' }, 'hunt');
  assert.equal(routeOnly.nodes.scout, undefined);
});

// Цепочка из восьми этапов: шесть в первом ряду змейки, два во втором.
function chain(ids, extra = {}) {
  return {
    entry: ids[0],
    sequence: { main: ids, tail: [] },
    nodes: ids.map((id, index) => ({
      id,
      executor: 'agent',
      runKey: id.toUpperCase(),
      label: id,
      on: {
        done: index + 1 < ids.length ? { next: ids[index + 1] } : { stop: 'done' },
        skipped: stop,
        failed: stop,
        exhausted: stop,
        ...extra[id],
      },
    })),
  };
}

test('исходы одной пары склеены в одну линию, штатный ход вперёд не подписан', () => {
  const graph = buildRouteDef(chain(['a', 'b', 'c'], {
    a: { skipped: { next: 'b' }, exhausted: { next: 'c' } },
    b: { failed: { rewind: 'a', reset: ['a', 'b'] } },
  }), 'demo', { workspaceMode: 'shared' });
  const between = (from, to) => graph.edges.filter(([source, target]) => (
    source === from && target === to
  ));

  assert.deepEqual(between('a', 'b').map(([, , label, kind]) => [label, kind]), [['', 'plain']]);
  assert.deepEqual(between('a', 'c').map(([, , label, kind]) => [label, kind]),
    [['exhausted', 'plain']]);
  assert.deepEqual(between('b', 'a').map(([, , label, kind]) => [label, kind]),
    [['✗ failed', 'fail']]);
  // Все исходы при этом остаются в данных проекции.
  assert.deepEqual(graph.transitions.filter((edge) => edge.source === 'a' && edge.target === 'b')
    .map((edge) => edge.outcome).sort(), ['done', 'skipped']);
});

test('возвраты одной пары с разными владельцами отказа идут одной подписанной дугой', () => {
  const machine = chain(['a', 'b'], {
    b: { failed: { rewind: 'a', reset: ['a', 'b'] } },
  });
  machine.nodes[1].onFailure = {
    build: stop,
    tests: { rewind: 'a', reset: ['a', 'b'] },
    environment: stop,
    plan: stop,
    human: stop,
  };
  const graph = buildRouteDef(machine, 'demo', { workspaceMode: 'shared' });

  assert.deepEqual(graph.edges.filter(([from, to]) => from === 'b' && to === 'a')
    .map(([, , label]) => label), ['✗ failed · failed:tests']);
});

test('соседство в sequence не рисует линию без перехода', () => {
  const graph = buildRouteDef(chain(['a', 'b', 'c'], {
    a: { done: { next: 'c' } },
  }), 'demo', { workspaceMode: 'shared' });

  assert.equal(graph.edges.some(([from, to]) => from === 'a' && to === 'b'), false);
  assert.ok(graph.edges.some(([from, to, label, , routing]) => (
    from === 'a' && to === 'c' && label === '' && routing === 'arc_up'
  )));
});

test('стык рядов идёт вертикалью, возврат дугой над первым рядом и под остальными', () => {
  const ids = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
  const graph = buildRouteDef(chain(ids, {
    s3: { failed: { rewind: 's1', reset: ['s1', 's2', 's3'] } },
    s8: { failed: { rewind: 's7', reset: ['s7', 's8'] } },
  }), 'demo', { workspaceMode: 'shared' });
  const routing = (from, to) => graph.edges.find(([source, target]) => (
    source === from && target === to
  ))?.[4];

  assert.equal(routing('s5', 's6'), 'h');
  assert.equal(routing('s6', 's7'), 'v');
  assert.equal(routing('s3', 's1'), 'arc_up');
  assert.equal(routing('s8', 's7'), 'arc_down');
});

test('вход не первым этапом змейки обходит ряд дугой, а не идёт сквозь узел', () => {
  const machine = chain(['worker', 'reviewer'], {
    reviewer: { failed: { rewind: 'worker', reset: ['worker', 'reviewer'] } },
  });
  machine.entry = 'reviewer';
  machine.bootstrap = 'skip';
  const graph = buildRouteDef(machine, 'pair', { workspaceMode: 'shared' });

  assert.deepEqual(graph.edges[0], ['_start', 'reviewer', '', 'plain', 'arc_up']);
});

test('незаконченный черновик не рисует линий к ненарисованным узлам', () => {
  const broken = chain(['a', 'b']);
  broken.entry = 'ghost';
  broken.sequence.main = ['ghost', 'a', 'b'];
  const empty = { entry: null, sequence: { main: [], tail: [] }, nodes: [] };

  for (const graph of [buildRouteDef(broken, 'draft'), buildRouteDef(empty, 'draft')]) {
    for (const [from, to] of graph.edges) {
      assert.ok(from === '_start' || from in graph.pos, `${from} → ${to}`);
      assert.ok(to in graph.pos, `${from} → ${to}`);
    }
  }
  // Сами этапы при этом на схеме остаются: исправлять вход человеку есть на чём.
  assert.deepEqual(Object.keys(buildRouteDef(broken, 'draft').pos), ['a', 'b', 'sandbox']);
});
