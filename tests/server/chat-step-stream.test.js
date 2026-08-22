import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createStepSink, cutMiddle, STEP_TEXT_LIMIT,
} from '../../server/src/lib/chat/stream-steps.js';
import { toClaudeSteps } from '../../server/src/lib/executors/_claude-steps.js';
import { createCodexStepNormalizer } from '../../server/src/lib/executors/_codex-steps.js';
import { createKimiStepNormalizer } from '../../server/src/lib/executors/_kimi-steps.js';
import { createToolbox } from '../../server/src/lib/executors/_ollama-tools.js';
import codex from '../../server/src/lib/executors/codex.js';

test('Claude Write объявляет изменяемый файл в нейтральном шаге', () => {
  const steps = toClaudeSteps({
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use', id: 'write-1', name: 'Write',
        input: { file_path: 'src/new.js', content: 'export default 1;' },
      }],
    },
  });
  assert.deepEqual(steps[0]?.files, ['src/new.js']);
});

test('Codex file_change сохраняет все пути одного вызова', () => {
  const normalize = createCodexStepNormalizer();
  const steps = normalize({
    type: 'item.started',
    item: {
      id: 'change-1',
      type: 'file_change',
      changes: [
        { path: 'src/a.js', kind: 'update' },
        { path: 'src/b.js', kind: 'create' },
      ],
    },
  });
  assert.deepEqual(steps.find((step) => step.k === 'tool')?.files, ['src/a.js', 'src/b.js']);
});

test('Kimi edit объявляет путь независимо от текста превью', () => {
  const normalizer = createKimiStepNormalizer();
  const steps = normalizer({ update: {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'edit-1',
    kind: 'edit',
    status: 'in_progress',
    title: 'Edit file',
    rawInput: { path: 'src/kimi.js', old_string: 'a', new_string: 'b' },
  } });
  assert.deepEqual(steps.find((step) => step.k === 'tool')?.files, ['src/kimi.js']);
});

test('Ollama Write сообщает путь в tool-step и успешный результат отдельно', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cockpit-ollama-step-files-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const steps = [];
  const toolbox = await createToolbox({
    cwd,
    permissionMode: 'acceptEdits',
    sink: { emit: (step) => steps.push(step) },
  });
  await toolbox.call({ name: 'write_file', args: { path: 'src/ollama.js', content: 'ok\n' } });
  assert.deepEqual(steps.map((step) => ({ k: step.k, files: step.files, ok: step.ok })), [
    { k: 'tool', files: ['src/ollama.js'], ok: undefined },
    { k: 'res', files: undefined, ok: true },
  ]);
});

test('нейтральный sink ставит время, хранит хвост и транслирует ВСЕ шаги', () => {
  const sent = [];
  let tick = 100;
  const sink = createStepSink((step) => sent.push(step), {
    limit: 2,
    now: () => ++tick,
  });

  sink.emit({ k: 'start', model: 'test' });
  sink.emit({ k: 'think', text: 'проверяю' });
  sink.emit({ k: 'note', text: 'шаг сверх лимита хранения' });

  // Лимит режет только хранение: длинный ход упирался в него и переставал слать
  // шаги в SSE — лента в окне замирала, и живой агент выглядел повисшим.
  assert.deepEqual(sent.map((step) => step.k), ['start', 'think', 'note']);
  assert.equal(sink.steps.length, 2);
  assert.deepEqual(sink.steps.map((step) => step.k), ['think', 'note']);
  assert.deepEqual(sink.steps.map((step) => step.at), [102, 103]);
});

test('Claude normalizer сохраняет прежние шаги в общем контракте', () => {
  const steps = toClaudeSteps({
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'Сначала проверю файл.' },
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'git status' } },
      ],
    },
  });

  assert.deepEqual(steps, [
    { k: 'think', text: 'Сначала проверю файл.', sub: false },
    {
      k: 'tool', id: 'tool-1', name: 'Bash', sub: false, title: 'git status',
      command: 'git status', preview: '', lang: 'bash',
    },
  ]);
});

test('нормализаторы сохраняют полную многострочную Bash-команду для раскрытия в UI', () => {
  const command = 'node --test tests/server/chat-step-stream.test.js\nprintf done';
  const claude = toClaudeSteps({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 'claude-cmd', name: 'Bash', input: { command } }],
    },
  });
  const normalize = createCodexStepNormalizer();
  const codex = normalize({
    type: 'item.started',
    item: { id: 'codex-cmd', type: 'command_execution', command },
  });

  assert.equal(claude[0].title, command.split('\n')[0]);
  assert.equal(claude[0].command, command);
  assert.equal(codex.find((step) => step.k === 'tool')?.title, command.split('\n')[0]);
  assert.equal(codex.find((step) => step.k === 'tool')?.command, command);
});

test('очень длинная команда сокращается посередине и сохраняет видимый конец', () => {
  const command = `node -e "${'x'.repeat(STEP_TEXT_LIMIT)}" && npm run final-check`;
  const visible = cutMiddle(command);

  assert.equal(visible.length, STEP_TEXT_LIMIT);
  assert.match(visible, /… сокращено …/);
  assert.ok(visible.startsWith('node -e "'));
  assert.ok(visible.endsWith('&& npm run final-check'));
});

test('Codex normalizer показывает summary, но никогда raw reasoning', () => {
  const normalize = createCodexStepNormalizer({ model: 'gpt-requested', cwd: '/work' });
  const steps = [
    ...normalize({ type: 'thread.started', thread_id: 'thread-1', model: 'gpt-actual' }),
    ...normalize({
      type: 'item.completed',
      item: {
        id: 'reason-1', type: 'reasoning', text: 'Проверю изменения и тесты.', raw_content: 'СЕКРЕТНАЯ ВНУТРЕННЯЯ ЦЕПОЧКА',
      },
    }),
  ];

  assert.deepEqual(steps.map((step) => step.k), ['start', 'think']);
  assert.equal(steps[0].model, 'gpt-actual');
  assert.equal(steps[0].mode, 'workspace-write');
  assert.equal(steps[1].text, 'Проверю изменения и тесты.');
  assert.doesNotMatch(JSON.stringify(steps), /СЕКРЕТНАЯ/);
});

test('Codex normalizer показывает произвольные tool-call события по данным провайдера', () => {
  const normalize = createCodexStepNormalizer();
  const steps = [
    ...normalize({
      type: 'item.started',
      item: {
        id: 'collab-1',
        type: 'collab_tool_call',
        tool: 'spawn_agent',
        prompt: 'Проверь тесты чата.',
        status: 'in_progress',
      },
    }),
    ...normalize({
      type: 'item.completed',
      item: {
        id: 'collab-1',
        type: 'collab_tool_call',
        tool: 'spawn_agent',
        status: 'completed',
      },
    }),
    ...normalize({
      type: 'item.started',
      item: {
        id: 'future-1',
        type: 'future_tool_call',
        tool_name: 'inspect_queue',
        input: { queue: 'reviews' },
        status: 'in_progress',
      },
    }),
  ];

  assert.deepEqual(steps.find((step) => step.id === 'collab-1' && step.k === 'tool'), {
    k: 'tool',
    id: 'collab-1',
    name: 'spawn_agent',
    title: 'Проверь тесты чата.',
    sub: 'collab',
    preview: 'Проверь тесты чата.',
  });
  assert.deepEqual(steps.find((step) => step.id === 'future-1' && step.k === 'tool'), {
    k: 'tool',
    id: 'future-1',
    name: 'inspect_queue',
    title: '{"queue":"reviews"}',
    sub: 'future',
    preview: '{"queue":"reviews"}',
  });
  assert.doesNotMatch(JSON.stringify(steps), /UnknownTool/);
});

test('Codex executor передаёт JSONL-шаги живьём и сохраняет их в результате', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cockpit-codex-stream-'));
  const fake = path.join(dir, 'fake-codex');
  const events = [
    { type: 'thread.started', thread_id: 'thread-from-stream', model: 'gpt-actual' },
    {
      type: 'item.completed',
      item: {
        id: 'reason-1', type: 'reasoning', text: 'Сверяю состояние проекта.', raw_content: 'не показывать',
      },
    },
    { type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'git status', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: 'git status', aggregated_output: 'M src/app.js\n', exit_code: 0, status: 'completed' } },
    { type: 'item.started', item: { id: 'file-1', type: 'file_change', changes: [{ path: 'src/app.js', kind: 'update' }], status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'file-1', type: 'file_change', changes: [{ path: 'src/app.js', kind: 'update' }], status: 'completed' } },
    { type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: 'Готово.' } },
    { type: 'turn.completed', usage: { input_tokens: 17, output_tokens: 3, reasoning_output_tokens: 4 } },
  ];
  const first = events.slice(0, 3).map((event) => `printf '%s\\n' '${JSON.stringify(event)}'`).join('\n');
  const rest = events.slice(3).map((event) => `printf '%s\\n' '${JSON.stringify(event)}'`).join('\n');
  await writeFile(fake, `#!/bin/sh\n${first}\nsleep 0.15\n${rest}\n`);
  await chmod(fake, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));

  const live = [];
  const progress = [];
  const run = codex.run({
    config: { codexBin: fake }, message: 'test', cwd: dir, model: 'gpt-requested', effort: '',
    sessionId: null, signal: undefined,
    onStep: (step) => live.push(step),
    onProgress: (tokens) => progress.push(tokens),
    tokenInfoReader: async () => ({
      contextTokens: 11,
      contextWindow: 258_400,
      contextMetric: 'active-input-v1',
      contextIsEstimate: false,
      contextCache: {
        scope: 'request', status: 'reported', readTokens: 10, uncachedTokens: 1,
      },
      totalInputTokens: 17,
      cachedInputTokens: 10,
    }),
  });

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(live.map((step) => step.k), ['start', 'think', 'tool']);

  const out = await run;
  assert.equal(out.reply, 'Готово.');
  assert.equal(out.sessionId, 'thread-from-stream');
  assert.equal(out.actualModel, 'gpt-actual');
  assert.equal(out.contextTokens, 11);
  assert.equal(out.contextWindow, 258_400);
  assert.equal(out.contextMetric, 'active-input-v1');
  assert.equal(out.contextIsEstimate, false);
  assert.deepEqual(out.contextCache, {
    scope: 'request', status: 'reported', readTokens: 10, uncachedTokens: 1,
  });
  assert.equal(Object.hasOwn(out.contextCache, 'writeTokens'), false);
  assert.equal(out.totalInputTokens, 17);
  assert.equal(out.cachedInputTokens, 10);
  assert.deepEqual(out.steps.map((step) => step.k), ['start', 'think', 'tool', 'res', 'tool', 'res']);
  assert.deepEqual(live, out.steps);
  assert.equal(out.steps[1].text, 'Сверяю состояние проекта.');
  assert.doesNotMatch(JSON.stringify(out.steps), /не показывать/);
  assert.deepEqual(progress, [7]);
});
