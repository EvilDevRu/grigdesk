import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createStepSink, cutMiddle, STEP_TEXT_LIMIT,
} from '../../server/src/lib/chat/streamSteps.ts';
import { toClaudeSteps } from '../../server/src/lib/executors/_claudeSteps.ts';
import { createCodexStepNormalizer } from '../../server/src/lib/executors/_codexSteps.ts';
import { createKimiStepNormalizer } from '../../server/src/lib/executors/_kimiSteps.ts';
import codex from '../../server/src/lib/executors/codex.ts';
import { STEP_IMAGE_TEXT } from '../../shared/chat/chatSteps.ts';

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

test('Codex add/delete: содержимое файла разворачивается в patch нужной стороны', () => {
  const normalize = createCodexStepNormalizer();
  const steps = normalize({
    method: 'item/started',
    params: {
      item: {
        id: 'fc-raw', type: 'fileChange', status: 'inProgress',
        changes: [
          // app-server кладёт в `diff` созданного файла его текст, а не unified diff.
          { path: 'src/new.py', kind: { type: 'add' }, diff: 'import os\n\ndef main():\n    pass\n' },
          { path: 'src/old.py', kind: { type: 'delete' }, diff: 'x = 1\n' },
          { path: 'src/patch.js', kind: { type: 'add' }, diff: '@@ -0,0 +1,1 @@\n+ok\n' },
          { path: 'src/upd.js', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-1\n+2\n' },
        ],
      },
    },
  });

  const tool = steps.find((step) => step.k === 'tool');
  assert.deepEqual(tool?.changes.map((change) => [change.kind, change.diff]), [
    ['add', '@@ -0,0 +1,4 @@\n+import os\n+\n+def main():\n+    pass\n'],
    ['delete', '@@ -1,1 +0,0 @@\n-x = 1\n'],
    // Уже готовый patch и обычный update проходят как есть.
    ['add', '@@ -0,0 +1,1 @@\n+ok\n'],
    ['update', '@@ -1 +1 @@\n-1\n+2\n'],
  ]);
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
  // Вытеснение больше не молчит: место самого старого шага занимает счётчик, иначе
  // сохранённая лента читается как полный отчёт о ходе.
  assert.equal(sink.steps.length, 2);
  assert.deepEqual(sink.steps.map((step) => step.k), ['note', 'note']);
  assert.equal(sink.steps[0].truncated, true);
  assert.match(sink.steps[0].text, /скрыты: 2$/);
  assert.equal(sink.steps[1].text, 'шаг сверх лимита хранения');
});

test('счётчик вытесненных шагов продолжается, а сама метка в него не попадает', () => {
  const sink = createStepSink(null, { limit: 3 });
  for (let index = 1; index <= 10; index += 1) {
    sink.emit({ k: 'tool', id: String(index), title: `шаг ${index}` });
  }

  assert.equal(sink.steps.length, 3);
  assert.equal(sink.steps[0].truncated, true);
  // 10 шагов, в окне осталось два последних — скрыто ровно восемь.
  assert.match(sink.steps[0].text, /скрыты: 8$/);
  assert.deepEqual(sink.steps.slice(1).map((step) => step.title), ['шаг 9', 'шаг 10']);
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
    { k: 'think', text: 'Сначала проверю файл.' },
    {
      k: 'tool', id: 'tool-1', name: 'Bash', title: 'git status',
      command: 'git status', preview: '', lang: 'bash',
    },
  ]);
});

test('Claude normalizer: вложенность шага — parent субагента, а не подпись sub', () => {
  // Правка в корне хода: `sub` — путь файла, признака вложенности у шага нет.
  const [edit] = toClaudeSteps({
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use', id: 'edit-1', name: 'Edit',
        input: { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' },
      }],
    },
  });
  assert.equal(edit.sub, '/repo/src/a.ts');
  assert.equal(Object.hasOwn(edit, 'parent'), false, 'правка в корне хода помечена вложенной');

  // Шаги субагента несут id родительского вызова, а подпись остаётся подписью.
  const nested = toClaudeSteps({
    type: 'assistant',
    parent_tool_use_id: 'task-1',
    message: {
      content: [
        { type: 'thinking', thinking: 'Смотрю файл.' },
        { type: 'tool_use', id: 'inner-1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 'inner-2', name: 'Read', input: { file_path: '/repo/README.md' } },
      ],
    },
  });
  assert.deepEqual(nested.map((step) => step.parent), ['task-1', 'task-1', 'task-1']);
  assert.equal(nested[1].sub, undefined, 'у Bash подписи нет — и булевого «true» тоже');
  assert.equal(nested[2].sub, '/repo/README.md');
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

test('Codex normalizer не теряет незнакомый тип элемента', () => {
  // Codex дописывает типы быстрее, чем GrigDesk разбирает их поимённо. Раньше всё,
  // чего не было в списке, исчезало бесследно — вместе с вызовом И его результатом,
  // и человек читал ленту как полный отчёт о ходе.
  const normalize = createCodexStepNormalizer();
  const steps = [
    ...normalize({
      method: 'item/started',
      params: { item: { type: 'functionCallOutput', id: 'fn-1', name: 'read_file' } },
    }),
    ...normalize({
      method: 'item/completed',
      params: {
        item: {
          type: 'functionCallOutput', id: 'fn-1', name: 'read_file', output: 'первая строка',
        },
      },
    }),
    ...normalize({
      method: 'item/completed',
      params: { item: { type: 'ещёНеизвестныйТип', id: 'new-1', arguments: { a: 1 } } },
    }),
  ];

  const tool = steps.find((step) => step.k === 'tool' && step.id === 'fn-1');
  assert.equal(tool?.name, 'read_file');
  assert.ok(steps.some((step) => step.k === 'res' && step.id === 'fn-1'));
  const future = steps.find((step) => step.k === 'tool' && step.id === 'new-1');
  assert.equal(future?.name, 'ещёНеизвестныйТип');
  assert.equal(future?.title, '{"a":1}');
});

test('Codex imageView приходит строкой Read с путём картинки', () => {
  // Лента показывает рассмотренную картинку по общему правилу строки Read, поэтому
  // просмотр у Codex обязан прийти тем же видом шага, а не безымянным fallback.
  const normalize = createCodexStepNormalizer();
  const steps = normalize({
    method: 'item/completed',
    params: {
      item: {
        type: 'imageView',
        id: 'img-1',
        path: '/repo/.state/artifacts/shot.png',
      },
    },
  });

  assert.deepEqual(steps.find((step) => step.k === 'tool'), {
    k: 'tool',
    id: 'img-1',
    name: 'Read',
    title: 'shot.png',
    sub: '/repo/.state/artifacts/shot.png',
  });
  assert.equal(steps.find((step) => step.k === 'res')?.ok, true);
});

test('Codex imageGeneration приходит строкой GenerateImage без base64', () => {
  // Codex кладёт байты картинки в `result`; в ленту и историю они попадать не должны —
  // строка несёт путь сохранённого файла, а итог — общую заглушку картинки.
  const normalize = createCodexStepNormalizer();
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAB'.repeat(40);
  const steps = [
    ...normalize({
      method: 'item/started',
      params: {
        item: {
          type: 'imageGeneration',
          id: 'gen-1',
          status: 'inProgress',
          result: '',
        },
      },
    }),
    ...normalize({
      method: 'item/completed',
      params: {
        item: {
          type: 'imageGeneration',
          id: 'gen-1',
          status: 'completed',
          revisedPrompt: 'Рыжий кот на подоконнике',
          savedPath: '/home/u/.codex/generated_images/t-1/exec-1.png',
          result: base64,
        },
      },
    }),
  ];
  const tools = steps.filter((step) => step.k === 'tool');

  assert.deepEqual(tools.at(-1), {
    k: 'tool',
    id: 'gen-1',
    name: 'GenerateImage',
    title: 'Рыжий кот на подоконнике',
    sub: '/home/u/.codex/generated_images/t-1/exec-1.png',
  });
  assert.deepEqual(steps.find((step) => step.k === 'res'), {
    k: 'res',
    id: 'gen-1',
    ok: true,
    text: STEP_IMAGE_TEXT,
    lines: 1,
  });
  assert.equal(JSON.stringify(steps).includes('iVBORw0KGgo'), false);
});

test('Codex события без вызова показываются служебной строкой', () => {
  const normalize = createCodexStepNormalizer();
  const steps = [
    ...normalize({ method: 'item/completed', params: { item: { type: 'contextCompaction', id: 'c-1' } } }),
    ...normalize({
      method: 'item/completed',
      params: {
        item: {
          type: 'subAgentActivity', id: 's-1', kind: 'completed', agentPath: 'ревьювер',
        },
      },
    }),
    ...normalize({
      method: 'model/rerouted',
      params: { fromModel: 'gpt-a', toModel: 'gpt-b', reason: 'highRiskCyberActivity' },
    }),
  ];

  const notes = steps.filter((step) => step.k === 'note').map((step) => step.text);
  assert.equal(steps.filter((step) => step.k === 'tool').length, 0);
  assert.match(notes[0], /сжал контекст/);
  assert.match(notes[1], /Субагент ревьювер/);
  assert.match(notes[2], /gpt-a → gpt-b/);
});

test('Codex дополняет уже показанную правку и не обедняет её при завершении', () => {
  const normalize = createCodexStepNormalizer();
  const grow = (paths) => paths.map((file) => ({
    path: file,
    kind: { type: 'update' },
    diff: '@@\n-1\n+2\n',
  }));
  const full = grow(['a.py', 'b.py', 'c.py']);
  const steps = [
    ...normalize({
      method: 'item/started',
      params: {
        item: {
          type: 'fileChange', id: 'fc-1', changes: grow(['a.py']), status: 'inProgress',
        },
      },
    }),
    ...normalize({
      method: 'item/fileChange/patchUpdated',
      params: { itemId: 'fc-1', changes: full },
    }),
    ...normalize({
      method: 'item/completed',
      params: {
        item: {
          type: 'fileChange', id: 'fc-1', changes: full, status: 'completed',
        },
      },
    }),
  ];

  const tools = steps.filter((step) => step.k === 'tool');
  // Правка видна сразу (патч уже на диске), а дошедший позже полный набор её дополняет.
  assert.deepEqual(tools.map((step) => step.title), ['a.py', '3 файлов']);
  assert.deepEqual(tools.at(-1).files, ['a.py', 'b.py', 'c.py']);
  // Завершение без новых данных второй строки не плодит.
  assert.equal(steps.filter((step) => step.k === 'res').length, 1);
});

test('Codex ретрай сети читается человеком, а не сырым JSON', () => {
  const normalize = createCodexStepNormalizer();
  const [note] = normalize({
    method: 'error',
    params: {
      willRetry: true,
      threadId: 'thread-1',
      error: {
        message: 'Reconnecting... 2/5',
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
        additionalDetails: 'stream disconnected before completion: tls handshake eof',
        misalignment: null,
      },
    },
  });

  assert.equal(note.k, 'note');
  assert.equal(note.level, 'warn');
  assert.match(note.text, /Codex повторит запрос\. Reconnecting\.\.\. 2\/5/);
  assert.doesNotMatch(note.text, /codexErrorInfo/);
});

test('Codex executor передаёт JSONL-шаги живьём и сохраняет их в результате', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-codex-stream-'));
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
  // Расход хода — это output_tokens целиком: рассуждения уже входят в него (в аналитике
  // они атрибут той же метрики output_tokens). Вторым слагаемым они удваивали счётчик.
  assert.deepEqual(progress, [3]);
});

test('Claude Agent описывается как Task, включая тип без описания и вложенные события', () => {
    for (const name of ['Agent', 'Task']) {
        for (const description of ['Проверить чат', '']) {
            const input = {
                description,
                subagent_type: 'Explore',
                prompt: 'Найди причину сдвига'
            };
            const [step] = toClaudeSteps({
                type: 'assistant',
                message: {
                    content: [{
                        type: 'tool_use',
                        id: 'agent',
                        name,
                        input
                    }]
                }
            });

            assert.deepEqual(step, {
                k: 'tool',
                id: 'agent',
                name,
                title: description || 'Explore',
                sub: 'Explore',
                preview: input.prompt
            });
        }
    }

    const sent = [];
    const sink = createStepSink((step) => sent.push(step), {
        now: () => 10
    });

    sink.emitAll(toClaudeSteps({
        type: 'assistant',
        parent_tool_use_id: 'agent',
        message: {
            content: [{
                type: 'tool_use',
                id: 'child',
                name: 'Bash',
                input: {
                        command: 'pwd'
                    }
            }]
        }
    }));
    assert.equal(sent[0].parent, 'agent');
    assert.deepEqual(sent, sink.steps);
});
