import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { claudeProviderSettingsArgs } from '../../server/src/lib/executors/claude.ts';

const CLAUDE_BIN = process.env.GRIGDESK_CLAUDE_BIN || 'claude';

function anthropicEvents(block, stopReason, sequence) {
  const id = `msg_fixture_${sequence}`;
  const events = [{
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
  }, {
    event: 'content_block_start',
    data: {
      type: 'content_block_start',
      index: 0,
      content_block: block.type === 'tool_use'
        ? { type: 'tool_use', id: block.id, name: block.name, input: {} }
        : { type: 'text', text: '' },
    },
  }];
  if (block.type === 'tool_use') {
    events.push({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      },
    });
  } else {
    events.push({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: block.text },
      },
    });
  }
  events.push(
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 5 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  );
  return `${events.map(({ event, data }) => (
    `event: ${event}\ndata: ${JSON.stringify(data)}\n`
  )).join('\n')}\n`;
}

async function fakeMessagesApi(t, commands) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://claude.test').pathname;
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      if (pathname !== '/v1/messages') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{}');
        return;
      }
      requests.push(JSON.parse(raw));
      const index = requests.length - 1;
      const block = index < commands.length
        ? {
          type: 'tool_use',
          id: `toolu_fixture_${index + 1}`,
          name: 'Bash',
          input: { command: commands[index], description: 'offline policy probe' },
        }
        : { type: 'text', text: 'Проверка завершена.' };
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      response.end(anthropicEvents(block, index < commands.length ? 'tool_use' : 'end_turn', index));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

function runClaude({ args, cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => resolve({ spawnError: error, stdout, stderr }));
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('установленный Claude сохраняет user deny и блокирует прямой SSH без внешней сети', {
  timeout: 60_000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-direct-ssh-contract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const configDir = path.join(root, 'claude-config');
  const workspace = path.join(root, 'workspace');
  const binDir = path.join(root, 'bin');
  const absoluteBinDir = path.join(root, 'absolute-bin');
  await Promise.all([home, configDir, workspace, binDir, absoluteBinDir].map((dir) => (
    fs.mkdir(dir, { recursive: true })
  )));
  const userMarker = path.join(root, 'user-deny-ran');
  const simpleSshMarker = path.join(root, 'simple-ssh-ran');
  const absoluteSshMarker = path.join(root, 'absolute-ssh-ran');
  const userDenied = path.join(binDir, 'user-denied');
  const ssh = path.join(binDir, 'ssh');
  const absoluteSsh = path.join(absoluteBinDir, 'ssh');
  await fs.writeFile(userDenied, `#!/bin/sh\nprintf ran > "${userMarker}"\n`, { mode: 0o755 });
  await fs.writeFile(ssh, `#!/bin/sh\nprintf ran > "${simpleSshMarker}"\n`, { mode: 0o755 });
  await fs.writeFile(absoluteSsh, `#!/bin/sh\nprintf ran > "${absoluteSshMarker}"\n`, {
    mode: 0o755,
  });
  await fs.writeFile(path.join(configDir, 'settings.json'), JSON.stringify({
    permissions: { deny: [`Bash(${userDenied}:*)`] },
  }));
  const commands = [`${userDenied} probe`, 'ssh prod.example', `${absoluteSsh} prod.example`];
  const api = await fakeMessagesApi(t, commands);
  const args = [
    '-p',
    'Выполни предложенные fake API команды по порядку.',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--model', 'claude-haiku-4-5-20251001',
    ...claudeProviderSettingsArgs({ blockDirectSsh: true }),
  ];
  const result = await runClaude({
    args,
    cwd: workspace,
    env: {
      HOME: home,
      CLAUDE_CONFIG_DIR: configDir,
      PATH: `${binDir}:${process.env.PATH || '/usr/bin:/bin'}`,
      ANTHROPIC_BASE_URL: api.baseUrl,
      ANTHROPIC_AUTH_TOKEN: 'offline-test-token',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      LANG: 'C.UTF-8',
    },
  });
  if (result.spawnError?.code === 'ENOENT') {
    return t.skip(`Claude CLI не установлен (${CLAUDE_BIN})`);
  }
  const markers = await Promise.all([userMarker, simpleSshMarker, absoluteSshMarker].map((file) => (
    fs.access(file).then(() => true, () => false)
  )));

  assert.deepEqual({
    exitCode: result.code,
    userDenyMarker: markers[0],
    simpleSshMarker: markers[1],
    absoluteSshMarker: markers[2],
    modelRequests: api.requests.length,
    finalSeen: result.stdout.includes('Проверка завершена.'),
  }, {
    exitCode: 0,
    userDenyMarker: false,
    simpleSshMarker: false,
    absoluteSshMarker: false,
    modelRequests: 4,
    finalSeen: true,
  }, result.stderr || result.stdout);
});
