import assert from 'node:assert/strict';
import {
  spawn
} from 'node:child_process';
import {
  promises as fs
} from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  createAcpClient
} from '../../server/src/lib/acp/client.ts';
import {
  createWorkIpc
} from '../../server/src/lib/executors/workIpc.ts';
import {
  makeGigaCodeFixture
} from '../helpers/gigacode/fixture.mjs';

test('fake CLI исполняет ACP и получает prompt через stdin без сети и аккаунта', async (t) => {
  const fixture = await makeGigaCodeFixture(t);
  const child = spawn(fixture.config.gigacodeBin, ['--acp'], {
    cwd: fixture.workspace,
    env: {
      HOME: fixture.home,
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const updates = [];
  const client = createAcpClient(child, {
    onNotification: (method, params) => updates.push({
      method,
      params
    }),
    requestTimeoutMs: 2000,
  });

  t.after(() => {
    client.close();
    child.kill('SIGKILL');
  });

  const initialized = await client.request('initialize', {
    protocolVersion: 1
  });
  const session = await client.request('session/new', {
    cwd: fixture.workspace,
    mcpServers: []
  });
  const prompt = 'Кириллица; $(это данные), не команда';
  const result = await client.request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{
      type: 'text',
      text: prompt
    }],
  });
  const requests = (await fs.readFile(path.join(fixture.home, 'requests.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(initialized.agentInfo.name, 'gigacode');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(requests.at(-1).message.params.prompt[0].text, prompt);
  assert.equal(updates.at(-1).params.update.content.text, 'Ответ fixture');
  assert.equal(requests.some((entry) => entry.message?.method === 'authenticate'), false);
});

test('metadata discovery fake MCP не исполняет сценарные инструменты до prompt', async (t) => {
  let mutations = 0;
  const ipc = await createWorkIpc({
    workTools: {
      descriptors: [{
        name: 'mutate_fixture',
        description: 'Synthetic',
        inputSchema: {
          type: 'object'
        },
      }],
      invoke: async () => {
        mutations += 1;

        return {
          ok: true
        };
      },
    },
  });
  const fixture = await makeGigaCodeFixture(t, {
    mcpCalls: [{
      tool: 'mutate_fixture',
      arguments: {}
    }],
  });
  const child = spawn(fixture.config.gigacodeBin, ['--acp'], {
    cwd: fixture.workspace,
    env: {
      HOME: fixture.home,
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = createAcpClient(child, {
    requestTimeoutMs: 2000
  });

  t.after(async () => {
    client.close();
    child.kill('SIGKILL');
    await ipc.close();
  });
  await client.request('initialize', {
    protocolVersion: 1
  });

  const session = await client.request('session/new', {
    cwd: fixture.workspace,
    mcpServers: [{
      name: 'grigdesk-work',
      ...ipc.mcpServer
    }],
  });

  assert.equal(mutations, 0);

  await client.request('session/prompt', {
    sessionId: session.sessionId,
    prompt: []
  });

  assert.equal(mutations, 1);
});
