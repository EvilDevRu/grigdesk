import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readActivity, readAgentLive, readRunSilence } from '../../server/src/lib/factoryCli.ts';
import { readProcessIdentity } from '../../server/src/lib/speech/modelJobsProcess.ts';

test('activity follows the active run and renders Codex JSONL events', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-activity.'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const runId = 'run-codex-1';
  const runDir = path.join(stateDir, 'logs', 'runs', 't41', 'REVIEW', runId);
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
  const activity = readActivity({ stateDir, task: '41', registry });
  const live = readAgentLive({ stateDir, task: '41', registry });

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
// с него свежесть журнала нельзя. Иначе на штатной паузе у ворот модалка показывает
// давнюю запись BUILD отменённой попытки, и это читается как «агент завис».
test('a stale ACTIVE_RUN of a finished stage is not mistaken for live activity', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-activity-stale.'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const staleDir = path.join(stateDir, 'logs', 'runs', 't42', 'BUILD', 'run-abandoned');
  await mkdir(staleDir, { recursive: true });
  await writeFile(path.join(staleDir, 'events.jsonl'), `${JSON.stringify({ type: 'thread.started' })}\n`);
  const stale = new Date(Date.now() - 676 * 60 * 1000);
  await utimes(path.join(staleDir, 'events.jsonl'), stale, stale);

  // orch.log предыдущего поколения лежит рядом и переживает recovery — на v2 он тоже
  // не источник активности, иначе цифра просто сменится на другую, столь же чужую.
  await writeFile(path.join(stateDir, 'logs', 't42.orch.log'), `${JSON.stringify({ type: 'assistant' })}\n`);

  const registry = {
    WF_STATUS: 'running',
    RUN_PROTOCOL: '2',
    SKEPTIC: 'done',
    BUILD: 'pending',
    ACTIVE_RUN_SKEPTIC: '',
    ACTIVE_RUN_BUILD: 'run-abandoned',
    GATE_PLAN: 'waiting',
  };
  const paused = readActivity({ stateDir, task: '42', registry });
  assert.equal(paused.journalAgeSec, null);
  assert.equal(paused.journalFresh, false);
  assert.deepEqual(readAgentLive({ stateDir, task: '42', registry }).actions, []);

  // Тот же реестр, но этап действительно бежит — свежесть берётся с его собственного хода.
  const runDir = path.join(stateDir, 'logs', 'runs', 't42', 'BUILD', 'run-live');
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'events.jsonl'), `${JSON.stringify({ type: 'thread.started' })}\n`);
  const live = readActivity({
    stateDir,
    task: '42',
    registry: { ...registry, BUILD: 'running', ACTIVE_RUN_BUILD: 'run-live' },
  });
  assert.equal(live.journalFresh, true);
  assert.equal(live.journalAgeSec < 2, true);
});

// TERM (выключили машину, остановили прогон) оставляет этап `running`, а ACTIVE_RUN —
// ссылкой на убитый ход, пока следующий не зарегистрируется. Утром после «Продолжить»
// возраст журнала убитого хода звенел «молчит 599 мин» над ходом, который только стартует.
// Молчать может лишь ход, чей раннер жив: PID и STARTTIME из meta.env совпали с /proc.
test('a run whose runner is gone is not read as silence', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-silence-gone.'));

  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const runDir = path.join(stateDir, 'logs', 'runs', 't45', 'SOL_BUILD', 'run-killed');
  const eventsFile = path.join(runDir, 'events.jsonl');
  const killedAt = new Date(Date.now() - 600 * 60 * 1000);

  await mkdir(runDir, { recursive: true });
  await writeFile(eventsFile, `${JSON.stringify({ type: 'item.completed' })}\n`);
  await utimes(eventsFile, killedAt, killedAt);

  const registry = {
    WF_STATUS: 'running',
    RUN_PROTOCOL: '2',
    SOL_BUILD: 'running',
    ACTIVE_RUN_SOL_BUILD: 'run-killed',
  };
  const read = {
    stateDir,
    task: '45',
    registry,
  };
  const self = readProcessIdentity(process.pid);
  const passport = (pid, starttime) => writeFile(path.join(runDir, 'meta.env'), [
    'SCHEMA=2',
    'RUNNER=codex',
    `PID=${pid}`,
    `STARTTIME=${starttime}`,
    '',
  ].join('\n'));

  // Раннер завершился: процесса с этим номером больше нет.
  await passport(spawnSync('true').pid, self.starttime);
  assert.equal(readRunSilence(read), null);

  // Машину перезагрузили: номер достался другому процессу, время старта не совпало.
  await passport(process.pid, `${self.starttime}0`);
  assert.equal(readRunSilence(read), null);
  assert.equal(readActivity(read).journalAgeSec, null);

  // Тот же ход с живым раннером молчит честно — по возрасту журнала.
  await passport(process.pid, self.starttime);

  const silence = readRunSilence(read);

  assert.equal(silence?.stage, 'SOL_BUILD');
  assert.equal(silence.sec >= 600 * 60, true);
  assert.equal(silence.tool, null);
});

/** Хартбит Claude CLI: печатается раз в 30 секунд на КАЖДЫЙ висящий вызов. */
function heartbeat(id, tool, sec) {
  return JSON.stringify({
    type: 'tool_progress',
    tool_use_id: `${id}-heartbeat-${sec / 30}`,
    tool_name: tool,
    parent_tool_use_id: null,
    elapsed_time_seconds: sec,
    heartbeat: true,
  });
}

// Хартбиты обновляют mtime журнала, поэтому свежесть файла перестала значить «агент
// работает»: в регрессионном сценарии браузерная приёмка долго стояла на мёртвой странице, а
// кокпит всё это время писал «агент пишет». Молчание считаем по последней осмысленной
// записи, длительность берём из самого хартбита — он её и сообщает.
test('a tail of heartbeats reads as silence and names the hanging tool', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-silence.'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const runDir = path.join(stateDir, 'logs', 'runs', 't43', 'BROWSER', 'run-browser-1');
  await mkdir(runDir, { recursive: true });
  // Висят сразу два вызова (модель попросила инструменты пачкой) — честный ответ по
  // старшему из них, поэтому хартбиты идут вперемешку и последним лежит младший.
  const beats = [];
  for (let sec = 30; sec <= 600; sec += 30) {
    beats.push(heartbeat('toolu_click', 'mcp__playwright__browser_click', sec + 1080));
    beats.push(heartbeat('toolu_snap', 'mcp__playwright__browser_snapshot', sec));
  }
  await writeFile(path.join(runDir, 'events.jsonl'), [
    JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [] } }),
    ...beats,
    '',
  ].join('\n'));

  const registry = {
    WF_STATUS: 'running',
    RUN_PROTOCOL: '2',
    BROWSER: 'running',
    ACTIVE_RUN_BROWSER: 'run-browser-1',
  };
  assert.deepEqual(readRunSilence({ stateDir, task: '43', registry }), {
    stage: 'BROWSER',
    sec: 1680,
    tool: 'mcp__playwright__browser_click',
  });

  const activity = readActivity({ stateDir, task: '43', registry });
  assert.equal(activity.journalFresh, false);
  assert.equal(activity.journalAgeSec, 1680);
  assert.equal(activity.silentTool, 'mcp__playwright__browser_click');
});

// Обратная сторона того же правила: вызов ответил, ход снова заговорил — молчание
// обнулилось, хотя хартбиты никуда из журнала не делись.
test('a meaningful record after the heartbeats ends the silence', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-silence-over.'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const runDir = path.join(stateDir, 'logs', 'runs', 't44', 'BROWSER', 'run-browser-2');
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'events.jsonl'), [
    heartbeat('toolu_click', 'mcp__playwright__browser_click', 1500),
    heartbeat('toolu_click', 'mcp__playwright__browser_click', 1530),
    JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: [] } }),
    '',
  ].join('\n'));

  const registry = {
    WF_STATUS: 'running',
    RUN_PROTOCOL: '2',
    BROWSER: 'running',
    ACTIVE_RUN_BROWSER: 'run-browser-2',
  };
  const silence = readRunSilence({ stateDir, task: '44', registry });
  assert.equal(silence.sec < 2, true);
  assert.equal(silence.tool, null);
  assert.equal(readActivity({ stateDir, task: '44', registry }).journalFresh, true);
});
