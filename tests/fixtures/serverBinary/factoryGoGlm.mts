import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { runGlmFactory } from '../../../server/scripts/glmRunner.mts';
import { glmCompatibilityIdentity } from '../../../server/src/lib/glm/contract.ts';
import { glmFactoryToolInventory } from '../../../server/src/lib/glm/factoryPolicy.ts';
import { preparedGlmRuntime } from '../../../server/src/lib/glm/preparedRuntime.ts';
import { runGlmTurn } from '../../../server/src/lib/glm/runtime.ts';
import { startGlmLoopback } from '../../helpers/glmLoopback.mts';
import {
  GLM_SERVICE_KEY,
  glmTextReply,
  glmToolCall,
  writeGlmEgressGuard,
} from '../../helpers/glmProductionFixture.mts';

const argv = process.argv.slice(2);
const runDir = argv[argv.indexOf('--run-dir') + 1];
const browser = process.env.GRIGDESK_DEEPSEEK_TEST_EXPECT_BROWSER === '1';
const [progress, result, browserTool] = glmFactoryToolInventory(browser);
const calls: [string, Record<string, unknown>][] = [
  [progress, { updates: [{ key: 'SIZE', value: 'M' }] }],
  [result, { result: 'done', comment: 'Ответ loopback принят фабрикой' }],
];

if (browser) {
  calls.unshift([browserTool, { action: 'list' }]);
}

const server = await startGlmLoopback({
  expectedKey: GLM_SERVICE_KEY,
  respond: (payload, index) => {
    const call = calls[index];

    if (!call) {
      return glmTextReply('Принято тестовым рантаймом.');
    }

    assert.ok(Array.isArray(payload.tools) && payload.tools.some((tool) => tool.function?.name === call[0]),
      `GLM не объявил инструмент ${call[0]}`);

    return glmToolCall(call[0], call[1], `go-offline-${index}`);
  },
});

try {
  const env = { ...process.env, ZAI_API_KEY: GLM_SERVICE_KEY };
  const egressGuard = await writeGlmEgressGuard(runDir);
  const helper = process.env.GRIGDESK_DEEPSEEK_TEST_COMPILED_MCP;

  await runGlmFactory(argv, env, {
    runTurn: async (options) => {
      const context = options.factoryContext;
      const runtime = await preparedGlmRuntime(options.config, options.preparedRuntime);
      const inputs = runtime.metadata?.glm?.inputs;

      assert.ok(context && helper && inputs);
      context.statusServer.command = process.execPath;
      context.statusServer.args = [helper];

      return runGlmTurn(options, {
        env,
        admission: [{ mode: 'api', compatibility: glmCompatibilityIdentity(inputs, 'api') }],
        modelEndpoint: server.endpoint,
        egressGuard,
      });
    },
  });
  server.assertComplete();
  await writeFile(path.join(runDir, 'loopback.count'), `${server.requests.length}\n`, { mode: 0o600 });
} finally {
  await server.stop();
}
