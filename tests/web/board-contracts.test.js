import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeBoardDashboard } from '../../web/src/shared/boardContracts.ts';
import { decodePipelineTasks } from '../../web/src/shared/pipelineContracts.ts';

const source = `grigdesk-b24@${'a'.repeat(64)}`;

test('доска принимает optional дату, канонический и прежний vendor source без потери полей', () => {
  const snapshot = {
    source,
    tasks: [{
    id: 42,
    createdAt: '2026-11-02T00:00:00Z',
    source,
    extension: { retained: true }
  }]
  };

  assert.deepEqual(decodeBoardDashboard(snapshot), snapshot);
  assert.deepEqual(decodeBoardDashboard({ tasks: [{ id: 42, source: 'b24' }] }).tasks?.length, 1);
  assert.throws(() => decodeBoardDashboard({ tasks: [{ id: 42, createdAt: 123 }] }));
  assert.throws(() => decodeBoardDashboard({ tasks: [{ id: 42, source: false }] }));
});

test('новый pipeline decoder принимает legacy и явно версионированный source', () => {
  assert.equal(decodePipelineTasks({ tasks: [{ task: 42 }] }).tasks?.length, 1);
  assert.equal(decodePipelineTasks({ tasks: [{ task: 42, source }], sourcesVersion: 1 })
    .tasks?.[0].source, source);
  assert.throws(() => decodePipelineTasks({ tasks: [{ task: 42, source: 'b24' }] }));
  assert.throws(() => decodePipelineTasks({ tasks: [], sourcesVersion: 2 }));
});
