import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runDeepSeekTurn } from '../../server/src/lib/deepseek/runtime.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE_ACP = path.join(REPO_ROOT, 'tests/fixtures/deepseek-harness/fakeAcp.mts');

async function waitFor(probe, attempts = 200) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('ожидаемое состояние не наступило');
}

async function fixture(t, scenario, { wrapChild } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-deepseek-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace');
  const launchDir = path.join(root, 'launch');
  const dshHome = path.join(root, 'home');
  const scenarioFile = path.join(root, 'scenario.json');
  const logFile = path.join(root, 'fake.ndjson');
  await Promise.all([cwd, launchDir, dshHome].map((dir) => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(path.join(launchDir, 'overlay.yml'), '[]\n');
  await fs.writeFile(scenarioFile, JSON.stringify(scenario));

  const children = [];
  const launchOptions = [];
  const deps = {
    prepareLaunch: async (options) => {
      launchOptions.push(options);
      return {
        launchDir,
        dshHome,
        overlayPath: path.join(launchDir, 'overlay.yml'),
      };
    },
    spawn: () => {
      const child = spawn(process.execPath, [FAKE_ACP, '--scenario', scenarioFile, '--log', logFile], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      children.push(child);
      wrapChild?.(child);
      return child;
    },
    closeTimeoutMs: 80,
    termTimeoutMs: 80,
  };
  return {
    root,
    cwd,
    logFile,
    children,
    launchOptions,
    base: {
      config: {
        deepseekRuntimeHome: path.join(root, 'runtime'),
        deepseekBin: path.join(root, 'fake-dsh'),
      },
      env: { ...process.env, DEEPSEEK_API_KEY: 'synthetic-runtime-key' },
      cwd,
      chatKey: 'chat-runtime-test',
      model: '["deepseek-official","deepseek-v4-flash"]',
      effort: 'high',
      message: 'hello',
      permissionMode: 'default',
      deps,
    },
  };
}

async function logEntries(file) {
  try {
    return (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
}

async function methods(file) {
  return (await logEntries(file))
    .filter((entry) => entry.kind === 'request' && entry.message?.method)
    .map((entry) => entry.message.method);
}

test('new → binding → config → один prompt; updates/usage/steps сохраняют порядок', async (t) => {
  const f = await fixture(t, {
    configOptions: [],
    updates: [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'same' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'same' } },
      { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'read', rawInput: { file_path: 'README.md' }, status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'duplicate' } }] },
      { sessionUpdate: 'usage_update', used: 123, size: 1000 },
    ],
  });
  let releaseBinding;
  const binding = new Promise((resolve) => { releaseBinding = resolve; });
  const progress = [];
  const run = runDeepSeekTurn({
    ...f.base,
    onSessionCreated: () => binding,
    onProgress: (tokens, info) => progress.push([tokens, info]),
  });

  await waitFor(async () => (await methods(f.logFile)).includes('session/new'));
  assert.equal((await methods(f.logFile)).includes('session/prompt'), false);
  releaseBinding();
  const out = await run;

  assert.equal(out.reply, 'samesame');
  assert.equal(out.contextTokens, 123);
  assert.equal(out.contextWindow, 1000);
  assert.equal(out.contextMetric, 'deepseek-acp-usage-update');
  assert.deepEqual(out.contextCache, { scope: 'request', status: 'unavailable' });
  assert.equal(out.retryState, 'post_prompt');
  assert.equal(out.steps.filter((step) => step.k === 'text').length, 2);
  assert.equal(out.steps.filter((step) => step.k === 'tool').length, 1);
  assert.equal(out.steps.filter((step) => step.k === 'res').length, 1);
  assert.equal(progress.at(-1)[0], 123);
  assert.deepEqual(await methods(f.logFile), [
    'initialize', 'session/new', 'session/set_config_option', 'session/set_config_option',
    'session/prompt', 'session/close',
  ]);
});

test('mcpServers без примесей дословно уходят в new и resume', async (t) => {
  const mcpServers = [{
    name: 'cockpit-work',
    command: process.execPath,
    args: ['/synthetic/work-mcp.mjs', '--nonce', 'fake'],
    env: [{ name: 'SYNTHETIC_SCOPE', value: 'one' }],
  }];
  const fresh = await fixture(t, {});
  await runDeepSeekTurn({ ...fresh.base, mcpServers });
  const freshRequest = (await logEntries(fresh.logFile))
    .find((entry) => entry.message?.method === 'session/new').message;
  assert.deepEqual(freshRequest.params.mcpServers, mcpServers);

  const resumed = await fixture(t, {});
  await runDeepSeekTurn({ ...resumed.base, sessionId: 'saved-session', mcpServers });
  const resumeRequest = (await logEntries(resumed.logFile))
    .find((entry) => entry.message?.method === 'session/resume').message;
  assert.deepEqual(resumeRequest.params.mcpServers, mcpServers);
});

test('режимы выбирают честные sandbox/approval до spawn, неизвестный режим не запускается', async (t) => {
  const chat = await fixture(t, {});
  await runDeepSeekTurn({ ...chat.base, permissionMode: 'auto' });
  assert.deepEqual({
    mode: chat.launchOptions[0].mode,
    approval: chat.launchOptions[0].approval,
  }, { mode: 'workspace-write', approval: 'ask' });

  const factory = await fixture(t, {});
  await runDeepSeekTurn({
    ...factory.base,
    permissionMode: 'read-only',
    factory: true,
  });
  assert.deepEqual({
    mode: factory.launchOptions[0].mode,
    approval: factory.launchOptions[0].approval,
  }, { mode: 'read-only', approval: 'never' });

  const invalid = await fixture(t, {});
  await assert.rejects(runDeepSeekTurn({
    ...invalid.base,
    permissionMode: 'transactional-write',
  }), /неизвестный режим/u);
  assert.equal(invalid.children.length, 0);
  assert.equal(invalid.launchOptions.length, 0);
});

test('read-only отвечает reject-once на реальный reverse request без UI', async (t) => {
  const f = await fixture(t, {
    updates: [{
      sessionUpdate: 'tool_call',
      toolCallId: 'permission-tool',
      title: 'write',
      rawInput: { file_path: '../outside.txt', sandbox_permissions: 'danger-full-access' },
    }],
    permission: { toolCallId: 'permission-tool' },
  });
  let calls = 0;
  await runDeepSeekTurn({
    ...f.base,
    permissionMode: 'read-only',
    onPermission: async () => { calls += 1; return { allow: true }; },
  });
  const response = (await logEntries(f.logFile))
    .find((entry) => entry.kind === 'permission_response').message;
  assert.deepEqual(response.result, {
    outcome: { outcome: 'selected', optionId: 'reject-once' },
  });
  assert.equal(calls, 0);
});

test('невалидный MCP command отклоняется до spawn', async (t) => {
  const f = await fixture(t, {});
  await assert.rejects(runDeepSeekTurn({
    ...f.base,
    mcpServers: [{ name: 'cockpit-work', command: 'relative-command', args: [], env: [] }],
  }), /абсолютную command/u);
  assert.equal(f.children.length, 0);

  await assert.rejects(runDeepSeekTurn({
    ...f.base,
    mcpServers: [{ name: 'cockpit-work', command: process.execPath, args: [] }],
  }), /\.env повреждён/u);
  assert.equal(f.children.length, 0);
});

test('неизвестные model/effort отклоняются после metadata и до prompt', async (t) => {
  const configOptions = [
    {
      id: 'model',
      category: 'model',
      options: [{ options: [{ value: 'known-model', name: 'Known' }] }],
    },
    {
      id: 'reasoning_effort',
      category: 'thought_level',
      options: [{ value: 'high', name: 'High' }],
    },
  ];
  const badModel = await fixture(t, { configOptions });
  await assert.rejects(runDeepSeekTurn({
    ...badModel.base,
    model: 'invented-model',
    effort: 'high',
  }), /модель не поддерживается/u);
  assert.equal((await methods(badModel.logFile)).includes('session/prompt'), false);

  const badEffort = await fixture(t, { configOptions });
  await assert.rejects(runDeepSeekTurn({
    ...badEffort.base,
    model: 'known-model',
    effort: 'ultra',
  }), /effort не поддерживается/u);
  assert.equal((await methods(badEffort.logFile)).includes('session/prompt'), false);
});

test('ошибка binding закрывает session без prompt', async (t) => {
  const f = await fixture(t, {});
  await assert.rejects(runDeepSeekTurn({
    ...f.base,
    onSessionCreated: async () => { throw new Error('binding-store-failed'); },
  }), (error) => error.retryState === 'pre_prompt' && /binding-store-failed/.test(error.message));
  const seen = await methods(f.logFile);
  assert.ok(seen.includes('session/close'));
  assert.equal(seen.includes('session/prompt'), false);
});

test('resume не падает обратно на new и получает отдельный код', async (t) => {
  const f = await fixture(t, {
    errors: { 'session/resume': { code: -32602, message: 'session cwd does not match' } },
  });
  await assert.rejects(runDeepSeekTurn({
    ...f.base,
    sessionId: 'saved-session',
  }), (error) => error.code === 'deepseek_session_resume_failed' && error.retryState === 'pre_prompt');
  const seen = await methods(f.logFile);
  assert.ok(seen.includes('session/resume'));
  assert.equal(seen.includes('session/new'), false);
  assert.equal(seen.includes('session/prompt'), false);
});

test('EOF до/после prompt различает retryState и не повторяет prompt', async (t) => {
  const before = await fixture(t, { eof: 'after_session_new' });
  await assert.rejects(runDeepSeekTurn(before.base), (error) => error.retryState === 'pre_prompt');

  const after = await fixture(t, { eof: 'before_prompt_response' });
  await assert.rejects(runDeepSeekTurn(after.base), (error) => error.retryState === 'post_prompt');
  assert.equal((await methods(after.logFile)).filter((method) => method === 'session/prompt').length, 1);
});

test('abort шлёт session/cancel, получает cancelled и не оставляет sleep', async (t) => {
  const marker = `deepseek-fake-sleep-${process.pid}-${Date.now()}`;
  const f = await fixture(t, { waitForCancel: true, spawnSleepMarker: marker });
  const controller = new AbortController();
  const run = runDeepSeekTurn({ ...f.base, signal: controller.signal });
  const spawned = await waitFor(async () => (await logEntries(f.logFile)).find((entry) => entry.kind === 'spawned'));
  controller.abort();
  const out = await run;

  assert.equal(out.stopReason, 'cancelled');
  assert.ok((await methods(f.logFile)).includes('session/cancel'));
  await waitFor(() => {
    try { process.kill(spawned.pid, 0); return false; } catch { return true; }
  });
});

test('cancel во время permission игнорирует поздний allow-once', async (t) => {
  const f = await fixture(t, { permission: { toolCallId: 'permission-tool' } });
  const controller = new AbortController();
  let resolvePermission;
  const asked = new Promise((resolve) => { resolvePermission = resolve; });
  let markAsked;
  const wasAsked = new Promise((resolve) => { markAsked = resolve; });
  const run = runDeepSeekTurn({
    ...f.base,
    signal: controller.signal,
    onPermission: async () => {
      markAsked();
      return asked;
    },
  });
  await wasAsked;
  controller.abort();
  const out = await run;
  assert.equal(out.stopReason, 'cancelled');
  resolvePermission({ allow: true });
  await new Promise((resolve) => setImmediate(resolve));
  const entries = await logEntries(f.logFile);
  assert.equal(entries.some((entry) => entry.kind === 'permission_response'), false);
});

test('неизвестный reverse method получает error, но ход продолжается', async (t) => {
  const f = await fixture(t, { permission: { method: 'unknown/reverse' } });
  const out = await runDeepSeekTurn(f.base);
  assert.equal(out.stopReason, 'end_turn');
  const response = (await logEntries(f.logFile)).find((entry) => entry.kind === 'permission_response');
  assert.equal(response.message.error.code, -32603);
});

test('зависший close проходит SIGTERM → SIGKILL и возвращается', async (t) => {
  const signals = [];
  const f = await fixture(t, { hangOnClose: true, ignoreTerm: true }, {
    wrapChild(child) {
      const kill = child.kill.bind(child);
      child.kill = (signal) => { signals.push(signal); return kill(signal); };
    },
  });
  const out = await runDeepSeekTurn(f.base);
  assert.equal(out.stopReason, 'end_turn');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('без usage не придумывает нули; unsupported inputs дают одну note', async (t) => {
  const f = await fixture(t, {
    updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }],
  });
  const out = await runDeepSeekTurn({
    ...f.base,
    extraDirs: ['/ignored'],
    attachmentPaths: ['/ignored/file'],
  });
  assert.equal('contextTokens' in out, false);
  assert.equal('contextWindow' in out, false);
  assert.equal(out.contextMetric, 'unavailable');
  assert.equal(out.steps.filter((step) => step.k === 'note').length, 1);

  // Доверенные каталоги — постоянная настройка: при resume той же сессии note о них
  // не повторяется, а разовые вложения по-прежнему получают предупреждение.
  const resumedDirs = await fixture(t, {
    updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }],
  });
  const quiet = await runDeepSeekTurn({
    ...resumedDirs.base, sessionId: 'saved-session', extraDirs: ['/ignored'],
  });
  assert.equal(quiet.steps.filter((step) => step.k === 'note').length, 0);
  const resumedFiles = await fixture(t, {
    updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }],
  });
  const loud = await runDeepSeekTurn({
    ...resumedFiles.base, sessionId: 'saved-session', attachmentPaths: ['/ignored/file'],
  });
  assert.deepEqual(loud.steps.filter((step) => step.k === 'note').map((step) => step.text), [
    'DeepSeek V1 пишет только в cwd: вложения не добавлены в рабочую область',
  ]);
});

test('обрыв хода harness-ом после старта — delivery failure с лентой, а не исключение', async (t) => {
  const cut = await fixture(t, {
    updates: [
      { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'bash', rawInput: { command: 'ls' } },
      {
        sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      },
    ],
    promptError: {
      code: -32603,
      message: 'Internal error: turn failed: DeepSeek API request to https://api.deepseek.com failed',
    },
  });
  const out = await runDeepSeekTurn({ ...cut.base });
  assert.equal(out.deliveryFailure, true);
  assert.equal(out.reply, 'DeepSeek API request to https://api.deepseek.com failed');
  assert.equal(out.stopReason, 'error');
  assert.equal(out.retryState, 'post_prompt');
  assert.ok(out.sessionId);
  // Лента сохраняется: сделанная до обрыва работа не выглядит выброшенной.
  assert.ok(out.steps.some((step) => step.k === 'tool'));
  // Сессия закрывается штатно, процесс не остаётся.
  assert.ok((await methods(cut.logFile)).includes('session/close'));

  // Отказ ключа на prompt — не обрыв: продолжать нечего, ошибка остаётся ошибкой.
  const badKey = await fixture(t, {
    promptError: {
      code: -32603,
      message: 'Internal error: turn failed: Authentication Fails, Your api key: ****-key is invalid',
    },
  });
  await assert.rejects(runDeepSeekTurn({ ...badKey.base }), (error) => (
    /Authentication Fails/u.test(error.message) && error.retryState === 'post_prompt'
  ));
});
