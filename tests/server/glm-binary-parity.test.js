import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { ensureTestDeepSeekBinary } from '../helpers/deepseekBinary.mts';
import { createGlmBinaryFixtureRoot } from '../helpers/glmBinary.mts';
import { runGlmTurn } from '../helpers/glmDriver.mts';
import { startGlmLoopback } from '../helpers/glmLoopback.mts';
import { deepSeekProductionChatFixture } from '../helpers/deepseekChatParity.mjs';
import {
  GLM_SERVICE_KEY,
  glmTextReply,
  startGlmProductionProcess,
} from '../helpers/glmProductionFixture.mts';

test('production fixture GLM выбирает ELF/cache без legacy generation', { timeout: 900000 }, async (t) => {
  const candidate = await ensureTestDeepSeekBinary();
  const root = await createGlmBinaryFixtureRoot('glm-parity-');
  const cwd = path.join(root, 'project');
  const mock = await startGlmLoopback({ expectedKey: GLM_SERVICE_KEY, respond: () => glmTextReply() });
  let started;

  t.after(async () => {
    try {
      await started?.server.stop();
      await mock.stop();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  await fs.mkdir(cwd);

  started = await startGlmProductionProcess({
    artifact: path.join(root, 'missing-legacy'),
    runtimeConfig: {
      deepseekRuntimeMode: 'binary',
      deepseekBin: candidate.binary,
      deepseekCacheDir: candidate.cacheDir,
    },
    root,
    cwd,
    endpoint: mock.endpoint,
  });

  const result = await runGlmTurn(started.server, {
    cwd,
    message: 'glm-parity',
    model: 'glm-5.3',
  });

  assert.equal(result.turnEnd.data.reason.kind, 'completed');
  assert.equal(started.runtime.kind, 'binary');
  assert.equal(started.runtime.command, candidate.binary);
  assert.ok(started.runtime.prefixArgs.includes(candidate.cacheDir));
  assert.equal(mock.requests.length, 1);
});

test('один ELF: DeepSeek не монтирует GLM plugin в своём production ходе', {
  timeout: 900000,
}, async (t) => {
  const candidate = await ensureTestDeepSeekBinary();
  const f = await deepSeekProductionChatFixture(t, undefined, { mode: 'binary', candidate });
  let namespaces;
  const result = await f.run({
    startServer: async (options) => {
      const server = await f.startServer(options);
      const description = await server.client.rpc('settings/describe');

      namespaces = description.namespaces.map((namespace) => namespace.ns);

      return server;
    },
  });

  assert.equal(result.reply, 'loopback-ok');
  assert.ok(namespaces.includes('llm-deepseek'), 'Положительный контроль DeepSeek provider');
  assert.equal(namespaces.includes('llm-pi-ai'), false);
  assert.equal(f.mock.payloads.length, 1);
});

// Эти же файлы отдельно прогоняются на embedded: меняется только выбор fixture.
// Дочерних test-runner и другой реализации Harness этот entrypoint не создаёт.
process.env.GRIGDESK_TEST_GLM_DELIVERY = 'binary';

for (const part of ['profile', 'turn', 'policy', 'mcp', 'catalog', 'session', 'stop', 'gate', 'subagents']) {
  await import(`./glm-vendored-${part}.test.js`);
}
