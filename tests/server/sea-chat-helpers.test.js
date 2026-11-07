import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DIRECT_SSH_HOOK_COMMAND,
  DIRECT_SSH_HOOK_PATH,
} from '../../server/src/lib/executors/_directSshPolicy.ts';
import {
  createRuntimePaths,
  helperCommand,
  helperCommandFor,
  readHelperCatalog,
} from '../../server/src/lib/runtimePaths.ts';
import { shellQuote } from '../../shared/lib/shellQuote.ts';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/**
 * Временная папка одного сценария; уборка удаляет только её.
 */
async function scratch(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-chat-'));

  t.after(() => rm(root, {
    recursive: true,
    force: true
  }));

  return root;
}

/**
 * Запускает собранную команду helper-а с allowlist окружения.
 * stdout и stderr всегда читаются строками, чтобы протокол не терялся.
 */
function start(command, args, env = {}) {
  return spawn(command, args, {
    env: {
      PATH: '/usr/bin:/bin',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Собирает новые строки stdout как JSON-RPC и текст stderr.
 * Тест ждёт наблюдаемого числа ответов, а не фиксированной паузы.
 */
function protocol(child) {
  const lines = [];
  let buffer = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;

    let index = buffer.indexOf('\n');

    while (index >= 0) {
      const line = buffer.slice(0, index).trim();

      buffer = buffer.slice(index + 1);

      if (line) {
        lines.push(JSON.parse(line));
      }

      index = buffer.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  return {
    lines,
    get stderr() {
      return stderr;
    }
  };
}

/**
 * Ждёт выполнения условия или падает по тайм-ауту.
 * Используется только для наблюдения протокола и завершения процесса.
 */
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error('ожидание протокола не уложилось в срок');
}

/**
 * Завершает только собственный дочерний процесс теста.
 */
async function close(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));

    child.kill('SIGKILL');
    await exited;
  }
}

test('SEA-CHAT-01: source-команды helper-ов прежние', () => {
  const perm = helperCommand('chat-permission-mcp', []);
  const work = helperCommand('work-mcp', ['--socket', '/tmp/s.sock', '--nonce', 'n']);
  const hook = helperCommand('direct-ssh-policy-hook', []);

  assert.equal(perm.command, process.execPath);
  assert.deepEqual(perm.args, [
    path.join(ROOT, 'server/src/lib/chat/permission-mcp.js'),
  ]);
  assert.equal(work.command, process.execPath);
  assert.deepEqual(work.args, [
    path.join(ROOT, 'server/src/lib/executors/work-mcp.js'),
    '--socket', '/tmp/s.sock', '--nonce', 'n',
  ]);
  assert.deepEqual(hook.args, [
    path.join(ROOT, 'server/src/lib/executors/_direct-ssh-policy-hook.js'),
  ]);
});

test('SEA-CHAT-02: packaged-команды берут вложенный Node и helper своего R', async (t) => {
  const R = path.join(await scratch(t), 'R with space');
  const node = path.join(R, 'runtime/node/bin/node');

  await mkdir(path.dirname(node), {
    recursive: true
  });
  await mkdir(path.join(R, 'server/runtime/helpers'), {
    recursive: true
  });
  await writeFile(node, 'node');
  await chmod(node, 0o755);
  await writeFile(path.join(R, 'server/grigdesk-server'), 'binary');

  const paths = createRuntimePaths({
    mode: 'sea',
    execPath: path.join(R, 'server/grigdesk-server'),
  });
  const catalog = readHelperCatalog(path.join(ROOT, 'server/build/helpers.json'));
  const work = helperCommandFor(paths, catalog, 'work-mcp', ['--socket', 's', '--nonce', 'n']);
  const hook = helperCommandFor(paths, catalog, 'direct-ssh-policy-hook', []);

  assert.equal(work.command, node);
  assert.deepEqual(work.args, [
    path.join(R, 'server/runtime/helpers/work-mcp.mjs'),
    '--socket', 's', '--nonce', 'n',
  ]);
  assert.deepEqual(hook.args, [
    path.join(R, 'server/runtime/helpers/direct-ssh-policy-hook.mjs'),
  ]);
});

test('SEA-CHAT-03: shell-команда хука экранирует путь с пробелом', () => {
  assert.equal(shellQuote('/tmp/R with space/node'), "'/tmp/R with space/node'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(shellQuote(''), "''");
  assert.equal(DIRECT_SSH_HOOK_COMMAND,
    [process.execPath, DIRECT_SSH_HOOK_PATH].map(shellQuote).join(' '));
});

test('SEA-CHAT-04: permission MCP отвечает на initialize/tools и передаёт scope', async (t) => {
  const brokerRequests = [];
  const broker = createHttpServer((request, response) => {
    let body = '';

    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      brokerRequests.push({
        headers: request.headers,
        body: JSON.parse(body),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ behavior: 'allow', message: 'ok' }));
    });
  });

  await new Promise((resolve) => broker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => broker.close(resolve)));

  const port = broker.address().port;
  const command = helperCommand('chat-permission-mcp', []);
  const child = start(command.command, command.args, {
    GRIGDESK_PERM_URL: `http://127.0.0.1:${port}/perm`,
    GRIGDESK_CHAT_KEY: 'chat-1',
    GRIGDESK_INTERNAL: 'secret',
  });

  t.after(() => close(child));

  const wire = protocol(child);

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {},
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'approve',
      arguments: {
        tool_name: 'Bash',
        input: { command: 'ls' },
        tool_use_id: 'tool-1',
      },
    },
  })}\n`);

  await waitFor(() => wire.lines.length >= 3);

  const [initialized, tools, called] = wire.lines;

  assert.equal(initialized.result.serverInfo.name, 'grigdesk-perm');
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), ['approve']);
  assert.deepEqual(JSON.parse(called.result.content[0].text), {
    behavior: 'allow',
    message: 'ok',
  });
  assert.equal(brokerRequests.length, 1);
  assert.equal(brokerRequests[0].body.chatKey, 'chat-1');
  assert.equal(brokerRequests[0].body.tool_use_id, 'tool-1');
  assert.equal(brokerRequests[0].headers['x-grigdesk-internal'], 'secret');
});

test('SEA-CHAT-05: work MCP проверяет nonce и обслуживает tools по протоколу', async (t) => {
  const root = await scratch(t);
  const socketPath = path.join(root, 'work.sock');
  const requests = [];
  const nonce = 'правильный-nonce';
  const server = createNetServer((socket) => {
    let input = '';

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      input += chunk;
    });
    socket.on('end', () => {
      const request = JSON.parse(input);

      requests.push(request);

      if (request.nonce !== nonce) {
        socket.end(`${JSON.stringify({ error: 'work IPC nonce не совпал' })}\n`);

        return;
      }

      const result = request.type === 'descriptors'
        ? [{
          name: 'echo',
          description: 'Echo',
          inputSchema: { type: 'object' },
        }]
        : { ok: true };

      socket.end(`${JSON.stringify({ result })}\n`);
    });
  });

  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const command = helperCommand('work-mcp', ['--socket', socketPath, '--nonce', nonce]);
  const child = start(command.command, command.args);

  t.after(() => close(child));

  const wire = protocol(child);

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {},
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'echo',
      arguments: { x: 1 },
    },
  })}\n`);

  await waitFor(() => wire.lines.length >= 3);

  const [, tools, called] = wire.lines;

  assert.equal(tools.result.tools[0].name, 'echo');
  assert.deepEqual(JSON.parse(called.result.content[0].text), { ok: true });
  assert.ok(requests.every((request) => request.nonce === nonce));

  const bad = helperCommand('work-mcp', ['--socket', socketPath, '--nonce', 'чужой']);
  const badChild = start(bad.command, bad.args);
  const badWire = protocol(badChild);

  t.after(() => close(badChild));

  await waitFor(() => badChild.exitCode !== null || badWire.stderr.includes('nonce'));
  assert.notEqual(badChild.exitCode, 0);
  assert.match(badWire.stderr, /nonce/);
});

test('SEA-CHAT-06: хук прямого SSH читает JSON и отвечает разрешением или запретом', async (t) => {
  const command = helperCommand('direct-ssh-policy-hook', []);

  for (const scenario of [
    {
      args: [],
      payload: { tool_name: 'Bash', tool_input: { command: 'ssh host' } },
      check: (result) => {
        assert.equal(result.code, 0);
        assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
      },
    },
    {
      args: ['--db'],
      payload: { tool_name: 'Bash', tool_input: { command: 'mysql -h db' } },
      check: (result) => {
        assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
        assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason,
          /БД/);
      },
    },
    {
      args: ['--no-ssh'],
      payload: { tool_name: 'Bash', tool_input: { command: 'apt-get update' } },
      check: (result) => {
        assert.equal(result.code, 0);
        assert.equal(result.stdout, '');
      },
    },
  ]) {
    const child = start(command.command, [...command.args, ...scenario.args]);
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(JSON.stringify(scenario.payload));

    const code = await new Promise((resolve) => child.once('exit', resolve));

    scenario.check({
      code,
      stdout,
      stderr
    });
  }
});

test('SEA-CHAT-07: библиотечный импорт helper-ов не запускает CLI', async () => {
  for (const file of [
    'server/src/lib/chat/permission-mcp.js',
    'server/src/lib/executors/work-mcp.js',
    'server/src/lib/executors/_direct-ssh-policy-hook.js',
  ]) {
    const module = await import(`${pathToFileURL(path.join(ROOT, file)).href}?library=1`);

    assert.equal(typeof module.main, 'function', file);
  }
});

test('REVIEW-R1: единственный work-mcp.js в contained-среде доходит до сокета', async (t) => {
  const root = await scratch(t);
  const file = path.join(root, 'work-mcp.js');

  await copyFile(path.join(ROOT, 'server/src/lib/executors/work-mcp.js'), file);

  const child = start(process.execPath, [file, '--socket', path.join(root, 'missing.sock'), '--nonce', 'n']);
  const wire = protocol(child);

  t.after(() => close(child));

  const code = await new Promise((resolve) => child.once('exit', resolve));

  assert.equal(code, 1);
  assert.match(wire.stderr, /ENOENT|ECONNREFUSED/);
  assert.doesNotMatch(wire.stderr, /ERR_MODULE_NOT_FOUND/);
});

test('REVIEW-R4: отсутствие каталога helper-ов оставляет решение хука deny', async (t) => {
  const root = await scratch(t);
  const files = [
    'server/src/lib/executors/_direct-ssh-policy-hook.js',
    'server/src/lib/executors/_directSshPolicy.ts',
    'server/src/lib/helperEntry.ts',
    'server/src/lib/runtimePaths.ts',
    'server/src/lib/runtimeBuildContext.ts',
    'shared/lib/shellQuote.ts',
  ];

  for (const file of files) {
    const target = path.join(root, file);

    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(ROOT, file), target);
  }

  const child = start(process.execPath, [path.join(root, files[0])]);
  const wire = protocol(child);

  t.after(() => close(child));
  child.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ssh fixture' } }));

  const code = await new Promise((resolve) => child.once('exit', resolve));

  assert.equal(code, 0, wire.stderr);
  assert.equal(wire.lines[0]?.hookSpecificOutput.permissionDecision, 'deny');
});

test('SB06: каталог содержит оба host hook', () => {
  const catalog = readHelperCatalog(path.join(ROOT, 'server/build/helpers.json'));

  for (const id of ['deepseek-instructions-hook', 'glm-tool-policy-hook']) {
    assert.ok(catalog.helpers.some((entry) => entry.id === id), id);
  }
});
