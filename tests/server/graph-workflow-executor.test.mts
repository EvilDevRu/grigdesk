import assert from 'node:assert/strict';
import test from 'node:test';

import { runGraphModel } from '../../server/src/lib/graphWorkflowExecutor.ts';
import type { WorkflowRow } from '../../shared/pipeline/graphWorkflowContracts.ts';

test('модельный результат привязывается только к показанной исходной строке', async () => {
  const base = {
    kind: 'agent' as const,
    prompt: 'Укажи, что договорились сделать',
    modelRef: { provider: 'claude', model: 'test' },
    rows: [{
      key: 'file-1',
      title: 'meeting.txt',
      text: 'Подготовить протокол',
      sources: [{ inputKey: 'file-1', line: 8, timeMs: 12000 }],
    }],
  };
  const calls: Record<string, unknown>[] = [];
  let line = 2;
  const resolveTarget = async () => ({
    ok: true,
    ref: base.modelRef,
    executor: {
      runUntrusted: async (input: Record<string, unknown>) => {
        calls.push(input);

        return { reply: JSON.stringify({ rows: [{ title: 'Протокол', text: 'Подготовить протокол', line }] }) };
      },
    },
  });
  const ports = { config: {}, resolveTarget, signal: new AbortController().signal };

  assert.deepEqual(await runGraphModel(base, ports), { errorCode: 'bad_model_result' });
  line = 1;
  assert.deepEqual(await runGraphModel(base, ports), {
    rows: [{
      key: 'row-1',
      title: 'Протокол',
      text: 'Подготовить протокол',
      sources: [{ inputKey: 'file-1', line: 8, timeMs: 12000 }],
    }],
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((entry) => entry.cwd === undefined && entry.workTools === undefined));
});

function meetingPorts(reply: unknown, calls: Record<string, unknown>[] = []) {
  return {
    config: {},
    signal: new AbortController().signal,
    resolveTarget: async () => ({
      ok: true,
      ref: { provider: 'claude', model: 'test' },
      executor: {
        runUntrusted: async (input: Record<string, unknown>) => {
          calls.push(input);

          return { reply: JSON.stringify(reply) };
        },
        run: async () => {
          throw new Error('обычный run не должен вызываться');
        },
      },
    }),
  };
}

const transcriptRows: WorkflowRow[] = [
  { key: 'row-1', title: 'm.json', text: 'Утвердили порядок', sources: [{ inputKey: 'file-1', line: 1, timeMs: 12000 }] },
  { key: 'row-2', title: 'm.json', text: 'Ира подготовит сводку', sources: [{ inputKey: 'file-1', line: 2, timeMs: 15000 }] },
];

test('meeting adapter preserves sources and ready empty result', async () => {
  const calls: Record<string, unknown>[] = [];
  const task = { segments: [2], title: 'Сводка', description: 'Подготовить сводку', confidence: 0.9, reason: 'поручение' };
  const result = await runGraphModel(
    { kind: 'meetingTasks', modelRef: { provider: 'claude', model: 'test' }, rows: transcriptRows },
    meetingPorts({ tasks: [task] }, calls),
  );
  assert.deepEqual(result, {
    rows: [{
      key: 'row-1',
      title: 'Сводка',
      text: 'Подготовить сводку',
      sources: [{ inputKey: 'file-1', line: 2, timeMs: 15000 }],
    }],
  });
  assert.equal(calls.length, 1);
  assert.ok(!String(calls[0]!.message).includes('00:00'));

  const empty = await runGraphModel(
    { kind: 'meetingTasks', modelRef: { provider: 'claude', model: 'test' }, rows: transcriptRows },
    meetingPorts({ tasks: [] }),
  );
  assert.deepEqual(empty, { rows: [] });

  const outside = await runGraphModel(
    { kind: 'meetingTasks', modelRef: { provider: 'claude', model: 'test' }, rows: transcriptRows },
    meetingPorts({ tasks: [{ ...task, segments: [3] }] }),
  );
  assert.deepEqual(outside, { errorCode: 'bad_plan' });
});

test('meetingTasks за пределом символов не вызывает провайдера', async () => {
  const calls: Record<string, unknown>[] = [];
  const longRows: WorkflowRow[] = [{
    key: 'row-1',
    title: 'm.txt',
    text: 'слово '.repeat(20000),
    sources: [{ inputKey: 'file-1', line: 1 }],
  }];
  const result = await runGraphModel(
    { kind: 'meetingTasks', modelRef: { provider: 'claude', model: 'test' }, rows: longRows },
    meetingPorts({ tasks: [] }, calls),
  );
  assert.deepEqual(result, { errorCode: 'input_limit' });
  assert.equal(calls.length, 0);
});

test('замечание доставляется во вход возврата обоим модельным портам', async () => {
  const agentCalls: Record<string, unknown>[] = [];
  const agent = await runGraphModel(
    {
      kind: 'agent', prompt: 'сделай', feedback: 'проверить ответственного',
      modelRef: { provider: 'claude', model: 'test' }, rows: transcriptRows,
    },
    meetingPorts({ rows: [{ title: 't', text: 'x', line: 1 }] }, agentCalls),
  );
  assert.ok('rows' in agent);
  assert.ok(String(agentCalls[0]!.message).includes('Замечание проверяющего: проверить ответственного'));

  const meetingCalls: Record<string, unknown>[] = [];
  const meeting = await runGraphModel(
    {
      kind: 'meetingTasks', feedback: 'проверить ответственного',
      modelRef: { provider: 'claude', model: 'test' }, rows: transcriptRows,
    },
    meetingPorts({ tasks: [] }, meetingCalls),
  );
  assert.deepEqual(meeting, { rows: [] });
  assert.ok(String(meetingCalls[0]!.message).includes('проверить ответственного'));
});

test('исключение с исходником не попадает в журнал', async () => {
  const logged: unknown[] = [];
  const ports = {
    config: {},
    signal: new AbortController().signal,
    log: { warn: (details: unknown, message: string) => logged.push({ details, message }) },
    resolveTarget: async () => ({
      ok: true,
      ref: { provider: 'claude', model: 'test' },
      executor: {
        runUntrusted: async () => {
          throw new Error('PRIVATE_INPUT_MARKER');
        },
      },
    }),
  };
  const result = await runGraphModel(
    { kind: 'meetingTasks', modelRef: { provider: 'claude', model: 'test' }, rows: transcriptRows },
    ports,
  );
  assert.deepEqual(result, { errorCode: 'run_failed' });
  assert.ok(logged.length > 0);
  assert.ok(!JSON.stringify(logged).includes('PRIVATE_INPUT_MARKER'));
  assert.ok(JSON.stringify(logged).includes('graph_model_failed'));
});

test('обычный agent с пустыми данными принимает line:null и отвергает выдуманный индекс', async () => {
  const ports = meetingPorts({ rows: [{ title: 'Чек-лист', text: 'пункт', line: null }] });
  const empty = await runGraphModel(
    { kind: 'agent', prompt: 'составь', modelRef: { provider: 'claude', model: 'test' }, rows: [] },
    ports,
  );
  assert.deepEqual(empty, { rows: [{ key: 'row-1', title: 'Чек-лист', text: 'пункт' }] });

  const fabricated = await runGraphModel(
    { kind: 'agent', prompt: 'составь', modelRef: { provider: 'claude', model: 'test' }, rows: [] },
    meetingPorts({ rows: [{ title: 'Чек-лист', text: 'пункт', line: 1 }] }),
  );
  assert.deepEqual(fabricated, { errorCode: 'bad_model_result' });
});

test('адрес рабочего фрагмента превращается в точную исходную метку', async () => {
  const normalized: WorkflowRow[] = [{
    key: 'row-2',
    title: 'm.json',
    text: 'Решили проверить отчёт',
    sources: [{ inputKey: 'file-1', line: 2, timeMs: 12000 }],
  }];
  const agent = await runGraphModel(
    { kind: 'agent', prompt: 'выдели', modelRef: { provider: 'claude', model: 'test' }, rows: normalized },
    meetingPorts({ rows: [{ title: 'Решение', text: 'Проверить отчёт', line: 1 }] }),
  );
  assert.deepEqual(agent, {
    rows: [{
      key: 'row-1', title: 'Решение', text: 'Проверить отчёт',
      sources: [{ inputKey: 'file-1', line: 2, timeMs: 12000 }],
    }],
  });
  const outside = await runGraphModel(
    { kind: 'agent', prompt: 'выдели', modelRef: { provider: 'claude', model: 'test' }, rows: normalized },
    meetingPorts({ rows: [{ title: 'Решение', text: 'Проверить отчёт', line: 2 }] }),
  );
  assert.deepEqual(outside, { errorCode: 'bad_model_result' });

  const meeting = await runGraphModel(
    { kind: 'meetingTasks', modelRef: { provider: 'claude', model: 'test' }, rows: normalized },
    meetingPorts({ tasks: [{ segments: [1], title: 'Поручение', description: 'Проверить', confidence: 0.8, reason: 'решение' }] }),
  );
  assert.deepEqual(meeting, {
    rows: [{
      key: 'row-1', title: 'Поручение', text: 'Проверить',
      sources: [{ inputKey: 'file-1', line: 2, timeMs: 12000 }],
    }],
  });
});