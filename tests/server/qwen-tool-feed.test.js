import assert from 'node:assert/strict';
import test from 'node:test';

import { createQwenBackground } from '../../server/src/lib/qwen/background.ts';
import { STEP_IMAGE_TEXT } from '../../shared/chat/chatSteps.ts';
import { foldChatSteps } from '../../web/src/views/chat/chatStepRows.ts';
import { runQwenPreviewStream } from '../helpers/qwenPreviewStream.mjs';

const textBlock = (text) => ({ type: 'content', content: { type: 'text', text } });

const resultUpdate = (content, status = 'completed') => ({
  sessionUpdate: 'tool_call_update',
  toolCallId: 'tool-feed',
  status,
  content,
});

const toolCall = (over = {}) => ({
  sessionUpdate: 'tool_call',
  toolCallId: 'tool-line',
  title: 'fixture',
  ...over,
});

/**
 * Один и тот же поток проходит реальные foreground и background коллекторы,
 * как в qwen-tool-results.test.js: форматирование обязано совпадать в обоих.
 */
async function collectResults(t, stream, background) {
  let result;

  if (background) {
    const collector = createQwenBackground('synthetic-session', {
      onBackground: (value) => {
        result = value;
      },
    });

    for (const update of stream) {
      collector.observe(update);
    }

    await collector.finish('end_turn');
  } else {
    result = await runQwenPreviewStream(t, stream);
  }

  return result.steps.filter((step) => step.k === 'res');
}

/**
 * Строки вызова собираются тем же двойным прогоном: ход через границу ACP и фоновый коллектор обязаны рисовать одинаковую строку инструмента.
 */
async function collectToolFeed(t, stream, background) {
  let result;

  if (background) {
    const collector = createQwenBackground('synthetic-session', {
      onBackground: (value) => {
        result = value;
      },
    });

    for (const update of stream) {
      collector.observe(update);
    }

    await collector.finish('end_turn');
  } else {
    result = await runQwenPreviewStream(t, stream);
  }

  return result.steps;
}

const cases = [
  {
    name: 'текст блока показан вместо wire-JSON',
    stream: [resultUpdate([textBlock('Recorded artifact "PR #49"')])],
    check: (res) => {
      assert.equal(res.text, 'Recorded artifact "PR #49"');
      assert.equal(res.lines, 1);
    },
  },
  {
    name: 'несколько блоков склеены переводом строки',
    stream: [resultUpdate([textBlock('первый'), textBlock('второй')])],
    check: (res) => {
      assert.equal(res.text, 'первый\nвторой');
      assert.equal(res.lines, 2);
    },
  },
  {
    name: 'картинка становится заглушкой без base64',
    stream: [resultUpdate([{
      type: 'content',
      content: {
        type: 'image',
        data: 'QUJDRA==',
        mimeType: 'image/png',
      },
    }])],
    check: (res) => {
      assert.equal(res.text, STEP_IMAGE_TEXT);
      assert.equal(JSON.stringify(res).includes('QUJDRA=='), false);
    },
  },
  {
    name: 'успешный итог обрезан до 400 символов',
    stream: [resultUpdate([textBlock('я'.repeat(5000) + '\nхвост')])],
    check: (res) => {
      assert.equal(res.text.length, 401);
      assert.ok(res.text.endsWith('…'));
      assert.equal(res.lines, 2);
    },
  },
  {
    name: 'ошибка обрезана до 600 символов',
    stream: [resultUpdate([textBlock('о'.repeat(5000))], 'failed')],
    check: (res) => {
      assert.equal(res.ok, false);
      assert.equal(res.text.length, 601);
    },
  },
  {
    name: 'без текста итог называет пути диффов',
    stream: [resultUpdate([{
      type: 'diff',
      path: '/w/a.ts',
      oldText: 'a',
      newText: 'b',
    }])],
    check: (res) => {
      assert.equal(res.text, '/w/a.ts');
    },
  },
  {
    name: 'дубль terminal не плодит второй итог',
    stream: [
      resultUpdate([textBlock('Готово')]),
      resultUpdate([textBlock('Готово')]),
    ],
    check: (res, all) => {
      assert.equal(all.length, 1);
      assert.equal(res.text, 'Готово');
    },
  },
];

for (const background of [false, true]) {
  for (const entry of cases) {
    test(`Qwen лента: ${entry.name}, background=${background}`, async (t) => {
      const results = await collectResults(t, entry.stream, background);

      assert.equal(results.length, 1);
      entry.check(results[0], results);
    });
  }
}

const lineCases = [
  {
    name: 'execute рисует Bash с командой',
    stream: [toolCall({
      title: 'run_shell_command',
      kind: 'execute',
      rawInput: { command: 'git status' },
    })],
    check: (tool) => {
      assert.equal(tool.name, 'Bash');
      assert.equal(tool.title, 'git status');
      assert.equal(tool.command, 'git status');
    },
  },
  {
    name: 'read рисует Read с путём',
    stream: [toolCall({
      title: 'read_file',
      kind: 'read',
      rawInput: { file_path: '/w/main.ts' },
    })],
    check: (tool) => {
      assert.equal(tool.name, 'Read');
      assert.equal(tool.sub, '/w/main.ts');
    },
  },
  {
    name: 'edit рисует дифф и files из rawInput',
    stream: [toolCall({
      title: 'edit',
      kind: 'edit',
      rawInput: {
        file_path: '/w/a.ts',
        old_string: 'было',
        new_string: 'стало',
      },
    })],
    check: (tool) => {
      assert.equal(tool.name, 'Edit');
      assert.deepEqual(tool.files, ['/w/a.ts']);
      assert.deepEqual(tool.changes, [{
        path: '/w/a.ts',
        kind: 'update',
        diff: { old: 'было', new: 'стало' },
      }]);
      assert.equal(tool.preview, '');
    },
  },
  {
    name: 'MCP сохраняет имя и превью аргументов',
    stream: [toolCall({
      title: 'mcp__srv__lookup',
      kind: 'other',
      rawInput: { query: 'q' },
    })],
    check: (tool) => {
      assert.equal(tool.name, 'mcp__srv__lookup');
      assert.equal(tool.preview, JSON.stringify({ query: 'q' }));
    },
  },
  {
    name: 'досылка аргументов обновляет ту же строку',
    stream: [
      toolCall({ title: 'edit', kind: 'edit' }),
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-line',
        status: 'in_progress',
        rawInput: {
          file_path: '/w/a.ts',
          old_string: 'было',
          new_string: 'стало',
        },
      },
    ],
    check: (tool, all) => {
      assert.equal(all.length, 2);
      assert.equal(all[0].id, all[1].id);
      assert.deepEqual(all[1].files, ['/w/a.ts']);
      assert.equal(all[1].preview, '');
    },
  },
  {
    name: 'вторая порция rawInput дочитывает строку',
    stream: [
      toolCall({
        title: 'edit',
        kind: 'edit',
        rawInput: { file_path: '/w/a.ts' },
      }),
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-line',
        status: 'in_progress',
        rawInput: { old_string: 'было', new_string: 'стало' },
      },
    ],
    check: (tool, all) => {
      assert.equal(all.length, 2);
      assert.deepEqual(all[1].changes, [{
        path: '/w/a.ts',
        kind: 'update',
        diff: { old: 'было', new: 'стало' },
      }]);
    },
  },
  {
    name: 'sparse kind other не понижает накопленный edit',
    stream: [
      toolCall({
        title: 'edit',
        kind: 'edit',
        rawInput: {
          file_path: '/w/a.ts',
          old_string: 'было',
          new_string: 'стало',
        },
      }),
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-line',
        status: 'in_progress',
        kind: 'other',
        rawInput: { new_string: 'новая правка' },
      },
    ],
    check: (tool, all) => {
      assert.equal(all.length, 2);
      assert.equal(all[0].id, tool.id);
      assert.equal(tool.name, 'Edit');
      assert.deepEqual(tool.files, ['/w/a.ts']);
      assert.deepEqual(tool.changes[0].diff, { old: 'было', new: 'новая правка' });
    },
  },
  {
    name: 'sparse title other сохраняет имя MCP после обогащения',
    stream: [
      toolCall({
        kind: 'other',
        title: 'mcp__srv__lookup',
        rawInput: { query: 'до' },
      }),
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-line',
        title: 'other',
        rawInput: { query: 'после' },
      },
    ],
    check: (tool, all) => {
      assert.equal(all.length, 2);
      assert.equal(all[0].id, tool.id);
      assert.equal(tool.name, 'mcp__srv__lookup');
      assert.equal(tool.title, 'mcp__srv__lookup');
      assert.equal(tool.preview, '{"query":"после"}');
    },
  },
  {
    name: 'изменение command при прежних ключах обновляет строку',
    stream: [
      toolCall({ kind: 'execute', rawInput: { command: 'git' } }),
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-line',
        rawInput: { command: 'git status' },
      },
    ],
    check: (tool, all) => {
      assert.equal(all.length, 2);
      assert.equal(tool.command, 'git status');
      assert.equal(tool.title, 'git status');
    },
  },
  {
    name: 'путь приходит только через locations',
    stream: [
      toolCall({ kind: 'read', title: 'read_file' }),
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-line',
        locations: [{ path: '/w/late.ts' }],
      },
    ],
    check: (tool, all) => {
      assert.equal(all.length, 2);
      assert.equal(tool.name, 'Read');
      assert.equal(tool.title, 'late.ts');
      assert.equal(tool.sub, '/w/late.ts');
    },
  },
  {
    name: 'повышение kind без новых ключей очищает старое preview',
    stream: [
      toolCall({ kind: 'other', rawInput: { file_path: '/w/main.ts' } }),
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-line',
        kind: 'read',
        title: 'read_file',
      },
    ],
    check: (tool, all) => {
      assert.equal(all.length, 2);
      assert.equal(tool.name, 'Read');
      assert.equal(tool.sub, '/w/main.ts');
      assert.equal(tool.preview, '');
    },
  },
  {
    name: 'отдельная досылка title обновляет имя MCP',
    stream: [
      toolCall({
        kind: 'other',
        title: 'fixture',
        rawInput: { query: 'q' },
      }),
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-line',
        title: 'mcp__srv__lookup',
      },
    ],
    check: (tool, all) => {
      assert.equal(all.length, 2);
      assert.equal(tool.name, 'mcp__srv__lookup');
      assert.equal(tool.title, 'mcp__srv__lookup');
    },
  },
  {
    name: 'точный дубль tool не выпускает второй снимок',
    stream: [
      toolCall({ kind: 'execute', rawInput: { command: 'git status' } }),
      toolCall({ kind: 'execute', rawInput: { command: 'git status' } }),
    ],
    check: (tool, all) => {
      assert.equal(all.length, 1);
      assert.equal(tool.command, 'git status');
    },
  },
  ...[
    { rawInput: { file_path: '/w/b.ts' } },
    {
      rawInput: { file_path: '/w/b.ts' },
      locations: [{ path: '/w/b.ts' }],
    },
    { locations: [{ path: '/w/b.ts' }] },
  ].map((update, index) => ({
    name: `Read заменяет прежний путь, вариант=${index}`,
    stream: [
      toolCall({
        kind: 'read',
        title: 'read_file',
        rawInput: { file_path: '/w/a.ts' },
        locations: [{ path: '/w/a.ts' }],
      }),
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-line',
        ...update,
      },
    ],
    check: (tool, all) => {
      assert.equal(all.length, 2);
      assert.equal(tool.id, all[0].id);
      assert.equal(tool.name, 'Read');
      assert.equal(tool.title, 'b.ts');
      assert.equal(tool.sub, '/w/b.ts');
    },
  })),
  {
    name: 'Read использует путь, изменённый до определения kind',
    stream: [
      toolCall({
        kind: 'other',
        rawInput: { file_path: '/w/a.ts' },
        locations: [{ path: '/w/a.ts' }],
      }),
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-line',
        rawInput: { file_path: '/w/b.ts' },
        locations: [{ path: '/w/b.ts' }],
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-line',
        kind: 'read',
        title: 'read_file',
      },
    ],
    check: (tool, all) => {
      assert.equal(all.length, 3);
      assert.equal(tool.id, all[0].id);
      assert.equal(tool.name, 'Read');
      assert.equal(tool.title, 'b.ts');
      assert.equal(tool.sub, '/w/b.ts');
      assert.equal(tool.preview, '');
    },
  },
  {
    name: 'Edit сохраняет накопление разных файлов',
    stream: [
      toolCall({
        kind: 'edit',
        content: [{
          type: 'diff',
          path: '/w/a.ts',
          oldText: 'a',
          newText: 'b',
        }],
      }),
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-line',
        content: [{
          type: 'diff',
          path: '/w/b.ts',
          oldText: 'c',
          newText: 'd',
        }],
      },
    ],
    check: (tool, all) => {
      assert.equal(all.length, 2);
      assert.equal(tool.name, 'Edit');
      assert.deepEqual(tool.files, ['/w/a.ts', '/w/b.ts']);
      assert.equal(tool.changes.length, 2);
    },
  },
  {
    name: 'terminal текст не становится командой sparse execute',
    stream: [
      toolCall({ kind: 'execute', title: 'run_shell_command' }),
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-line',
        status: 'completed',
        content: [textBlock('Готово')],
      },
    ],
    check: (tool, all, steps) => {
      const results = steps.filter((step) => step.k === 'res');

      assert.equal(all.length, 1);
      assert.equal(tool.command, '');
      assert.equal(tool.title, 'run_shell_command');
      assert.equal(tool.preview, 'run_shell_command');
      assert.equal(results.length, 1);
      assert.equal(results[0].id, tool.id);
      assert.equal(results[0].text, 'Готово');
      assert.equal(results[0].ok, true);
    },
  },
  {
    name: 'terminal rawInput обогащает команду отдельно от текста итога',
    stream: [
      toolCall({ kind: 'execute', rawInput: { command: 'git' } }),
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-line',
        status: 'completed',
        rawInput: { command: 'git status' },
        content: [textBlock('Готово')],
      },
    ],
    check: (tool, all, steps) => {
      const results = steps.filter((step) => step.k === 'res');

      assert.equal(all.length, 2);
      assert.equal(tool.command, 'git status');
      assert.equal(tool.title, 'git status');
      assert.equal(results.length, 1);
      assert.equal(results[0].text, 'Готово');
    },
  },
];

for (const background of [false, true]) {
  for (const entry of lineCases) {
    test(`Qwen строка: ${entry.name}, background=${background}`, async (t) => {
      const steps = await collectToolFeed(t, entry.stream, background);
      const tools = steps.filter((step) => step.k === 'tool');
      const rows = foldChatSteps(JSON.parse(JSON.stringify(tools)));

      assert.ok(tools.length >= 1);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 'tool-line');
      assert.equal(rows[0].name, tools.at(-1).name);
      assert.equal(rows[0].preview, tools.at(-1).preview);
      entry.check(tools.at(-1), tools, steps);
      entry.check(rows[0], tools, steps);
    });
  }
}
