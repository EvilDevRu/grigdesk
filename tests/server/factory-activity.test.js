import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readActivity, readAgentLive } from '../../server/src/lib/factory-cli.js';

test('activity follows the active run and renders Codex JSONL events', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-activity.'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const runId = 'run-codex-1';
  const runDir = path.join(stateDir, 'logs', 'runs', 't7379', 'REVIEW', runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'meta.env'), [
    'SCHEMA=1',
    'RUNNER=codex',
    'MODEL=gpt-5.6-sol',
    '',
  ].join('\n'));
  await writeFile(path.join(runDir, 'events.jsonl'), [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item-1', type: 'agent_message', text: 'Проверяю изменённые файлы.' },
    }),
    JSON.stringify({
      type: 'item.started',
      item: {
        id: 'item-2',
        type: 'command_execution',
        command: '/bin/bash -lc "npm test"',
        status: 'in_progress',
      },
    }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item-2',
        type: 'command_execution',
        command: '/bin/bash -lc "npm test"',
        status: 'failed',
      },
    }),
    JSON.stringify({
      type: 'item.started',
      item: { id: 'item-3', type: 'collab_tool_call', tool: 'wait', status: 'in_progress' },
    }),
    '',
  ].join('\n'));

  const registry = {
    WF_STATUS: 'running',
    REVIEW: 'running',
    ACTIVE_RUN_REVIEW: runId,
    MODEL_ACTUAL_REVIEW: 'gpt-5.6-sol',
  };
  const activity = readActivity({ stateDir, task: '7379', registry });
  const live = readAgentLive({ stateDir, task: '7379', registry });

  assert.equal(activity.journalFresh, true);
  assert.equal(Number.isInteger(activity.journalAgeSec), true);
  assert.equal(activity.journalAgeSec < 2, true);
  assert.equal(live.model, 'gpt-5.6-sol');
  assert.deepEqual(live.actions.map(({ type, status }) => ({ type, status })), [
    { type: 'text', status: undefined },
    { type: 'tool', status: 'error' },
    { type: 'tool', status: 'run' },
  ]);
  assert.equal(live.actions[0].text, 'Проверяю изменённые файлы.');
  assert.equal(live.actions[1].name, 'Команда');
  assert.match(live.actions[1].desc, /npm test/);
  assert.equal(live.actions[2].name, 'Ожидание субагентов');
});
