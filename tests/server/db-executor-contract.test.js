import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { claudeSessionArgs } from '../../server/src/lib/executors/_claude-stream.js';
import codex from '../../server/src/lib/executors/codex.js';
import { createWorkTools } from '../../server/src/lib/executors/index.js';
import { runContainedKimi } from '../../server/src/lib/kimi/runtime.js';

function workTools(enabled) {
  return createWorkTools({
    projectId: 'project-a',
    pluginEnabled: (id) => enabled && id === 'db',
    dbInvoke: async () => ({ ok: true }),
  });
}

function descriptorNames(tools) {
  return tools.descriptors.map((descriptor) => descriptor.name).sort();
}

class KimiDbPermissionProcess extends EventEmitter {
  constructor() {
    super();
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
          if (line.trim()) {
            this.receive(JSON.parse(line));
          }
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
        sessionId: 'kimi-db-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'готово' },
        },
      },
    });
    this.send({ id: this.promptId, result: { stopReason: 'end_turn' } });
  }

  /** Эмулирует ACP до запроса разрешения exact work-tool `supervised_db`. */
  receive(message) {
    this.messages.push(message);
    if (message.method === 'initialize') {
      this.send({
        id: message.id,
        result: { protocolVersion: 1, agentInfo: { name: 'Kimi', version: 'test' } },
      });
      return;
    }
    if (message.method === 'session/new') {
      this.send({
        id: message.id,
        result: { sessionId: 'kimi-db-session', configOptions: [] },
      });
      return;
    }
    if (message.method === 'session/resume'
      || message.method === 'session/set_config_option') {
      this.send({ id: message.id, result: {} });
      return;
    }
    if (message.method === 'session/prompt') {
      const prompt = message.params?.prompt?.[0]?.text || '';
      if (prompt === '/status') {
        this.send({
          method: 'session/update',
          params: {
            sessionId: 'kimi-db-session',
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
        id: 91012,
        method: 'session/request_permission',
        params: {
          sessionId: 'kimi-db-session',
          options: [
            { optionId: 'once', name: 'Approve once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
          toolCall: {
            toolCallId: 'supervised-db-1',
            title: 'mcp__cockpit-work__supervised_db',
            content: [{ type: 'content', content: { type: 'text', text: 'SELECT 1' } }],
          },
        },
      });
      return;
    }
    if (!message.method && message.id === 91012) {
      this.permissionResponse = message.result;
      this.finishPrompt();
    }
  }

  kill() {
    this.stdout.end();
    this.emit('close', null, 'SIGTERM');
  }
}

test('supervised_db отсутствует при выключенном плагине и появляется при включённом', () => {
  const disabled = createWorkTools({
    projectId: 'project-a',
    pluginEnabled: () => false,
    dbInvoke: async () => ({ ok: true }),
  });
  const enabled = createWorkTools({
    projectId: 'project-a',
    pluginEnabled: (id) => id === 'db',
    dbInvoke: async () => ({ ok: true }),
  });

  assert.deepEqual({
    disabled: disabled.descriptors.map((tool) => tool.name),
    enabled: enabled.descriptors.map((tool) => tool.name),
  }, {
    disabled: ['supervised_ssh', 'knowledge_search'],
    enabled: ['supervised_ssh', 'knowledge_search', 'supervised_db'],
  });
});

test('descriptor БД содержит только list schema query и не раскрывает реквизиты', () => {
  const tools = createWorkTools({
    projectId: 'project-a',
    pluginEnabled: (id) => id === 'db',
    dbInvoke: async () => ({ ok: true }),
  });
  const descriptor = tools.descriptors.find((tool) => tool.name === 'supervised_db');
  const schema = JSON.stringify(descriptor || {});

  assert.deepEqual({
    found: Boolean(descriptor),
    actions: ['list', 'schema', 'query'].filter((action) => schema.includes(action)),
    privateFields: ['host', 'port', 'user', 'password'].filter((field) => schema.includes(field)),
  }, {
    found: true,
    actions: ['list', 'schema', 'query'],
    privateFields: [],
  });
});

test('состав work-tools задаёт реестр без fallback-списков у исполнителей', async () => {
  const files = [
    'server/src/lib/executors/index.js',
    'server/src/lib/executors/claude.js',
    'server/src/lib/executors/_claude-stream.js',
    'server/src/lib/executors/codex.js',
    'server/src/lib/kimi/runtime.js',
    'server/src/lib/executors/_ollama-tools.js',
    'server/src/lib/executors/work-ipc.js',
    'server/src/lib/executors/work-mcp.js',
  ];
  const offenders = [];
  for (const file of files) {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    if (/supervised_ssh|knowledge_search|supervised_db/u.test(source)) {
      offenders.push(file);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `имена рабочих tools продублированы вне реестра: ${offenders.join(', ')}`,
  );
});

test('Claude получает supervised_db в allowedTools только при включённом плагине', () => {
  const mcpConfig = {
    mcpServers: {
      'cockpit-work': { command: '/tmp/work-mcp', args: ['--socket', '/tmp/work.sock'] },
    },
  };
  const allowed = (enabled) => {
    const argv = claudeSessionArgs({
      permissionMode: 'default',
      mcpConfig,
      workTools: workTools(enabled),
    });
    return argv[argv.indexOf('--allowedTools') + 1]?.split(',').sort();
  };

  assert.deepEqual({ disabled: allowed(false), enabled: allowed(true) }, {
    disabled: [
      'mcp__cockpit-work__knowledge_search',
      'mcp__cockpit-work__supervised_ssh',
    ],
    enabled: [
      'mcp__cockpit-work__knowledge_search',
      'mcp__cockpit-work__supervised_db',
      'mcp__cockpit-work__supervised_ssh',
    ],
  });
});

test('Codex получает supervised_db в dynamicTools только при включённом плагине', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-db-codex-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'codex-fixture');
  await copyFile(new URL('../fixtures/codex-app-server/rich-turn-0.149.0.mjs', import.meta.url), bin);
  await chmod(bin, 0o755);
  const snapshots = {};
  for (const enabled of [false, true]) {
    const trace = path.join(root, `${enabled ? 'enabled' : 'disabled'}.jsonl`);
    await codex.run({
      config: { codexBin: bin },
      env: {
        ...process.env,
        COCKPIT_CODEX_FIXTURE_TRACE: trace,
        COCKPIT_CODEX_FIXTURE_SCENARIO: 'commentary-only',
        COCKPIT_CODEX_FIXTURE_CLI_VERSION: '0.150.1',
        COCKPIT_CODEX_FIXTURE_EXPECT_HOOK: '0',
      },
      message: 'проверь инструменты',
      cwd: root,
      model: 'gpt-contract-0.149',
      effort: 'medium',
      permissionMode: 'default',
      providerSettings: { blockDirectSsh: false },
      workTools: workTools(enabled),
    });
    const messages = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
    const dynamicTools = messages.find((entry) => (
      entry.direction === 'client' && entry.message?.method === 'thread/start'
    ))?.message.params.dynamicTools || [];
    snapshots[enabled ? 'enabled' : 'disabled'] = dynamicTools.map((tool) => tool.name).sort();
  }

  assert.deepEqual(snapshots, {
    disabled: ['knowledge_search', 'supervised_ssh'],
    enabled: ['knowledge_search', 'supervised_db', 'supervised_ssh'],
  });
});

test('Kimi считает supervised_db доверенным MCP-tool только при включённом плагине', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-db-kimi-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace');
  await mkdir(cwd, { recursive: true });
  const snapshots = {};
  for (const enabled of [false, true]) {
    const fakeProcess = new KimiDbPermissionProcess();
    let providerPrompts = 0;
    await runContainedKimi({
      config: {
        kimiLaunchMode: 'host',
        kimiRuntimeHome: path.join(root, `runtime-${enabled}`),
        kimiHome: path.join(root, `home-${enabled}`),
        chatsDir: path.join(root, `chat-data-${enabled}`),
        chatBindingsDir: path.join(root, `chat-data-${enabled}`, '.bindings'),
      },
      chatKey: `chat-db-${enabled}`,
      cwd,
      message: 'выполни запрос',
      model: 'kimi-code/k3',
      permissionMode: 'default',
      providerSettings: { blockDirectSsh: false },
      workTools: workTools(enabled),
      mcpServers: [{
        name: 'cockpit-work',
        command: '/usr/bin/socat',
        args: ['STDIO', 'UNIX-CONNECT:/tmp/work.sock'],
      }],
      onPermission: async () => {
        providerPrompts += 1;
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
    snapshots[enabled ? 'enabled' : 'disabled'] = {
      descriptors: descriptorNames(workTools(enabled)),
      providerPrompts,
      decision: fakeProcess.permissionResponse,
    };
  }

  assert.deepEqual(snapshots, {
    disabled: {
      descriptors: ['knowledge_search', 'supervised_ssh'],
      providerPrompts: 1,
      decision: { outcome: { outcome: 'selected', optionId: 'reject' } },
    },
    enabled: {
      descriptors: ['knowledge_search', 'supervised_db', 'supervised_ssh'],
      providerPrompts: 0,
      decision: { outcome: { outcome: 'selected', optionId: 'once' } },
    },
  });
});
