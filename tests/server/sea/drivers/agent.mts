import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { preferences, server } from './harness.mts';

const root = process.argv[2]!;

await preferences();
await writeFile('/D/fake-claude', '#!/bin/sh\n# claude-sonnet-4-6\n'
  + 'exec "$GRIGDESK_FIXTURE_NODE" /suite/fakeClaude.mjs "$@"\n', { mode: 0o755 });

const run = await server(root, {
  GRIGDESK_CLAUDE_BIN: '/D/fake-claude',
  GRIGDESK_FIXTURE_NODE: path.join(root, 'runtime/node/bin/node'),
  ANTHROPIC_API_KEY: 'fixture-no-network',
});
const modelRef = { provider: 'claude', model: 'claude-sonnet-4-6' };

try {
  await run.request('/api/chat/store/chat', 'PUT', {
    chat: {
      id: 'sea-fixture-chat',
      title: 'SEA fixture',
      modelRef,
      model: modelRef.model,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 0,
    },
  });
  await run.request('/api/chat', 'POST', {
    chatKey: 'sea-fixture-chat',
    turnId: 'sea-fixture-turn-0001',
    modelRef,
    model: modelRef.model,
    message: 'Выполни локальную проверку MCP.',
    sentAt: Date.now(),
  }, 202);

  const deadline = Date.now() + 45000;
  let pending;

  do {
    pending = await run.request('/api/chat/pending');

    if (JSON.stringify(pending).includes('SEA_MCP_SCOPE_OK')) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);

  assert.match(JSON.stringify(pending), /SEA_MCP_SCOPE_OK/, run.log());

  const evidence = JSON.parse(await readFile('/D/agent-evidence.json', 'utf8'));

  assert.deepEqual(evidence, { mcp: true, scope: true });
  console.log(JSON.stringify({ agentTurn: true, ...evidence }));
} finally {
  assert.equal((await run.stop()).code, 0, run.log());
}
