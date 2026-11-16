import assert from 'node:assert/strict';
import test from 'node:test';

import { createQwenBackground } from '../../server/src/lib/qwen/background.ts';
import { qwenAdapter, qwenFixture, runInput } from '../helpers/qwenFixture.mjs';

const lspFailure = 'LSP document symbols failed: language server unavailable';
const cases = [
  {
    name: 'штатный LSP сообщает ошибку при completed',
    toolName: 'lsp',
    provenance: 'builtin',
    output: lspFailure,
    status: 'completed',
    failed: true,
  },
  {
    name: 'файловый текст не становится ошибкой по содержимому',
    toolName: 'read_file',
    provenance: 'builtin',
    output: lspFailure,
    status: 'completed',
    failed: false,
  },
  {
    name: 'MCP не выдаётся за штатный LSP',
    toolName: 'lsp',
    provenance: 'mcp',
    output: lspFailure,
    status: 'completed',
    failed: false,
  },
  {
    name: 'символ с текстом ошибки остаётся успешным результатом',
    toolName: 'lsp',
    provenance: 'builtin',
    output: `Document symbols for sample.probe:\n1. ${lspFailure}`,
    status: 'completed',
    failed: false,
  },
  {
    name: 'native failed остаётся ошибкой',
    toolName: 'read_file',
    provenance: 'builtin',
    output: 'ENOENT',
    status: 'failed',
    failed: true,
  },
];

/**
 * Один и тот же native update проходит реальные foreground и background коллекторы.
 * Только foreground поднимает тестовый CLI в собственных временных каталогах.
 */
async function collectResult(t, entry, background) {
  const stream = [{
    sessionUpdate: 'tool_call',
    toolCallId: 'native-result',
    title: entry.toolName,
  }, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'native-result',
    status: entry.status,
    _meta: { toolName: entry.toolName, provenance: entry.provenance },
    rawOutput: entry.output,
    content: [{ type: 'content', content: { type: 'text', text: entry.output } }],
  }];
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
    const fixture = await qwenFixture(t);
    const adapter = await qwenAdapter({ runnable: true });

    await fixture.fake({ stream });
    result = await adapter.run(runInput(fixture, 'shared-model(openai)'));
  }

  return result.steps.filter((step) => step.k === 'res');
}

for (const background of [false, true]) {
  for (const entry of cases) {
    test(`Qwen: ${entry.name}, background=${background}`, async (t) => {
      const results = await collectResult(t, entry, background);

      assert.equal(results.length, 1);
      assert.equal(results[0].error, entry.failed);
      assert.equal(results[0].ok, !entry.failed);
    });
  }
}
