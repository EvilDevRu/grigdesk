import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FactoryStateAdapter } from '../../server/src/adapters/factory-state.js';

test('graph exposes a human stall on the affected node instead of showing it as running', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-graph-stall-'));
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
  await writeFile(path.join(stateDir, 't7379.pipeline'), [
    'PROFILE=demo',
    'ROUTE=feature',
    'WF_STATUS=running',
    'STALLED_HUMAN=1',
    'REVIEW=running',
    'REVIEW_AT=2026-07-28 22:26:52',
    'REVIEW_FAILS=113',
    'SHIP=pending',
    '',
  ].join('\n'));
  await writeFile(path.join(stateDir, 'logs', 't7379.stages.log'), [
    '2026-07-28 22:26:52 [t7379] REVIEW: 3 попытки без результата — СТОП, нужен человек',
    '',
  ].join('\n'));

  const graph = await new FactoryStateAdapter({ stateDir, profilesDir }).getTaskGraph('7379');

  assert.equal(graph.stall.stage, 'REVIEW');
  assert.equal(graph.stall.node, 'review');
  assert.match(graph.stall.title, /трижды не отчитался/);
  assert.equal(graph.statuses.review, 'stall');
  assert.equal(graph.progress.current, 'review');
  assert.deepEqual(graph.nodeMeta.review.stall, graph.stall);
});
