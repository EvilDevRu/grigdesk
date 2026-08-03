import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FactoryStateAdapter } from '../../server/src/adapters/factory-state.js';
import { detectStall } from '../../server/src/lib/stall.js';

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

test('route environment rc=75 is classified without prescribing shared cleanup', () => {
  const stall = detectStall({
    registry: { STALLED_HUMAN: '1' },
    daemonAlive: false,
    logText: [
      '2026-08-02 13:51:34 [t8162] v2: обнаружена частично созданная песочница; автоматическое удаление запрещено',
      '2026-08-02 13:51:34 [t8162] v2: среда профиля не готова (код 75)',
      '',
    ].join('\n'),
  });
  assert.equal(stall.stage, 'SANDBOX');
  assert.match(stall.title, /среда профиля не готова/);
  assert.match(stall.hint, /shared-ресурсы не удаляй/);
});

test('typed no-progress stop identifies the exact reviewer node', () => {
  const stall = detectStall({
    registry: {
      STALLED_HUMAN: '1',
      REVIEW_COMMENT: 'валидный regex всё ещё возвращает 422',
    },
    daemonAlive: false,
    logText: [
      '2026-08-03 11:15:00 [t7788] REVIEW: маршрут остановлен: no-progress',
      '',
    ].join('\n'),
  });

  assert.equal(stall.stage, 'REVIEW');
  assert.match(stall.title, /не меняют набор замечаний/);
  assert.match(stall.hint, /findings/);
  assert.equal(stall.comment, 'валидный regex всё ещё возвращает 422');
});
