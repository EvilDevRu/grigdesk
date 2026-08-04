import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FactoryStateAdapter } from '../../server/src/adapters/factory-state.js';

// Карточка читает не календарные метки общего stages.log, а движковую проекцию
// hash-chained attempt ledger: WORK_TIME_S суммирует рабочие узлы и петли,
// GATE_WAIT_S хранит ожидание человека отдельно.
async function makeFixture(t, {
  workSec = '14400', gateWaitSec = '3600', lastEventSec = '1785243600',
  review = 'done', ship = 'waiting', alive = false,
  workTimeReader = null, trusted = false,
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
    'WF_STATUS=running',
    'ORCH_PID=12345',
    `REVIEW=${review}`,
    `SHIP=${ship}`,
    ...telemetry,
    '',
  ].join('\n'));

  const adapter = new FactoryStateAdapter({ stateDir, profilesDir, workTimeReader });
  adapter.isDaemonAlive = () => alive;
  if (trusted) {
    adapter.readTrustedAttempt = async () => ({
      profile: 'demo', attempt: 'a_0123456789abcdef0123456789abcdef', workspaceMode: 'isolated',
    });
  }
  return adapter;
}

test('graph exposes pure work and gate wait as separate counters', async (t) => {
  const graph = await (await makeFixture(t)).getTaskGraph('7379');

  assert.deepEqual(graph.timing, {
    workSec: 14400,
    gateWaitSec: 3600,
    runningSinceMs: null,
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
  });
});

test('human gate never ticks the work counter even while daemon is briefly alive', async (t) => {
  const graph = await (await makeFixture(t, { alive: true })).getTaskGraph('7379');

  assert.equal(graph.timing.runningSinceMs, null);
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
  });
  assert.deepEqual(second.timing, first.timing);
  assert.equal(calls, 1, 'проверенный ledger кэшируется до следующей версии реестра');
});

test('graph timing is null when neither projection nor trusted ledger is available', async (t) => {
  const graph = await (await makeFixture(t, { workSec: null })).getTaskGraph('7379');

  assert.equal(graph.timing, null);
});
