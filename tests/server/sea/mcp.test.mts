import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as httpServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { helperFixture, runFile } from './helperFixture.mts';

interface RpcResult {
  id: number;
  result: {
    serverInfo: { name: string };
    tools: Array<{ name: string }>;
    content: Array<{ text: string }>;
  };
}

/**
 * Выполняет полный stdio-обмен с собранной программой и ждёт её завершения.
 * Ошибка процесса включает stderr, а успешный код сам по себе протокол не подтверждает.
 */
async function exchange(t: TestContext, node: string, entry: string, args: string[],
  env: NodeJS.ProcessEnv, tool: string): Promise<RpcResult[]> {
  const child = spawn(node, [entry, ...args], {
    cwd: '/',
    env: { PATH: '/nonexistent', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';

  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const messages = [
    {
      id: 1,
      method: 'initialize',
      params: {},
    },
    { id: 2, method: 'tools/list' },
    {
      id: 3,
      method: 'tools/call',
      params: { name: tool, arguments: { marker: 'scope' } },
    },
  ];
  const input = messages.map((message) => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n');

  child.stdin.end(`${input}\n`);

  const [code] = await once(child, 'close');

  assert.equal(code, 0, stderr);

  return stdout.trim().split('\n').map((line) => JSON.parse(line) as RpcResult);
}

test('SEA-MCP-01: собранные permission/work MCP сохраняют scope и отказывают чужому nonce', {
  timeout: 20000,
}, async (t) => {
  const fixture = await helperFixture(t, ['chat-permission-mcp', 'work-mcp']);
  const permissionRequests: Array<{ key: string | undefined; body: { chatKey: string } }> = [];
  const broker = httpServer((request, response) => {
    let body = '';

    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      permissionRequests.push({
        key: request.headers['x-grigdesk-internal'] as string | undefined,
        body: JSON.parse(body),
      });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ behavior: 'allow' }));
    });
  });

  broker.listen(0, '127.0.0.1');
  await once(broker, 'listening');
  t.after(() => new Promise<void>((resolve) => broker.close(() => resolve())));

  const address = broker.address() as { port: number };
  const permission = await exchange(t, fixture.node, fixture.entry('chat-permission-mcp'), [], {
    GRIGDESK_PERM_URL: `http://127.0.0.1:${address.port}/permission`,
    GRIGDESK_CHAT_KEY: 'fixture-chat',
    GRIGDESK_INTERNAL: 'fixture-secret',
  }, 'approve');

  assert.equal(permission[0]!.result.serverInfo.name, 'grigdesk-perm');
  assert.deepEqual(permission[1]!.result.tools.map((tool) => tool.name), ['approve']);
  assert.equal(JSON.parse(permission[2]!.result.content[0]!.text).behavior, 'allow');
  assert.equal(permissionRequests.length, 1);
  assert.equal(permissionRequests[0]!.key, 'fixture-secret');
  assert.equal(permissionRequests[0]!.body.chatKey, 'fixture-chat');

  const socketPath = path.join(fixture.temporary, 'work.sock');
  const received: Array<{
    nonce: string;
    type?: string;
    name?: string;
  }> = [];
  const socket = netServer((connection) => {
    let body = '';

    connection.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    connection.on('end', () => {
      const request = JSON.parse(body) as (typeof received)[number];

      received.push(request);

      if (request.nonce !== 'fixture-nonce') {
        connection.end(JSON.stringify({ error: 'nonce не совпал' }));

        return;
      }

      const result = request.type === 'descriptors'
        ? [{
          name: 'fixture-echo',
          description: 'Echo',
          inputSchema: { type: 'object' },
        }]
        : { echoed: true };

      connection.end(JSON.stringify({ result }));
    });
  });

  socket.listen(socketPath);
  await once(socket, 'listening');
  t.after(() => new Promise<void>((resolve) => socket.close(() => resolve())));

  const work = await exchange(t, fixture.node, fixture.entry('work-mcp'), [
    '--socket', socketPath, '--nonce', 'fixture-nonce',
  ], {}, 'fixture-echo');

  assert.deepEqual(work[1]!.result.tools.map((tool) => tool.name), ['fixture-echo']);
  assert.deepEqual(JSON.parse(work[2]!.result.content[0]!.text), { echoed: true });
  assert.equal(received.every((request) => request.nonce === 'fixture-nonce'), true);
  assert.equal(received.at(-1)!.name, 'fixture-echo');
  await assert.rejects(runFile(fixture.node, [fixture.entry('work-mcp'),
    '--socket', socketPath, '--nonce', 'wrong',
  ], { env: { PATH: '/nonexistent' }, timeout: 5000 }), /nonce/);
});
