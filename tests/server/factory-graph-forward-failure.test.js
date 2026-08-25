import assert from 'node:assert/strict';
import test from 'node:test';

import { computeNodeStatuses } from '../../server/src/lib/factory-graph.js';
import { buildRouteDef } from '../../server/src/lib/route-graph.js';

// Член совета, у которого кончилась квота провайдера: реестр пишет ему `failed`
// (движок так же проецирует исчерпанный бюджет повторов), но контракт узла ведёт
// маршрут ВПЕРЁД — значит конвейер прошёл мимо, а не упёрся. Живой случай — t7900:
// kimi ответил 403 usage limit, схема красила council_c тем же `stall`, что и
// реально вставший tcritic.
const COUNCIL_ROUTE = {
  schema: 2,
  kind: 'route',
  profile: 'demo',
  id: 'consilium',
  entry: 'council_a',
  sequence: { main: ['council_a', 'council_b', 'council_agg', 'chairman', 'tcritic'], tail: [] },
  nodes: [
    {
      id: 'council_a',
      executor: 'agent',
      runKey: 'COUNCIL_A',
      label: 'Совет: мнение A',
      on: {
        done: { next: 'council_b' },
        skipped: { next: 'council_b' },
        failed: { next: 'council_b' },
        exhausted: { next: 'council_b' },
      },
    },
    {
      id: 'council_b',
      executor: 'agent',
      runKey: 'COUNCIL_B',
      label: 'Совет: мнение B',
      on: {
        done: { next: 'council_agg' },
        skipped: { next: 'council_agg' },
        failed: { next: 'council_agg' },
        exhausted: { next: 'council_agg' },
      },
    },
    {
      id: 'council_agg',
      executor: 'command',
      runKey: 'COUNCIL_AGG',
      label: 'Совет: кворум',
      on: {
        done: { next: 'chairman' },
        skipped: { stop: 'human' },
        failed: { stop: 'human' },
        exhausted: { stop: 'human' },
      },
    },
    {
      id: 'chairman',
      executor: 'agent',
      runKey: 'CHAIRMAN',
      label: 'Председатель',
      on: {
        done: { next: 'tcritic' },
        skipped: { stop: 'human' },
        failed: { stop: 'human' },
        exhausted: { stop: 'human' },
      },
    },
    {
      id: 'tcritic',
      executor: 'agent',
      runKey: 'TCRITIC',
      label: 'Тест-критик',
      on: {
        done: { stop: 'done' },
        skipped: { stop: 'human' },
        failed: { rewind: 'chairman', reset: ['chairman', 'tcritic'] },
        exhausted: { stop: 'human' },
      },
    },
  ],
};

test('провал узла, чей контракт ведёт вперёд, рисуется пропуском, а не упором', () => {
  const def = buildRouteDef(COUNCIL_ROUTE, 'consilium', { workspaceMode: 'shared' });

  assert.deepEqual(def.forwardOnFailure, ['council_a', 'council_b']);

  const statuses = computeNodeStatuses({
    pf: {
      CATALOG_PROTOCOL: 'route-v2',
      COUNCIL_A: 'done',
      COUNCIL_B: 'failed',
      COUNCIL_AGG: 'done',
      CHAIRMAN: 'done',
      TCRITIC: 'failed',
    },
    pos: def.pos,
    keys: def.keys,
    optional: def.optional,
    forwardOnFailure: def.forwardOnFailure,
    mtimeMs: Date.now(),
  });

  assert.equal(statuses.council_b, 'skip', 'выпавший член совета — пропуск');
  // Возврат на предыдущий узел остановкой не является, но и пропуском тоже:
  // работа не прошла мимо, её будут переигрывать.
  assert.equal(statuses.tcritic, 'stall', 'настоящий упор остаётся красным');
});

test('без списка forwardOnFailure поведение прежнее: любой failed — упор', () => {
  const statuses = computeNodeStatuses({
    pf: { CATALOG_PROTOCOL: 'route-v2', COUNCIL_A: 'done', COUNCIL_B: 'failed' },
    pos: { council_a: [0, 0], council_b: [0, 0] },
    keys: { council_a: 'COUNCIL_A', council_b: 'COUNCIL_B' },
    optional: [],
    mtimeMs: Date.now(),
  });

  assert.equal(statuses.council_b, 'stall');
});
