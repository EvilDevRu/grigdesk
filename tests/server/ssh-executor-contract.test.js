import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import claude from '../../server/src/lib/executors/claude.ts';
import { claudeSessionArgs } from '../../server/src/lib/executors/_claudeStream.ts';
import codex from '../../server/src/lib/executors/codex.ts';
import { createToolbox } from '../../server/src/lib/executors/_ollamaTools.ts';
import { runContainedKimi } from '../../server/src/lib/kimi/runtime.ts';

class KimiWorkMcpProcess extends EventEmitter {
  constructor(toolName = 'supervised_ssh') {
    super();
    this.toolName = toolName;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    this.permissionResponse = null;
    this.promptId = null;
    let input = '';
    this.stdin = new Writable({
      write: (chunk, _encoding, done) => {
        input += String(chunk);
        let newline;
        while ((newline = input.indexOf('\n')) >= 0) {
          const line = input.slice(0, newline);
          input = input.slice(newline + 1);
          if (line.trim()) this.receive(JSON.parse(line));
        }
        done();
      },
      final: (done) => {
        setImmediate(() => {
          this.stdout.end();
          this.stderr.end();
          this.exitCode = 0;
          this.emit('close', 0, null);
        });
        done();
      },
    });
    this.exitCode = null;
  }

  send(message) {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  finishPrompt() {
    this.send({
      method: 'session/update',
      params: {
        sessionId: 'kimi-ssh-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'готово' },
        },
      },
    });
    this.send({ id: this.promptId, result: { stopReason: 'end_turn' } });
  }

  /**
   * Эмулирует ACP lifecycle до точного permission для work MCP и фиксирует
   * клиентские запросы, чтобы тест проверял wire-контракт, а не текст runtime.
   */
  receive(message) {
    this.messages.push(message);
    if (message.method === 'initialize') {
      this.send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: 'Kimi', version: 'test' } } });
      return;
    }
    if (message.method === 'session/new') {
      this.send({ id: message.id, result: { sessionId: 'kimi-ssh-session', configOptions: [] } });
      return;
    }
    if (message.method === 'session/resume' || message.method === 'session/set_config_option') {
      this.send({ id: message.id, result: {} });
      return;
    }
    if (message.method === 'session/prompt') {
      const prompt = message.params?.prompt?.[0]?.text || '';
      if (prompt === '/status') {
        this.send({
          method: 'session/update',
          params: {
            sessionId: 'kimi-ssh-session',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Context: 10 / 100 tokens' },
            },
          },
        });
        this.send({ id: message.id, result: { stopReason: 'end_turn' } });
        return;
      }
      this.promptId = message.id;
      this.send({
        id: 91006,
        method: 'session/request_permission',
        params: {
          sessionId: 'kimi-ssh-session',
          options: [
            { optionId: 'once', name: 'Approve once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
          toolCall: {
            toolCallId: `${this.toolName}-1`,
            title: `mcp__cockpit-work__${this.toolName}`,
            content: [{ type: 'content', content: { type: 'text', text: 'id' } }],
          },
        },
      });
      return;
    }
    if (!message.method && message.id === 91006) {
      this.permissionResponse = message.result;
      this.finishPrompt();
    }
  }

  kill() {
    this.stdout.end();
    this.emit('close', null, 'SIGTERM');
  }
}

function runMcpChild(server, messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`work MCP завершился ${code}: ${stderr}`));
        return;
      }
      resolve(stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    });
    child.stdin.end(messages.map((message) => JSON.stringify(message)).join('\n') + '\n');
  });
}

async function workTools(options) {
  const module = await import('../../server/src/lib/executors/index.ts');
  const create = module.createWorkTools || module.workTools;
  assert.equal(
    typeof create,
    'function',
    'provider-neutral Cockpit work tools ещё не реализованы в executors/index.js',
  );
  return create(options);
}

test('агентский SSH descriptor содержит только list и exec без SFTP и подключения', async () => {
  const tools = await workTools({ projectId: 'project-a', invoke: async () => ({ ok: true }) });
  const ssh = tools.descriptors.find((descriptor) => descriptor.name === 'supervised_ssh');
  const schema = JSON.stringify(ssh);

  assert.deepEqual({
    found: !!ssh,
    hasList: schema.includes('list'),
    hasExec: schema.includes('exec'),
    hasSftp: /sftp|upload|download|file/i.test(schema),
    hasHumanMetadata: /host|port|user|fingerprint|password/i.test(schema),
  }, {
    found: true,
    hasList: true,
    hasExec: true,
    hasSftp: false,
    hasHumanMetadata: false,
  });
});

test('реальный work MCP получает descriptors и выполняет tools/call через IPC', async (t) => {
  const { createWorkIpc } = await import('../../server/src/lib/executors/workIpc.ts');
  const calls = [];
  const work = await workTools({
    projectId: 'project-a',
    async invoke(scope, input) {
      await new Promise((resolve) => setImmediate(resolve));
      calls.push({ scope, input });
      return [{ label: 'Боевой код', role: 'code', host: 'private.example' }];
    },
  });
  const ipc = await createWorkIpc({ workTools: work });
  t.after(() => ipc.close());
  assert.deepEqual(ipc.mcpServer.env, [], 'ACP V1 требует явный пустой env');
  const responses = await runMcpChild(ipc.mcpServer, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'supervised_ssh',
        arguments: { action: 'list' },
      },
    },
  ]);

  assert.deepEqual({
    tools: responses[1]?.result?.tools?.map((tool) => tool.name),
    sshRootType: responses[1]?.result?.tools
      ?.find((tool) => tool.name === 'supervised_ssh')?.inputSchema?.type,
    calls,
    result: JSON.parse(responses[2]?.result?.content?.[0]?.text || 'null'),
  }, {
    tools: ['supervised_ssh'],
    sshRootType: 'object',
    calls: [{
      scope: { projectId: 'project-a' },
      input: { action: 'list' },
    }],
    result: [{ label: 'Боевой код', role: 'code' }],
  });
});

test('list передаёт модели только метку и роль разрешённых сессий своего проекта', async () => {
  const calls = [];
  const tools = await workTools({
    projectId: 'project-a',
    async invoke(scope, input) {
      calls.push({ scope, input });
      return [{
        label: 'Боевой код',
        role: 'code',
        host: 'server.internal',
        port: 22,
        user: 'deploy',
        fingerprint: 'SHA256:secret',
      }];
    },
  });
  const result = await tools.invoke('supervised_ssh', { action: 'list' });

  assert.deepEqual({ calls, result }, {
    calls: [{ scope: { projectId: 'project-a' }, input: { action: 'list' } }],
    result: [{ label: 'Боевой код', role: 'code' }],
  });
});

test('результаты exec всех типов не выдают agent prompt человеческие metadata', async () => {
  const privateFields = {
    host: 'SSH_PRIVATE_HOST_91006.internal',
    port: 22006,
    user: 'SSH_PRIVATE_USER_91006',
    fingerprint: 'SHA256:SSH_PRIVATE_FINGERPRINT_91006',
  };
  const cases = [
    {
      broker: {
        ok: true,
        output: 'done',
        shownBytes: 4,
        totalBytes: 4,
        truncated: false,
        ...privateFields,
      },
      expected: {
        ok: true,
        output: 'done',
        shownBytes: 4,
        totalBytes: 4,
        truncated: false,
      },
    },
    {
      broker: { ok: false, error: 'denied', comment: 'снача тесты', ...privateFields },
      expected: { ok: false, error: 'denied', comment: 'снача тесты' },
    },
    {
      broker: {
        ok: false,
        error: 'command_failed',
        exitCode: 17,
        output: 'failed',
        shownBytes: 6,
        totalBytes: 6,
        truncated: false,
        ...privateFields,
      },
      expected: {
        ok: false,
        error: 'command_failed',
        exitCode: 17,
        output: 'failed',
        shownBytes: 6,
        totalBytes: 6,
        truncated: false,
      },
    },
    {
      broker: { ok: false, error: 'session_lost', ...privateFields },
      expected: { ok: false, error: 'session_lost' },
    },
  ];
  const transcript = [];
  for (const entry of cases) {
    const tools = await workTools({
      projectId: 'project-a',
      invoke: async () => entry.broker,
    });
    const result = await tools.invoke('supervised_ssh', {
      action: 'exec', label: 'Боевой код', role: 'code', command: 'id',
    });
    transcript.push({ descriptor: tools.descriptors, result });
  }
  const serialized = JSON.stringify(transcript);

  assert.deepEqual({
    results: transcript.map((entry) => entry.result),
    leaks: Object.values(privateFields).filter((value) => serialized.includes(String(value))),
  }, {
    results: cases.map((entry) => entry.expected),
    leaks: [],
  });
});

test('MCP tool-result для Claude и Kimi не записывает private metadata в provider history', async () => {
  let module;
  try {
    module = await import('../../server/src/lib/executors/work-mcp.js');
  } catch (error) {
    assert.fail(`Cockpit work MCP ещё не реализован: ${error.message}`);
  }
  const tools = await workTools({
    projectId: 'project-a',
    async invoke() {
      return {
        ok: false,
        error: 'denied',
        comment: 'снача тесты',
        host: 'SSH_PRIVATE_HOST_91006',
        port: 22006,
        user: 'SSH_PRIVATE_USER_91006',
        fingerprint: 'SHA256:SSH_PRIVATE_FINGERPRINT_91006',
      };
    },
  });
  const create = module.createWorkMcpHandler || module.createWorkMcp || module.default;
  assert.equal(typeof create, 'function', 'work-mcp.js обязан давать MCP handler');
  const handler = create({ workTools: tools });
  const request = handler.request || handler.handle;
  assert.equal(typeof request, 'function', 'work MCP handler обязан принимать JSON-RPC request');
  const response = await request.call(handler, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'supervised_ssh',
      arguments: { action: 'exec', label: 'Боевой код', role: 'code', command: 'id' },
    },
  });
  const providerHistory = JSON.stringify({ descriptors: tools.descriptors, toolResult: response });

  assert.deepEqual({
    hasDeniedResult: providerHistory.includes('denied') && providerHistory.includes('снача тесты'),
    leaks: [
      'SSH_PRIVATE_HOST_91006',
      '22006',
      'SSH_PRIVATE_USER_91006',
      'SSH_PRIVATE_FINGERPRINT_91006',
    ].filter((value) => providerHistory.includes(value)),
  }, {
    hasDeniedResult: true,
    leaks: [],
  });
});

test('нулевой task scope не вызывает broker и не создаёт подтверждение', async () => {
  let invoked = 0;
  const tools = await workTools({
    projectId: null,
    async invoke() {
      invoked += 1;
      return [{ label: 'Чужой сервер', role: 'db' }];
    },
  });
  const list = await tools.invoke('supervised_ssh', { action: 'list' });
  const exec = await tools.invoke('supervised_ssh', {
    action: 'exec', label: 'Чужой сервер', role: 'db', command: 'id',
  });

  assert.deepEqual({ invoked, list, exec }, {
    invoked: 0,
    list: [],
    exec: { ok: false, error: 'project_scope_unavailable' },
  });
});

test('persistent Claude и Codex ротируют процесс при смене SSH project scope', () => {
  assert.deepEqual({
    claude: claude.session?.restartOn?.includes('workToolScopeKey'),
    codex: codex.session?.restartOn?.includes('workToolScopeKey'),
  }, {
    claude: true,
    codex: true,
  });
});

test('Ollama создаёт ровно одно SSH-подтверждение во всех режимах прав', async () => {
  const calls = [];
  const results = [];
  const modes = ['default', 'auto', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'];
  for (const permissionMode of modes) {
    const toolbox = await createToolbox({
      permissionMode,
      workTools: {
        descriptors: [{
          type: 'function',
          function: {
            name: 'supervised_ssh',
            description: 'Надзорная команда',
            parameters: { type: 'object', properties: {} },
          },
        }],
        async invoke(name, input) {
          calls.push({ permissionMode, name, input });
          return { ok: false, error: 'denied', comment: 'не во время выкладки' };
        },
      },
    });
    results.push(await toolbox.call({
      name: 'supervised_ssh',
      args: { action: 'exec', label: 'Боевой код', role: 'code', command: 'id' },
    }));
  }

  assert.deepEqual({
    calls: calls.map(({ permissionMode }) => permissionMode),
    results,
  }, {
    calls: modes,
    results: modes.map(() => ({
      ok: false,
      error: 'denied',
      comment: 'не во время выкладки',
    })),
  });
});

test('Claude строит one-shot и persistent argv с точечным SSH preallow', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-ssh-claude-argv-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'fake-claude');
  const trace = path.join(root, 'argv.json');
  await writeFile(bin, `#!/bin/sh
node -e 'require("node:fs").writeFileSync(process.env.SSH_ARGV_TRACE, JSON.stringify(process.argv.slice(1)))' -- "$@"
printf '%s\n' '{"type":"result","subtype":"success","result":"ok","session_id":"ssh-session","usage":{}}'
`);
  await chmod(bin, 0o755);
  const mcpConfig = {
    mcpServers: {
      'cockpit-work': { command: '/tmp/cockpit-work-mcp', args: ['--socket', '/tmp/work.sock'] },
    },
  };
  const snapshot = (argv) => ({
    config: JSON.parse(argv[argv.indexOf('--mcp-config') + 1]),
    allowed: argv.includes('--allowedTools') ? argv[argv.indexOf('--allowedTools') + 1] : null,
    permissionPrompt: argv.includes('--permission-prompt-tool'),
  });
  const modes = ['default', 'auto', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'];
  const pairs = [];
  for (const permissionMode of modes) {
    await claude.run({
      config: { claudeBin: bin },
      env: { ...process.env, SSH_ARGV_TRACE: trace },
      message: 'run',
      cwd: root,
      permissionMode,
      mcpConfig,
    });
    const oneShot = JSON.parse(await readFile(trace, 'utf8'));
    const persistent = claudeSessionArgs({ permissionMode, mcpConfig });
    pairs.push({ permissionMode, oneShot: snapshot(oneShot), persistent: snapshot(persistent) });
  }

  const expected = {
    config: mcpConfig,
    allowed: 'mcp__cockpit-work__supervised_ssh',
    permissionPrompt: false,
  };
  assert.deepEqual(pairs, modes.map((permissionMode) => ({
    permissionMode,
    oneShot: expected,
    persistent: expected,
  })));
});

test('Codex передаёт dynamicTools и ровно раз диспатчит item/tool/call во всех режимах', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-ssh-codex-tool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'codex-fixture');
  await copyFile(new URL('../fixtures/codex-app-server/rich-turn-0.149.0.mjs', import.meta.url), bin);
  await chmod(bin, 0o755);
  const schema = {
    type: 'object',
    required: ['action'],
    properties: { action: { enum: ['list', 'exec'] } },
  };
  const modes = ['default', 'auto', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'];
  const calls = [];
  const declared = [];
  for (const permissionMode of modes) {
    const trace = path.join(root, `${permissionMode}.jsonl`);
    await codex.run({
      config: { codexBin: bin },
      env: {
        ...process.env,
        COCKPIT_CODEX_FIXTURE_TRACE: trace,
        COCKPIT_CODEX_FIXTURE_SCENARIO: 'ssh-tool',
        COCKPIT_CODEX_FIXTURE_CLI_VERSION: '0.150.1',
        COCKPIT_CODEX_FIXTURE_EXPECT_HOOK: '0',
      },
      message: 'run id',
      cwd: root,
      model: 'gpt-contract-0.149',
      effort: 'medium',
      sessionId: null,
      permissionMode,
      providerSettings: { blockDirectSsh: false },
      workTools: {
        descriptors: [{ name: 'supervised_ssh', description: 'Надзорный SSH', inputSchema: schema }],
        async invoke(name, input) {
          calls.push({ permissionMode, name, input });
          return { ok: false, error: 'denied', comment: 'нет' };
        },
      },
    });
    const messages = (await readFile(trace, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    declared.push(messages.find((entry) => (
      entry.direction === 'client' && entry.message?.method === 'thread/start'
    ))?.message.params.dynamicTools);
  }

  assert.deepEqual({
    calls: calls.map(({ permissionMode, name }) => ({ permissionMode, name })),
    declared,
  }, {
    calls: modes.map((permissionMode) => ({ permissionMode, name: 'supervised_ssh' })),
    declared: modes.map(() => [{
      type: 'function',
      name: 'supervised_ssh',
      description: 'Надзорный SSH',
      inputSchema: schema,
    }]),
  });
});

test('Kimi передаёт work MCP в ACP и не создаёт вторую provider-карточку', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-ssh-kimi-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(cwd, { recursive: true }));
  const providerPrompts = [];
  const mcpServers = [{
    name: 'cockpit-work',
    command: '/usr/bin/socat',
    args: ['STDIO', 'UNIX-CONNECT:/run/cockpit-work/server.sock'],
  }];
  const modes = ['default', 'auto', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'];
  const snapshots = [];
  for (const permissionMode of modes) {
    const fakeProcess = new KimiWorkMcpProcess();
    await runContainedKimi({
      config: {
        kimiLaunchMode: 'host',
        kimiRuntimeHome: path.join(root, 'runtime'),
        kimiHome: path.join(root, 'home'),
        chatsDir: path.join(root, 'chats'),
        chatBindingsDir: path.join(root, 'chats', '.bindings'),
      },
      chatKey: `chat-${permissionMode}`,
      cwd,
      message: 'run id',
      model: 'kimi-code/k3',
      permissionMode,
      providerSettings: { blockDirectSsh: false },
      mcpServers,
      onPermission: async (presentation) => {
        providerPrompts.push({ permissionMode, presentation });
        return { allow: false };
      },
      deps: {
        assertVersion: async () => 'test',
        buildHostLaunch: async () => ({
          command: 'fake', args: [], env: {}, cwdReal: cwd, unit: null,
        }),
        spawn: () => fakeProcess,
        stopUnit: async () => {},
      },
    });
    const sessionNew = fakeProcess.messages.find((message) => message.method === 'session/new');
    snapshots.push({
      permissionMode,
      mcpServers: sessionNew?.params?.mcpServers,
      providerDecision: fakeProcess.permissionResponse,
    });
  }

  assert.deepEqual({
    providerPrompts: providerPrompts.length,
    snapshots,
  }, {
    providerPrompts: 0,
    snapshots: modes.map((permissionMode) => ({
      permissionMode,
      mcpServers,
      providerDecision: { outcome: { outcome: 'selected', optionId: 'once' } },
    })),
  });
});

test('Claude разрешает exact набор рабочих tools в one-shot и persistent ходах', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-work-claude-argv-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'fake-claude');
  const trace = path.join(root, 'argv.json');
  await writeFile(bin, `#!/bin/sh
node -e '
  require("node:fs").writeFileSync(process.env.ARGV_TRACE, JSON.stringify(process.argv.slice(1)))
' -- "$@"
printf '%s\n' \
  '{"type":"result","subtype":"success","result":"ok","session_id":"work-session","usage":{}}'
`);
  await chmod(bin, 0o755);
  const mcpConfig = {
    mcpServers: {
      'cockpit-work': { command: '/tmp/cockpit-work-mcp', args: ['--socket', '/tmp/work.sock'] },
    },
  };
  const descriptors = [
    { name: 'supervised_ssh', description: 'SSH', inputSchema: { type: 'object' } },
    { name: 'supervised_db', description: 'БД', inputSchema: { type: 'object' } },
  ];
  const work = { descriptors, invoke: async () => ({ ok: true }) };
  await claude.run({
    config: { claudeBin: bin },
    env: { ...process.env, ARGV_TRACE: trace },
    message: 'search',
    cwd: root,
    permissionMode: 'default',
    mcpConfig,
    workTools: work,
  });
  const oneShot = JSON.parse(await readFile(trace, 'utf8'));
  const persistent = claudeSessionArgs({ permissionMode: 'default', mcpConfig, workTools: work });
  const allowed = (argv) => argv[argv.indexOf('--allowedTools') + 1]?.split(',').sort();

  assert.deepEqual({ oneShot: allowed(oneShot), persistent: allowed(persistent) }, {
    oneShot: [
      'mcp__cockpit-work__supervised_db',
      'mcp__cockpit-work__supervised_ssh',
    ],
    persistent: [
      'mcp__cockpit-work__supervised_db',
      'mcp__cockpit-work__supervised_ssh',
    ],
  });
});

test('Codex объявляет и диспатчит рабочий tool как dynamic tool и отдаёт его результат', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-work-codex-tool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'codex-fixture');
  const trace = path.join(root, 'trace.jsonl');
  await copyFile(new URL('../fixtures/codex-app-server/rich-turn-0.149.0.mjs', import.meta.url), bin);
  await chmod(bin, 0o755);
  const calls = [];
  const descriptor = {
    name: 'sample_lookup',
    description: 'Поиск по образцу',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: { action: { enum: ['search', 'read'] }, query: { type: 'string' } },
    },
  };
  const run = await codex.run({
    config: { codexBin: bin },
    env: {
      ...process.env,
      COCKPIT_CODEX_FIXTURE_TRACE: trace,
      COCKPIT_CODEX_FIXTURE_SCENARIO: 'lookup-tool',
      COCKPIT_CODEX_FIXTURE_CLI_VERSION: '0.150.1',
      COCKPIT_CODEX_FIXTURE_EXPECT_HOOK: '0',
    },
    message: 'search',
    cwd: root,
    model: 'gpt-contract-0.149',
    effort: 'medium',
    permissionMode: 'default',
    providerSettings: { blockDirectSsh: false },
    workTools: {
      descriptors: [descriptor],
      async invoke(name, input) {
        calls.push({ name, input });
        return {
          ok: true,
          items: [{
            id: '00000000-0000-4000-8000-000000000001',
            title: 'Очередь деплоя',
            tags: ['queue'],
            fragment: '…после деплоя…',
          }],
        };
      },
    },
  });
  const messages = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
  const declared = messages.find((entry) => (
    entry.direction === 'client' && entry.message?.method === 'thread/start'
  ))?.message.params.dynamicTools;

  const tool = run.steps.find((step) => step.k === 'tool' && step.id === 'lookup-call-1');
  const result = run.steps.find((step) => step.k === 'res' && step.id === 'lookup-call-1');

  assert.deepEqual({ declared, calls }, {
    declared: [{ type: 'function', ...descriptor }],
    calls: [{
      name: 'sample_lookup',
      input: { action: 'search', query: 'деплой', limit: 3 },
    }],
  });
  assert.equal(tool?.name, 'sample_lookup');
  assert.equal(result?.ok, true);
  assert.equal(JSON.parse(result?.text || '{}').items?.[0]?.title, 'Очередь деплоя');
});

test('Ollama объявляет и вызывает рабочий tool через общий dispatcher', async () => {
  const calls = [];
  const steps = [];
  const descriptor = {
    type: 'function',
    function: {
      name: 'sample_lookup',
      description: 'Поиск по образцу',
      parameters: { type: 'object', properties: { action: { enum: ['search', 'read'] } } },
    },
  };
  const toolbox = await createToolbox({
    permissionMode: 'default',
    sink: { emit(step) { steps.push(step); } },
    workTools: {
      descriptors: [descriptor],
      async invoke(name, input) {
        calls.push({ name, input });
        return { ok: true, items: [] };
      },
    },
  });
  const result = await toolbox.call({
    name: 'sample_lookup', args: { action: 'search', query: 'деплой' },
  });

  assert.deepEqual({
    title: steps.find((step) => step.k === 'tool')?.title,
    calls,
    result,
  }, {
    title: 'Поиск по образцу',
    calls: [{ name: 'sample_lookup', input: { action: 'search', query: 'деплой' } }],
    result: { ok: true, items: [] },
  });
});
