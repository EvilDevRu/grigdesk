import assert from 'node:assert/strict';
import {
  mkdir, mkdtemp, rm, stat, utimes, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FactoryStateAdapter } from '../../server/src/adapters/factory-state.js';

// Legacy-карточка читает движковую проекцию, route-v2 поверх неё использует
// длительности реально стартовавших runner-процессов текущей trusted attempt.
async function makeFixture(t, {
  workSec = '14400', gateWaitSec = '3600', lastEventSec = '1785243600',
  review = 'done', ship = 'waiting', alive = false,
  workTimeReader = null, trusted = false, routeV2 = false, runDurationSec = null,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-graph-timing-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const stateDir = path.join(root, 'state');
  const profilesDir = path.join(root, 'profiles');
  await mkdir(path.join(stateDir, 'logs'), { recursive: true });
  await mkdir(path.join(profilesDir, 'demo'), { recursive: true });
  await writeFile(path.join(profilesDir, 'demo', 'graph.json'), JSON.stringify({
    default_route: 'feature',
    nodes: {
      review: ['agent', '🤖 Ревью', ''],
      ship: ['human', '👤 Merge / Ship', ''],
    },
    keys: { review: 'REVIEW', ship: 'SHIP' },
    optional: {},
    routes: {
      feature: {
        pos: { review: [100, 50], ship: [300, 50] },
        edges: [['review', 'ship', '', 'plain', 'h']],
      },
    },
  }));
  const telemetry = workSec === null ? [] : [
    `WORK_TIME_S=${workSec}`,
    `GATE_WAIT_S=${gateWaitSec}`,
    `WORK_TIMER_SINCE=${lastEventSec}`,
  ];
  await writeFile(path.join(stateDir, 't7379.pipeline'), [
    'PROFILE=demo',
    'ROUTE=feature',
    ...(routeV2 ? [
      'CATALOG_PROTOCOL=route-v2',
      'ATTEMPT_ID=a_0123456789abcdef0123456789abcdef',
      `ROUTE_HASH=${'a'.repeat(64)}`,
    ] : []),
    'WF_STATUS=running',
    'ORCH_PID=12345',
    `REVIEW=${review}`,
    `SHIP=${ship}`,
    ...telemetry,
    '',
  ].join('\n'));

  const adapter = new FactoryStateAdapter({ stateDir, profilesDir, workTimeReader });
  adapter.isDaemonAlive = () => alive;
  if (routeV2) {
    adapter.routeDef = async () => ({
      nodes: { review: ['agent', '🤖 Ревью', ''], ship: ['human', '👤 Merge / Ship', ''] },
      keys: { review: 'REVIEW', ship: 'SHIP' },
      runnerKeys: { review: 'REVIEW', ship: 'SHIP' },
      optional: [],
      vb: '0 0 400 100',
      pos: { review: [100, 50], ship: [300, 50] },
      edges: [['review', 'ship', '', 'plain', 'h']],
      route: 'feature',
    });
  }
  if (trusted || routeV2) {
    adapter.readTrustedAttempt = async () => ({
      profile: 'demo',
      attempt: 'a_0123456789abcdef0123456789abcdef',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      workspaceMode: 'isolated',
    });
  }
  if (runDurationSec !== null) {
    const runDir = path.join(stateDir, 'logs', 'runs', 't7379', 'REVIEW', 'run-review');
    await mkdir(runDir, { recursive: true });
    const meta = path.join(runDir, 'meta.env');
    await writeFile(meta, [
      'SCHEMA=1', 'TASK=7379', 'STAGE=REVIEW', 'RUN_ID=run-review',
      'RESULT_CLASS=ok', 'RC=0', '',
    ].join('\n'));
    const started = (await stat(runDir)).birthtimeMs;
    const finished = new Date(Math.ceil(started / 1000) * 1000 + runDurationSec * 1000);
    await utimes(meta, finished, finished);
  }
  return adapter;
}

test('graph exposes pure work and gate wait as separate counters', async (t) => {
  const graph = await (await makeFixture(t)).getTaskGraph('7379');

  assert.deepEqual(graph.timing, {
    workSec: 14400,
    gateWaitSec: 3600,
    runningSinceMs: null,
    source: 'route-ledger',
    approximate: true,
  });
});

test('live non-human node ticks from the latest ledger event', async (t) => {
  const graph = await (await makeFixture(t, {
    workSec: '7200', gateWaitSec: '3600', lastEventSec: '1785243600',
    review: 'running', ship: 'pending', alive: true,
  })).getTaskGraph('7379');

  assert.deepEqual(graph.timing, {
    workSec: 7200,
    gateWaitSec: 3600,
    runningSinceMs: 1785243600000,
    source: 'route-ledger',
    approximate: true,
  });
});

test('human gate never ticks the work counter even while daemon is briefly alive', async (t) => {
  const graph = await (await makeFixture(t, { alive: true })).getTaskGraph('7379');

  assert.equal(graph.timing.runningSinceMs, null);
});

test('route-v2 ignores a 32-hour ledger gap and sums actual runner spans', async (t) => {
  const graph = await (await makeFixture(t, {
    routeV2: true,
    workSec: '117109',
    gateWaitSec: '4622',
    runDurationSec: 8 * 60,
  })).getTaskGraph('7379');

  assert.deepEqual(graph.timing, {
    workSec: 8 * 60,
    gateWaitSec: 4622,
    runningSinceMs: null,
    source: 'runner-telemetry',
    approximate: true,
  });
});

test('old active run restores exact timing through the verified engine ledger', async (t) => {
  let calls = 0;
  const adapter = await makeFixture(t, {
    workSec: null,
    trusted: true,
    workTimeReader: async () => {
      calls += 1;
      return { workSec: 14157, gateWaitSec: 232, lastEventSec: 1785748665 };
    },
  });
  const first = await adapter.getTaskGraph('7379');
  const second = await adapter.getTaskGraph('7379');

  assert.deepEqual(first.timing, {
    workSec: 14157,
    gateWaitSec: 232,
    runningSinceMs: null,
    source: 'route-ledger',
    approximate: true,
  });
  assert.deepEqual(second.timing, first.timing);
  assert.equal(calls, 1, 'проверенный ledger кэшируется до следующей версии реестра');
});

test('graph timing is null when neither projection nor trusted ledger is available', async (t) => {
  const graph = await (await makeFixture(t, { workSec: null })).getTaskGraph('7379');

  assert.equal(graph.timing, null);
});
