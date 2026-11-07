import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const argv = process.argv.slice(2);
const execute = promisify(execFile);
const sessionId = 'sea-fixture-session';

/**
 * Синтетический CLI обслуживает только локальные discovery и stream-json.
 * Модель не вызывается, результат выдаётся после настоящего MCP и проверки scope.
 */
async function main() {
  if (argv.includes('--version')) {
    console.log('2.1.1 (Claude Code)');

    return;
  }

  if (argv.includes('--help')) {
    console.log('--permission-mode <mode> --settings <json>');

    return;
  }

  if (argv.includes('__ask__')) {
    console.log('Allowed choices are default, acceptEdits, plan.');

    return;
  }

  assert.equal(argv[argv.indexOf('--input-format') + 1], 'stream-json');

  const input = createInterface({ input: process.stdin });

  for await (const line of input) {
    const message = JSON.parse(line);

    if (message.type === 'control_request') {
      console.log(JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response: {
            effective: {},
            sources: {},
            applied: {},
          },
        },
      }));

      continue;
    }

    if (message.type === 'user') {
      await turn(message);
    }
  }
}

/**
 * CLI использует команду MCP, которую выдал настоящий SEA для этого хода.
 * Поддельные project/chat поля и неверный nonce не расширяют server-owned scope.
 */
async function turn(message) {
  const config = JSON.parse(argv[argv.indexOf('--mcp-config') + 1]);
  const server = config.mcpServers['grigdesk-work'];

  assert.ok(server);
  assert.equal(server.command, process.env.GRIGDESK_FIXTURE_NODE);

  const child = spawn(server.command, server.args, {
    env: { PATH: '/host-bin:/usr/bin:/bin', HOME: '/D/home' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';

  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    errors += chunk.toString();
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
      params: {
        name: 'supervised_db',
        arguments: {
          action: 'query',
          projectId: 'forged-project',
          chatKey: 'forged-chat',
          label: 'forged-connection',
          text: 'SELECT 1',
        },
      },
    },
  ];

  child.stdin.end(messages.map((entry) => JSON.stringify({ jsonrpc: '2.0', ...entry })).join('\n') + '\n');
  assert.equal((await once(child, 'close'))[0], 0, errors);

  const results = output.trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(results[0].result.serverInfo.name, 'grigdesk-work');
  assert.ok(results[1].result.tools.some((tool) => tool.name === 'supervised_db'));
  assert.deepEqual(JSON.parse(results[2].result.content[0].text), {
    ok: false,
    error: 'project_scope_unavailable',
  });

  const badArgs = [...server.args];

  badArgs[badArgs.indexOf('--nonce') + 1] = 'wrong-nonce';
  await assert.rejects(execute(server.command, badArgs, {
    env: { PATH: '/host-bin:/usr/bin:/bin' },
    timeout: 5000,
  }), /nonce/);
  await writeFile('/D/agent-evidence.json', JSON.stringify({ mcp: true, scope: true }));

  for (const event of [
    {
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
    },
    {
      type: 'assistant',
      session_id: sessionId,
      message: {
        id: 'sea-fixture-message',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'SEA_MCP_SCOPE_OK' }],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      session_id: sessionId,
      result: 'SEA_MCP_SCOPE_OK',
      user_message_uuid: message.uuid,
      user_message_uuids: [message.uuid],
      uuid: randomUUID(),
      num_turns: 1,
      usage: { output_tokens: 1 },
    },
  ]) {
    console.log(JSON.stringify(event));
  }
}

await main();
