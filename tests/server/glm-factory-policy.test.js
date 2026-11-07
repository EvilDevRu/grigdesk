import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GLM_FACTORY_PROFILE_REVISION,
  GLM_PROFILE_REVISION,
} from '../../server/src/lib/glm/contract.ts';
import {
  decideGlmFactoryTool,
  glmFactoryPolicy,
  parseGlmFactoryToolPolicy,
} from '../../server/src/lib/glm/factoryPolicy.ts';
import { glmMcpStartupError, selectGlmMcpServers } from '../../server/src/lib/glm/mcp.ts';
import { createGlmTurnGuard } from '../../server/src/lib/glm/permissions.ts';
import { glmArgumentsHash, glmMcpToolName } from '../../server/src/lib/glm/policy.ts';
import {
  GLM_POLICY_HOOK_PATH,
  buildGlmLaunchFiles,
  glmLaunchFingerprint,
} from '../../server/src/lib/glm/profile.ts';
import { runtimeYaml } from '../../deepseek/scripts/runtimeComposition.ts';
import { testDeepSeekRuntimeDependencies } from '../helpers/deepseekBinary.mts';

const DEPENDENCIES = await testDeepSeekRuntimeDependencies();

const STATUS_TOOLS = ['stage_progress', 'stage_result']
  .map((name) => glmMcpToolName('factory-status', name));

/**
 * Временный проект с вложенным cwd для сборки профиля без процессов.
 * Каталог удаляется после теста, настоящая папка данных не используется.
 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-factory-policy-'));
  const project = path.join(root, 'project');
  const cwd = path.join(project, 'nested');

  await fs.mkdir(path.join(project, '.git'), { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  return {
    root,
    project,
    cwd,
  };
}

function launchOptions(f, name, overrides = {}) {
  return {
    launchDir: path.join(f.root, name),
    cwd: f.cwd,
    workspaceRoot: f.cwd,
    projectRoot: f.project,
    accessMode: 'api',
    model: 'glm-5.3',
    transport: 'web',
    settingsDocument: path.join(f.root, 'settings.yaml'),
    hooks: {
      ssh: true,
      db: true,
      strictDb: true,
    },
    ...overrides,
  };
}

async function overlayRows(files) {
  return runtimeYaml(DEPENDENCIES.directory).load(await fs.readFile(files.overlayPath, 'utf8'));
}

test('SB07: headless GLM сохраняет ФС-политику и не ждёт вопросов', () => {
  assert.deepEqual(glmFactoryPolicy('state-only'), {
    mode: 'workspace-write',
    approval: 'never',
    allowQuestions: false,
  });
  assert.deepEqual(glmFactoryPolicy('workspace-write'), {
    mode: 'workspace-write',
    approval: 'never',
    allowQuestions: false,
  });
  assert.throws(() => glmFactoryPolicy('full-access'));
});

test('SB07-profile: factory context выбирает preset без вопросов и свою ревизию', async (t) => {
  const f = await fixture(t);
  const expected = {
    'state-only': { mode: 'workspace-write', preset: 'factory-workspace-write' },
    'workspace-write': { mode: 'workspace-write', preset: 'factory-workspace-write' },
  };

  for (const filesystem of ['state-only', 'workspace-write']) {
    const files = await buildGlmLaunchFiles(launchOptions(f, filesystem, { factory: { filesystem } }));
    const rows = await overlayRows(files);
    const byId = new Map(rows.filter((row) => row.id).map((row) => [row.id, row]));
    const overlay = await fs.readFile(files.overlayPath, 'utf8');
    const hooks = await fs.readFile(files.hooksPath, 'utf8');
    const policy = JSON.parse(await fs.readFile(path.join(f.root, filesystem, 'glm-policy.json'), 'utf8'));

    assert.equal(byId.get('sandbox-policy')?.config.mode, expected[filesystem].mode);
    assert.deepEqual(byId.get('approval')?.config, { policy: 'never' });
    assert.equal(byId.get('permission')?.config.defaultPreset, expected[filesystem].preset);
    assert.equal(files.fingerprint, glmLaunchFingerprint({
      revision: GLM_FACTORY_PROFILE_REVISION,
      overlay,
      hooks,
    }));
    assert.deepEqual(policy, {
      format: 1,
      consumer: 'factory',
      filesystem,
      ...(filesystem === 'state-only' ? { stateDir: f.cwd } : {}),
      rawTools: STATUS_TOOLS,
    });
  }

  const chat = await buildGlmLaunchFiles(launchOptions(f, 'chat'));
  const chatPolicy = JSON.parse(await fs.readFile(path.join(f.root, 'chat', 'glm-policy.json'), 'utf8'));

  assert.notEqual(GLM_FACTORY_PROFILE_REVISION, GLM_PROFILE_REVISION);
  assert.equal(chat.fingerprint, glmLaunchFingerprint({
    revision: GLM_PROFILE_REVISION,
    overlay: await fs.readFile(chat.overlayPath, 'utf8'),
    hooks: await fs.readFile(chat.hooksPath, 'utf8'),
  }));
  assert.equal(Object.hasOwn(chatPolicy, 'consumer'), false);
  await assert.rejects(buildGlmLaunchFiles(launchOptions(f, 'bad', { factory: { filesystem: 'full' } })),
    { code: 'glm_factory_policy_unsupported' });
});

const FACTORY_POLICY = {
  format: 1,
  consumer: 'factory',
  filesystem: 'workspace-write',
  rawTools: STATUS_TOOLS,
};

/**
 * Запускает настоящий hook политики с документом этапа, как его вызывает DSH.
 * Решение читается по коду выхода, дескриптор вызова — из stderr.
 */
async function runHook(t, policy, payload) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-factory-hook-'));
  const policyFile = path.join(root, 'glm-policy.json');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(policyFile, JSON.stringify(policy));

  const child = spawn(process.execPath, [GLM_POLICY_HOOK_PATH, '--policy', policyFile], {
    env: { PATH: '/usr/bin:/bin' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';

  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdin.end(JSON.stringify(payload));

  const code = await new Promise((resolve) => child.once('exit', resolve));

  return {
    code,
    stderr,
    descriptor: stderr.split('\n').filter((line) => line.startsWith('GLM-POLICY '))
      .map((line) => JSON.parse(line.slice('GLM-POLICY '.length)))[0],
  };
}

function preToolUse(name, input = {}, id = 'call-1') {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: name,
    tool_input: input,
    tool_use_id: id,
  };
}

function hookResult(descriptor, turn = 1) {
  return {
    type: 'hook/result',
    data: {
      turn,
      exitCode: 0,
      stderrSummary: `GLM-POLICY ${JSON.stringify(descriptor)}`,
    },
  };
}

test('SB07b: factory parser принимает только точный статусный inventory', () => {
  assert.deepEqual(parseGlmFactoryToolPolicy(FACTORY_POLICY), FACTORY_POLICY);

  const broken = [
    { ...FACTORY_POLICY, rawTools: [STATUS_TOOLS[0]] },
    { ...FACTORY_POLICY, rawTools: [...STATUS_TOOLS, 'mcp__factory-status__extra'] },
    { ...FACTORY_POLICY, rawTools: [STATUS_TOOLS[0], 'mcp__factory-status__*'] },
    { ...FACTORY_POLICY, rawTools: [STATUS_TOOLS[0], STATUS_TOOLS[0]] },
    { ...FACTORY_POLICY, consumer: 'chat' },
    { ...FACTORY_POLICY, format: 2 },
    { ...FACTORY_POLICY, filesystem: 'full-access' },
    { ...FACTORY_POLICY, workTools: [] },
    null,
    [],
    'factory',
  ];

  for (const value of broken) {
    assert.throws(() => parseGlmFactoryToolPolicy(value), { code: 'glm_factory_policy_invalid' },
      JSON.stringify(value));
  }
});

test('SB07b: решение этапа — точный статус, без вопросов и с записью только в STATE_DIR', async (t) => {
  const f = await fixture(t);
  const write = parseGlmFactoryToolPolicy(FACTORY_POLICY);
  const state = parseGlmFactoryToolPolicy({
    ...FACTORY_POLICY,
    filesystem: 'state-only',
    stateDir: f.cwd,
  });

  for (const policy of [write, state]) {
    for (const name of STATUS_TOOLS) {
      assert.equal(decideGlmFactoryTool(name, {}, policy).allow, true, name);
    }

    for (const name of ['mcp__factory-status-extra__stage_result', 'mcp__grigdesk-work__repo_history',
      'mcp__factory-status__other', 'tool-subagent']) {
      assert.equal(decideGlmFactoryTool(name, {}, policy).allow, false, name);
    }

    assert.deepEqual(decideGlmFactoryTool('ask_user_question', {}, policy).allow, false);
    assert.equal(decideGlmFactoryTool('ask_user_question', {}, policy).kind, 'question');
    assert.equal(decideGlmFactoryTool('read', { file_path: 'a' }, policy).allow, true);
    assert.equal(decideGlmFactoryTool('bash', { command: 'ssh fixture-host' }, policy).allow, false);
    assert.equal(decideGlmFactoryTool('bash', { command: 'mysql -h fixture' }, policy).allow, false);
    assert.equal(decideGlmFactoryTool('bash', { command: 'ls' }, policy).allow, true);
  }

  for (const name of ['write', 'edit']) {
    assert.equal(decideGlmFactoryTool(name, { file_path: 'a' }, write).allow, true, name);
    assert.equal(decideGlmFactoryTool(name, { file_path: 'a' }, state).allow, true, name);
    assert.equal(decideGlmFactoryTool(name, { file_path: path.join(f.project, 'a') }, state).allow,
      false, name);
  }
});

test('SB07b: state-only требует физический корень и запрещает обход файловой границы', async (t) => {
  const f = await fixture(t);
  const state = {
    ...FACTORY_POLICY,
    filesystem: 'state-only',
    stateDir: f.cwd,
  };

  await fs.symlink(f.project, path.join(f.cwd, 'escape'));
  await fs.symlink(path.join(f.project, 'missing'), path.join(f.cwd, 'dangling'));

  for (const stateDir of [undefined, '', 'relative', path.join(f.root, 'missing'),
    path.join(f.cwd, 'escape'), `${f.cwd}/../nested`]) {
    assert.throws(() => parseGlmFactoryToolPolicy({ ...state, stateDir }),
      { code: 'glm_factory_policy_invalid' });
  }

  const policy = parseGlmFactoryToolPolicy(state);

  for (const name of ['write', 'edit']) {
    for (const file of ['artifact.md', 'new/nested/artifact.md', path.join(f.cwd, 'artifact.md')]) {
      assert.equal(decideGlmFactoryTool(name, { file_path: file }, policy).allow, true, file);
    }

    for (const input of [{}, { file_path: null }, { file_path: '' }, { file_path: 'bad\0path' },
      { file_path: '../outside.md' }, { file_path: `${f.cwd}-other/artifact.md` },
      { file_path: 'escape/../outside.md' },
      { file_path: 'escape/outside.md' }, { file_path: 'dangling' }]) {
      assert.equal(decideGlmFactoryTool(name, input, policy).allow, false, JSON.stringify(input));
    }
  }
});

test('веб-инструменты доступны обоим файловым режимам Factory через настоящий hook', async (t) => {
  const f = await fixture(t);
  const calls = [
    ['web_search', { query: 'Harness documentation' }, 'search'],
    ['web_fetch', { url: 'https://example.com/' }, 'read'],
  ];

  for (const filesystem of ['state-only', 'workspace-write']) {
    const policy = parseGlmFactoryToolPolicy({
      ...FACTORY_POLICY,
      filesystem,
      ...(filesystem === 'state-only' ? { stateDir: f.cwd } : {}),
    });

    for (const [name, input, kind] of calls) {
      assert.deepEqual(decideGlmFactoryTool(name, input, policy), {
        allow: true,
        kind,
        reason: '',
      });

      const result = await runHook(t, policy, preToolUse(name, input));

      assert.equal(result.code, 0, `${filesystem}: ${name}`);
      assert.equal(result.descriptor.kind, kind);
      assert.equal(result.descriptor.decision, 'allow');
    }
  }
});

test('SB07b: настоящий hook различает потребителя и закрыт при порче документа', async (t) => {
  const alive = await runHook(t, FACTORY_POLICY, { hook_event_name: 'UserPromptSubmit' });
  const status = await runHook(t, FACTORY_POLICY, preToolUse(STATUS_TOOLS[1], { result: 'done' }));

  assert.equal(alive.code, 0);
  assert.equal(alive.descriptor.marker, 'hooks-alive');
  assert.equal(status.code, 0);
  assert.equal(status.descriptor.decision, 'allow');
  assert.equal(status.descriptor.name, STATUS_TOOLS[1]);
  assert.equal(status.descriptor.sha256, glmArgumentsHash({ result: 'done' }));

  const f = await fixture(t);
  const state = {
    ...FACTORY_POLICY,
    filesystem: 'state-only',
    stateDir: f.cwd,
  };

  for (const name of ['write', 'edit']) {
    assert.equal((await runHook(t, state, preToolUse(name, { file_path: 'artifact.md' }))).code, 0);
    assert.equal((await runHook(t, state, preToolUse(name, { file_path: '../outside.md' }))).code, 2);
  }

  for (const [policy, payload] of [
    [FACTORY_POLICY, preToolUse('mcp__factory-status-extra__stage_result')],
    [FACTORY_POLICY, preToolUse('ask_user_question', { questions: [] })],
    [{ ...FACTORY_POLICY, filesystem: 'state-only' }, preToolUse('write', { file_path: 'a' })],
    [{ ...FACTORY_POLICY, rawTools: [] }, preToolUse(STATUS_TOOLS[1])],
    [{ ...FACTORY_POLICY, consumer: 'chat' }, preToolUse('read', { file_path: 'a' })],
  ]) {
    assert.equal((await runHook(t, policy, payload)).code, 2, JSON.stringify(payload));
  }
});

test('SB07b: turn guard и mount выбирают один набор статусных имён', () => {
  const guard = createGlmTurnGuard({
    workTools: [],
    rawMcpTools: STATUS_TOOLS,
    hostServer: 'factory-status',
    waitMs: 0,
  });
  const chat = createGlmTurnGuard({ workTools: ['repo_history'], waitMs: 0 });
  const call = (callId, name, input = {}) => ({
    type: 'tool/call',
    data: {
      turn: 1,
      callId,
      name,
      arguments: JSON.stringify(input),
    },
  });
  const result = (callId, isError = false, text = 'ok') => ({
    type: 'tool/result',
    data: {
      message: {
        source: { callId },
        content: [{
          toolCallId: callId,
          isError,
          content: [{ type: 'text', text }],
        }],
      },
    },
  });

  assert.equal(guard.autoApprove(STATUS_TOOLS[0]), true);
  assert.equal(guard.autoApprove('mcp__grigdesk-work__repo_history'), false);
  assert.equal(guard.autoApprove('mcp__factory-status-extra__stage_result'), false);
  assert.equal(chat.autoApprove('mcp__grigdesk-work__repo_history'), true);
  assert.equal(chat.autoApprove(STATUS_TOOLS[1]), false);

  guard.inspect(hookResult({ event: 'UserPromptSubmit', marker: 'hooks-alive' }));
  assert.equal(guard.inspect(call('call-1', STATUS_TOOLS[1], { result: 'done' })), null);
  guard.inspect(hookResult({
    event: 'PreToolUse',
    tool_use_id: 'call-1',
    name: STATUS_TOOLS[1],
    sha256: glmArgumentsHash({ result: 'done' }),
    kind: 'mcp',
    decision: 'allow',
  }));
  assert.equal(guard.inspect(result('call-1')), null);

  assert.equal(guard.inspect(call('call-2', STATUS_TOOLS[0])), null);
  guard.inspect(hookResult({
    event: 'PreToolUse',
    tool_use_id: 'call-2',
    name: STATUS_TOOLS[0],
    sha256: glmArgumentsHash({}),
    kind: 'mcp',
    decision: 'allow',
  }));
  assert.equal(guard.inspect(result('call-2', true, 'Not connected'))?.code, 'glm_mcp_not_ready');
  assert.equal(chat.inspect(result('call-2', true, 'Not connected'))?.code, 'glm_policy_hook_missing');

  assert.equal(guard.inspect(call('call-3', 'mcp__factory-status-extra__stage_result')), null);
  assert.equal(guard.inspect(result('call-3'))?.code, 'glm_policy_hook_missing');

  const status = {
    name: 'factory-status',
    command: '/R/node',
    args: ['status.mjs'],
    env: [],
  };
  const work = {
    name: 'grigdesk-work',
    command: '/R/node',
    args: ['work.mjs'],
    env: [],
  };
  const selected = selectGlmMcpServers({
    chat: [status, work],
    project: [{ ...status, command: '/project/status' }, { ...work, name: 'fixture' }],
    hostServer: 'factory-status',
  });

  assert.deepEqual(selected.mounted, [status]);
  assert.deepEqual(selected.excluded.map((entry) => [entry.name, entry.reason]), [
    ['grigdesk-work', 'project_unsupported'],
    ['factory-status', 'reserved'],
    ['fixture', 'project_unsupported'],
  ]);
  assert.deepEqual(selectGlmMcpServers({ chat: [status, work], project: [] }).mounted, [work]);

  const startup = 'mcp-client(factory-status): initial connection or tool synchronization failed';

  assert.equal(glmMcpStartupError(startup, 'factory-status')?.code, 'glm_mcp_not_ready');
  assert.equal(glmMcpStartupError(startup), null);
});
