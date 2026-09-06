import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import claude from '../../server/src/lib/executors/claude.js';
import { claudeSessionArgs } from '../../server/src/lib/executors/_claude-stream.js';
import codex from '../../server/src/lib/executors/codex.js';
import { createToolbox } from '../../server/src/lib/executors/_ollama-tools.js';
import { runContainedKimi } from '../../server/src/lib/kimi/runtime.js';

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
  const module = await import('../../server/src/lib/executors/index.js');
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

test('реестр объявляет knowledge_search для поиска, чтения и правки без выбора проекта', async () => {
  const tools = await workTools({ projectId: 'project-a', invoke: async () => ({ ok: true }) });
  const descriptor = tools.descriptors.find((item) => item.name === 'knowledge_search');
  const schema = JSON.stringify(descriptor || {});

  assert.deepEqual({
    found: Boolean(descriptor),
    search: schema.includes('search'),
    read: schema.includes('read'),
    write: schema.includes('write'),
    honestDescription: /прав(?:ить|ка)|измен(?:ять|ение)|записывать/iu
      .test(descriptor?.description || ''),
    projectInput: schema.includes('project'),
  }, {
    found: true,
    search: true,
    read: true,
    write: true,
    honestDescription: true,
    projectInput: false,
  });
});

test('Схема knowledge_search различает четыре формы и требует все поля записи', async () => {
  const tools = await workTools({ projectId: 'project-a', invoke: async () => ({ ok: true }) });
  const descriptor = tools.descriptors.find((item) => item.name === 'knowledge_search');
  const branches = Array.isArray(descriptor?.inputSchema?.oneOf)
    ? descriptor.inputSchema.oneOf
    : [];
  const writeBranches = branches.filter((branch) => /"(?:const|enum)":"?write|"write"/u
    .test(JSON.stringify(branch)));
  const required = new Set(writeBranches.flatMap((branch) => {
    const recordRequired = branch?.properties?.record?.required || [];
    return [...(branch?.required || []), ...recordRequired];
  }));

  assert.deepEqual({
    branchCount: branches.length,
    writeBranchCount: writeBranches.length,
    rootType: descriptor?.inputSchema?.type,
    missingRequired: [
      'action', 'record', 'repository', 'kind', 'title', 'body', 'tags', 'id', 'revision',
    ].filter((field) => !required.has(field)),
  }, {
    branchCount: 4,
    writeBranchCount: 2,
    rootType: 'object',
    missingRequired: [],
  });
});

test('агентский knowledge_search не получает export и import', async () => {
  const tools = await workTools({ projectId: 'project-a', invoke: async () => ({ ok: true }) });
  const descriptor = tools.descriptors.find((item) => item.name === 'knowledge_search');
  const schema = JSON.stringify(descriptor || {});

  assert.deepEqual({
    found: Boolean(descriptor),
    export: /export|экспорт/iu.test(schema),
    import: /import|импорт/iu.test(schema),
  }, {
    found: true,
    export: false,
    import: false,
  });
});

test('knowledge_search навязывает task scope и очищает краткую выдачу от путей', async () => {
  const sentinel = '/tmp/private/knowledge.db';
  const calls = [];
  const tools = await workTools({
    projectId: 'project-a',
    invoke: async () => [],
    async knowledgeInvoke(scope, input) {
      calls.push({ scope, input });
      return {
        ok: true,
        items: [{
          id: '00000000-0000-4000-8000-000000000001',
          title: 'Очередь деплоя',
          tags: ['queue'],
          fragment: '…после деплоя…',
          project: 'project-a',
          body: 'полный текст',
          dbPath: sentinel,
        }],
        dbPath: sentinel,
      };
    },
  });
  const result = await tools.invoke('knowledge_search', {
    action: 'search', query: 'деплой', project: 'forged', limit: 3,
  });

  assert.deepEqual({ calls, result, leaked: JSON.stringify(result).includes(sentinel) }, {
    calls: [{
      scope: { projectId: 'project-a' },
      input: { action: 'search', query: 'деплой', limit: 3 },
    }],
    result: {
      ok: true,
      items: [{
        id: '00000000-0000-4000-8000-000000000001',
        title: 'Очередь деплоя',
        tags: ['queue'],
        fragment: '…после деплоя…',
      }],
    },
    leaked: false,
  });
});

test('knowledge_search в свободном чате читает общий корпус при null scope', async () => {
  const scopes = [];
  const tools = await workTools({
    projectId: null,
    invoke: async () => [],
    async knowledgeInvoke(scope) {
      scopes.push(scope);
      return { ok: true, items: [] };
    },
  });
  const result = await tools.invoke('knowledge_search', { action: 'search', query: 'очередь' });

  assert.deepEqual({ scopes, result }, {
    scopes: [{ projectId: null }],
    result: { ok: true, items: [] },
  });
});

test('knowledge_search проверяет live plugin gate на каждом вызове', async () => {
  let enabled = false;
  const tools = await workTools({
    projectId: 'project-a',
    invoke: async () => [],
    async knowledgeInvoke() {
      return enabled
        ? { ok: true, items: [] }
        : { ok: false, error: 'plugin_disabled' };
    },
  });
  const disabled = await tools.invoke('knowledge_search', { action: 'search', query: 'очередь' });
  enabled = true;
  const enabledResult = await tools.invoke('knowledge_search', {
    action: 'search', query: 'очередь',
  });

  assert.deepEqual({ disabled, enabled: enabledResult }, {
    disabled: { ok: false, error: 'plugin_disabled' },
    enabled: { ok: true, items: [] },
  });
});

test('knowledge_search read возвращает полный allowlist DTO без абсолютных путей', async () => {
  const sentinel = '/tmp/private/knowledge.db';
  const tools = await workTools({
    projectId: 'project-a',
    invoke: async () => [],
    async knowledgeInvoke() {
      return {
        ok: true,
        record: {
          id: '00000000-0000-4000-8000-000000000001',
          project: 'project-a',
          repository: 'main',
          kind: 'fact',
          title: 'Очередь деплоя',
          body: 'Полный текст.',
          tags: ['queue'],
          updatedAt: '2026-08-29T00:00:00.000Z',
          revision: 2,
          dbPath: sentinel,
        },
      };
    },
  });
  const result = await tools.invoke('knowledge_search', {
    action: 'read', id: '00000000-0000-4000-8000-000000000001',
  });

  assert.deepEqual(result, {
    ok: true,
    record: {
      id: '00000000-0000-4000-8000-000000000001',
      project: 'project-a',
      repository: 'main',
      kind: 'fact',
      title: 'Очередь деплоя',
      body: 'Полный текст.',
      tags: ['queue'],
      updatedAt: '2026-08-29T00:00:00.000Z',
      revision: 2,
    },
  });
});

test('knowledge_search очищает write-ввод и возвращает provenance в allowlist DTO', async () => {
  const sentinel = '/tmp/private/knowledge.db';
  const calls = [];
  const tools = await workTools({
    projectId: 'project-a',
    chatKey: 'chat-42',
    permissionMode: 'acceptEdits',
    invoke: async () => [],
    async knowledgeInvoke(scope, input) {
      calls.push({ scope, input });
      return {
        ok: true,
        record: {
          id: '00000000-0000-4000-8000-000000000044',
          project: 'project-a',
          repository: input.record.repository,
          kind: input.record.kind,
          title: input.record.title,
          body: input.record.body,
          tags: input.record.tags,
          updatedAt: '2026-08-30T00:00:00.000Z',
          revision: 1,
          provenance: { actor: 'executor', channel: 'chat', ref: 'chat-42' },
          dbPath: sentinel,
        },
      };
    },
  });
  const result = await tools.invoke('knowledge_search', {
    action: 'write',
    record: {
      repository: 'main',
      kind: 'fact',
      title: 'Новая запись',
      body: 'Точное тело.',
      tags: ['knowledge'],
      project: 'forged-project',
      provenance: { actor: 'human', channel: 'cli', ref: 'forged' },
      dbPath: sentinel,
    },
  });

  assert.deepEqual({ calls, result, leaked: JSON.stringify(result).includes(sentinel) }, {
    calls: [{
      scope: {
        projectId: 'project-a',
        chatKey: 'chat-42',
        permissionMode: 'acceptEdits',
      },
      input: {
        action: 'write',
        record: {
          repository: 'main',
          kind: 'fact',
          title: 'Новая запись',
          body: 'Точное тело.',
          tags: ['knowledge'],
        },
      },
    }],
    result: {
      ok: true,
      record: {
        id: '00000000-0000-4000-8000-000000000044',
        project: 'project-a',
        repository: 'main',
        kind: 'fact',
        title: 'Новая запись',
        body: 'Точное тело.',
        tags: ['knowledge'],
        updatedAt: '2026-08-30T00:00:00.000Z',
        revision: 1,
        provenance: { actor: 'executor', channel: 'chat', ref: 'chat-42' },
      },
    },
    leaked: false,
  });
});

test('knowledge_search сохраняет текущую ревизию в безопасном ответе конфликта', async () => {
  const tools = await workTools({
    projectId: 'project-a',
    chatKey: 'chat-42',
    permissionMode: 'acceptEdits',
    invoke: async () => [],
    async knowledgeInvoke() {
      return {
        ok: false,
        error: 'knowledge_conflict',
        currentRevision: 7,
        dbPath: '/tmp/private/knowledge.db',
      };
    },
  });

  const result = await tools.invoke('knowledge_search', {
    action: 'write',
    id: '00000000-0000-4000-8000-000000000044',
    revision: 6,
    record: {
      repository: 'main',
      kind: 'fact',
      title: 'Правка',
      body: 'Исправленный факт.',
      tags: ['knowledge'],
    },
  });

  assert.deepEqual(result, {
    ok: false,
    error: 'knowledge_conflict',
    currentRevision: 7,
  });
});

test('knowledge_search не превращает пустой id правки в создание записи', async () => {
  let calls = 0;
  const tools = await workTools({
    projectId: 'project-a',
    chatKey: 'chat-42',
    permissionMode: 'acceptEdits',
    invoke: async () => [],
    async knowledgeInvoke() {
      calls += 1;
      return { ok: true };
    },
  });

  const result = await tools.invoke('knowledge_search', {
    action: 'write',
    id: '',
    record: {
      repository: 'main',
      kind: 'fact',
      title: 'Правка',
      body: 'Исправленный факт.',
      tags: ['knowledge'],
    },
  });

  assert.deepEqual({ result, calls }, {
    result: { ok: false, error: 'invalid_arguments' },
    calls: 0,
  });
});

test('knowledge_search сохраняет безопасные metadata частичного отказа карты', async () => {
  const tools = await workTools({
    projectId: 'project-a',
    chatKey: 'chat-42',
    permissionMode: 'acceptEdits',
    invoke: async () => [],
    async knowledgeInvoke() {
      return {
        ok: false,
        error: 'maps_refresh_failed',
        committed: true,
        id: '00000000-0000-4000-8000-000000000044',
        revision: 8,
        dbPath: '/tmp/private/knowledge.db',
      };
    },
  });

  const result = await tools.invoke('knowledge_search', {
    action: 'write',
    record: {
      repository: 'main',
      kind: 'fact',
      title: 'Правка',
      body: 'Исправленный факт.',
      tags: ['knowledge'],
    },
  });

  assert.deepEqual(result, {
    ok: false,
    error: 'maps_refresh_failed',
    committed: true,
    id: '00000000-0000-4000-8000-000000000044',
    revision: 8,
  });
});

test('knowledge_search не принимает delete даже при переданной ревизии', async () => {
  let calls = 0;
  const tools = await workTools({
    projectId: 'project-a',
    invoke: async () => [],
    async knowledgeInvoke() {
      calls += 1;
      return { ok: true };
    },
  });

  const result = await tools.invoke('knowledge_search', {
    action: 'delete',
    id: '00000000-0000-4000-8000-000000000044',
    revision: 1,
  });

  assert.deepEqual({ result, calls }, {
    result: { ok: false, error: 'invalid_arguments' },
    calls: 0,
  });
});

test('реальный work MCP получает descriptors и выполняет tools/call через IPC', async (t) => {
  const { createWorkIpc } = await import('../../server/src/lib/executors/work-ipc.js');
  const calls = [];
  const work = await workTools({
    projectId: 'project-a',
    invoke: async () => [],
    async knowledgeInvoke(scope, input) {
      await new Promise((resolve) => setImmediate(resolve));
      calls.push({ scope, input });
      return { ok: true, items: [] };
    },
  });
  const ipc = await createWorkIpc({ workTools: work });
  t.after(() => ipc.close());
  const responses = await runMcpChild(ipc.mcpServer, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'knowledge_search',
        arguments: { action: 'search', query: 'деплой' },
      },
    },
  ]);

  assert.deepEqual({
    tools: responses[1]?.result?.tools?.map((tool) => tool.name),
    knowledgeRootType: responses[1]?.result?.tools
      ?.find((tool) => tool.name === 'knowledge_search')?.inputSchema?.type,
    calls,
    result: JSON.parse(responses[2]?.result?.content?.[0]?.text || 'null'),
  }, {
    tools: ['supervised_ssh', 'knowledge_search'],
    knowledgeRootType: 'object',
    calls: [{
      scope: { projectId: 'project-a' },
      input: { action: 'search', query: 'деплой' },
    }],
    result: { ok: true, items: [] },
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

test('Claude разрешает exact набор SSH и knowledge tools в one-shot и persistent ходах', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-knowledge-claude-argv-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'fake-claude');
  const trace = path.join(root, 'argv.json');
  await writeFile(bin, `#!/bin/sh
node -e '
  require("node:fs").writeFileSync(process.env.ARGV_TRACE, JSON.stringify(process.argv.slice(1)))
' -- "$@"
printf '%s\n' \
  '{"type":"result","subtype":"success","result":"ok","session_id":"knowledge-session","usage":{}}'
`);
  await chmod(bin, 0o755);
  const mcpConfig = {
    mcpServers: {
      'cockpit-work': { command: '/tmp/cockpit-work-mcp', args: ['--socket', '/tmp/work.sock'] },
    },
  };
  const descriptors = [
    { name: 'supervised_ssh', description: 'SSH', inputSchema: { type: 'object' } },
    { name: 'knowledge_search', description: 'Знания', inputSchema: { type: 'object' } },
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
      'mcp__cockpit-work__knowledge_search',
      'mcp__cockpit-work__supervised_ssh',
    ],
    persistent: [
      'mcp__cockpit-work__knowledge_search',
      'mcp__cockpit-work__supervised_ssh',
    ],
  });
});

test('Codex объявляет и диспатчит knowledge_search как dynamic tool', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-knowledge-codex-tool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'codex-fixture');
  const trace = path.join(root, 'trace.jsonl');
  await copyFile(new URL('../fixtures/codex-app-server/rich-turn-0.149.0.mjs', import.meta.url), bin);
  await chmod(bin, 0o755);
  const calls = [];
  const descriptor = {
    name: 'knowledge_search',
    description: 'Поиск и чтение знаний',
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
      COCKPIT_CODEX_FIXTURE_SCENARIO: 'knowledge-tool',
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

  const tool = run.steps.find((step) => step.k === 'tool' && step.id === 'knowledge-call-1');
  const result = run.steps.find((step) => step.k === 'res' && step.id === 'knowledge-call-1');

  assert.deepEqual({ declared, calls }, {
    declared: [{ type: 'function', ...descriptor }],
    calls: [{
      name: 'knowledge_search',
      input: { action: 'search', query: 'деплой', limit: 3 },
    }],
  });
  assert.equal(tool?.name, 'knowledge_search');
  assert.equal(result?.ok, true);
  assert.equal(JSON.parse(result?.text || '{}').items?.[0]?.title, 'Очередь деплоя');
});

test('Kimi auto-allow применяет exact knowledge tool без provider-подтверждения', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cockpit-knowledge-kimi-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(cwd, { recursive: true }));
  const fakeProcess = new KimiWorkMcpProcess('knowledge_search');
  let prompts = 0;
  await runContainedKimi({
    config: {
      kimiLaunchMode: 'host',
      kimiRuntimeHome: path.join(root, 'runtime'),
      kimiHome: path.join(root, 'home'),
      chatsDir: path.join(root, 'chats'),
      chatBindingsDir: path.join(root, 'chats', '.bindings'),
    },
    chatKey: 'chat-knowledge',
    cwd,
    message: 'search',
    model: 'kimi-code/k3',
    permissionMode: 'default',
    providerSettings: { blockDirectSsh: false },
    mcpServers: [{
      name: 'cockpit-work', command: '/usr/bin/socat', args: ['STDIO', 'UNIX-CONNECT:/tmp/work.sock'],
    }],
    onPermission: async () => {
      prompts += 1;
      return { allow: true };
    },
    deps: {
      assertVersion: async () => 'test',
      buildHostLaunch: async () => ({ command: 'fake', args: [], env: {}, cwdReal: cwd, unit: null }),
      spawn: () => fakeProcess,
      stopUnit: async () => {},
    },
  });

  assert.equal(prompts, 0);
});

test('Ollama объявляет и вызывает knowledge_search через общий dispatcher', async () => {
  const calls = [];
  const steps = [];
  const descriptor = {
    type: 'function',
    function: {
      name: 'knowledge_search',
      description: 'Поиск и чтение знаний',
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
    name: 'knowledge_search', args: { action: 'search', query: 'деплой' },
  });

  assert.deepEqual({
    title: steps.find((step) => step.k === 'tool')?.title,
    calls,
    result,
  }, {
    title: 'Поиск и чтение знаний',
    calls: [{ name: 'knowledge_search', input: { action: 'search', query: 'деплой' } }],
    result: { ok: true, items: [] },
  });
});
