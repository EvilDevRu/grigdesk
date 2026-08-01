import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
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
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item-4',
        type: 'file_change',
        changes: [{ path: '/workspace/src/activity.js', kind: 'update' }],
        status: 'completed',
      },
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
    { type: 'tool', status: 'done' },
  ]);
  assert.equal(live.actions[0].text, 'Проверяю изменённые файлы.');
  assert.equal(live.actions[1].name, 'Команда');
  assert.match(live.actions[1].desc, /npm test/);
  assert.equal(live.actions[2].name, 'Ожидание субагентов');
  assert.equal(live.actions[3].name, 'Изменение файлов');
  assert.equal(live.actions[3].desc, '/workspace/src/activity.js');
});

// ACTIVE_RUN не чистят после этапа: это ещё и fencing-токен, сброс эпохи воскресил бы
// убитый ход. Значит непустой ключ у не бегущего этапа — расписка о прошлом, и брать
// с него свежесть журнала нельзя. Живой прогон t8165: конвейер штатно стоял у ворот
// плана, а модалка показывала «нет событий 676 мин» по журналу BUILD от отменённой
// позавчерашней попытки — и это читалось как «агент завис».
test('a stale ACTIVE_RUN of a finished stage is not mistaken for live activity', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-activity-stale.'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const staleDir = path.join(stateDir, 'logs', 'runs', 't8165', 'BUILD', 'run-abandoned');
  await mkdir(staleDir, { recursive: true });
  await writeFile(path.join(staleDir, 'events.jsonl'), `${JSON.stringify({ type: 'thread.started' })}\n`);
  const stale = new Date(Date.now() - 676 * 60 * 1000);
  await utimes(path.join(staleDir, 'events.jsonl'), stale, stale);

  // orch.log предыдущего поколения лежит рядом и переживает recovery — на v2 он тоже
  // не источник активности, иначе цифра просто сменится на другую, столь же чужую.
  await writeFile(path.join(stateDir, 'logs', 't8165.orch.log'), `${JSON.stringify({ type: 'assistant' })}\n`);

  const registry = {
    WF_STATUS: 'running',
    RUN_PROTOCOL: '2',
    SKEPTIC: 'done',
    BUILD: 'pending',
    ACTIVE_RUN_SKEPTIC: '',
    ACTIVE_RUN_BUILD: 'run-abandoned',
    GATE_PLAN: 'waiting',
  };
  const paused = readActivity({ stateDir, task: '8165', registry });
  assert.equal(paused.journalAgeSec, null);
  assert.equal(paused.journalFresh, false);
  assert.deepEqual(readAgentLive({ stateDir, task: '8165', registry }).actions, []);

  // Тот же реестр, но этап действительно бежит — свежесть берётся с его собственного хода.
  const runDir = path.join(stateDir, 'logs', 'runs', 't8165', 'BUILD', 'run-live');
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'events.jsonl'), `${JSON.stringify({ type: 'thread.started' })}\n`);
  const live = readActivity({
    stateDir,
    task: '8165',
    registry: { ...registry, BUILD: 'running', ACTIVE_RUN_BUILD: 'run-live' },
  });
  assert.equal(live.journalFresh, true);
  assert.equal(live.journalAgeSec < 2, true);
});
