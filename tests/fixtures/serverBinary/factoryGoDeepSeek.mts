import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { runDeepSeekFactory } from '../../../server/scripts/deepseekRunner.mts';
import { prepareDeepSeekLaunch, runDeepSeekTurn } from '../../../server/src/lib/deepseek/runtime.ts';
import { deepSeekFactoryPort } from '../../server/binary/drivers/providerPorts.mjs';
import { startDeepSeekLoopback } from '../../helpers/deepseekLoopback.mts';

const argv = process.argv.slice(2);
const runIndex = argv.indexOf('--run-dir');
const runDirectory = argv[runIndex + 1];

assert.ok(runIndex >= 0 && runDirectory, 'фикстуре нужен --run-dir');

const browser = process.env.GRIGDESK_DEEPSEEK_TEST_EXPECT_BROWSER === '1';
const peer = await startDeepSeekLoopback({
  respond: async (payload, index) => {
    if (!browser) {
      assert.ok(!payload.tools.some((item: { function: { name: string } }) =>
        item.function.name.endsWith('grigdesk_browser')));
    }

    const stageIndex = browser ? index - 1 : index;

    if (stageIndex > 1) {
      return { deltas: [{ content: 'Принято тестовым рантаймом.' }] };
    }

    const name = stageIndex === -1 ? 'grigdesk_browser'
      : stageIndex === 0 ? 'stage_progress' : 'stage_result';
    const tool = payload.tools.find((item: { function: { name: string } }) =>
      item.function.name.endsWith(name));

    assert.ok(tool, 'инструмент объявляет штатный MCP-клиент DeepSeek');

    const args = stageIndex === -1 ? { action: 'list' }
      : stageIndex === 0 ? { updates: [{ key: 'SIZE', value: 'M' }] }
      : { result: 'done', comment: 'Ответ loopback принят фабрикой' };
    const call = {
      index: 0,
      id: `go-offline-${index}`,
      type: 'function',
      function: {
        name: tool.function.name,
        arguments: JSON.stringify(args),
      },
    };

    return { deltas: [{ tool_calls: [call] }], finishReason: 'tool_calls' };
  },
});

try {
  // Реальные wrapper, ACP и файлы native runtime. DI меняет только тестовый endpoint.
  const runTurn = deepSeekFactoryPort({ runDeepSeekTurn, prepareDeepSeekLaunch }, peer.endpoint);

  await runDeepSeekFactory(argv, process.env, {
    runTurn: (options) => {
      const helper = process.env.GRIGDESK_DEEPSEEK_TEST_COMPILED_MCP;

      if (helper) {
        const status = options.mcpServers?.[0];

        assert.ok(status);
        status.command = process.execPath;
        status.args = [helper];
      }

      return runTurn(options);
    },
  });
  await writeFile(path.join(runDirectory, 'loopback.count'), `${peer.payloads.length}\n`, { mode: 0o600 });
} finally {
  await peer.stop();
}
