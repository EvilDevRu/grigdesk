import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { glmCompatibilityIdentity } from '../../server/src/lib/glm/contract.ts';
import { GLM_FACTORY_STATUS_TOOLS } from '../../server/src/lib/glm/factoryPolicy.ts';
import { describeGlmGeneration } from '../../server/src/lib/glm/generation.ts';
import { runGlmTurn } from '../../server/src/lib/glm/runtime.ts';
import { runtimeYaml } from '../../deepseek/scripts/runtimeComposition.ts';
import { testDeepSeekRuntimeDependencies } from '../helpers/deepseekBinary.mts';
import { GLM_FIXTURE_PLUGIN, writeGlmArtifactFixture } from '../helpers/glmArtifactFixture.mts';

const DEPENDENCIES = await testDeepSeekRuntimeDependencies();

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE_WEB = path.join(REPO_ROOT, 'tests/fixtures/deepseek-harness/fakeWeb.mjs');
const MODEL = '["zai","glm-5.3"]';
const CATALOG = [{ id: MODEL, efforts: ['low', 'high', 'max'] }];
const IDENTITY = {
  task: '900123',
  stage: 'IMPLEMENT',
  runId: 'run-fixture.1',
  epoch: '3',
};
const [PROGRESS, RESULT] = GLM_FACTORY_STATUS_TOOLS;

/**
 * Ожидание состояния без sleep-цикла в тесте: короткий опрос с пределом попыток.
 * Предел превращает зависание в понятный провал, а не в таймаут всего файла.
 */
async function waitFor(probe, attempts = 500) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await probe();

    if (value) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('ожидаемое состояние не наступило');
}

/**
 * Host-owned статусный MCP этапа: identity в env совпадает с контекстом хода.
 * Команда абсолютная, но в фейковом DSH сервер не запускается.
 */
function statusServer(root, overrides = {}) {
  return {
    name: 'factory-status',
    command: path.join(root, 'runtime/node/bin/node'),
    args: [path.join(root, 'factory-status-mcp.mjs')],
    env: [
      { name: 'FACTORY_RUN_TASK', value: IDENTITY.task },
      { name: 'FACTORY_RUN_STAGE', value: IDENTITY.stage },
      { name: 'FACTORY_RUN_ID', value: IDENTITY.runId },
      { name: 'FACTORY_RUN_EPOCH', value: IDENTITY.epoch },
      { name: 'FACTORY_STATUS_MODE', value: 'request' },
      { name: 'FACTORY_STATUS_REQUEST_DIR', value: path.join(root, 'control/requests') },
      { name: 'FACTORY_LOOP_ROLE', value: '' },
    ],
    ...overrides,
  };
}

/**
 * Стенд хода GLM этапа: generation-фикстура, чей entry запускает фейковый DSH web.
 * Spawn снимает launch-файлы в момент запуска: после хода каталог запуска удаляется.
 */
async function fixture(t, scenario = { updates: [] }, envOverrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-factory-turn-'));
  const project = path.join(root, 'project');
  const stateDir = path.join(root, 'state');
  const runDir = path.join(root, 'run');
  const scenarioFile = path.join(root, 'scenario.json');
  const logFile = path.join(root, 'fake.ndjson');
  const artifact = path.join(root, 'generation');
  const children = [];
  const launches = [];

  await fs.mkdir(path.join(project, '.git'), { recursive: true });
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(scenarioFile, JSON.stringify(scenario));
  await fs.writeFile(logFile, '');
  await writeGlmArtifactFixture(artifact, {
    llmPiAi: GLM_FIXTURE_PLUGIN,
    entry: [
      'if (process.argv[2] === "-V") { console.log("0.1.5-rc.2"); process.exit(0); }',
      `process.argv.push("--scenario", ${JSON.stringify(scenarioFile)},`
        + ` "--log", ${JSON.stringify(logFile)});`,
      `await import(${JSON.stringify(pathToFileURL(FAKE_WEB).href)});`,
      '',
    ].join('\n'),
  });
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }

    await fs.rm(root, { recursive: true, force: true });
  });

  const config = {
    rootDir: root,
    deepseekBin: path.join(artifact, 'deepseek'),
    deepseekRuntimeMode: 'binary',
    glmRuntimeHome: path.join(runDir, 'glm/runtime'),
  };
  const identity = glmCompatibilityIdentity(describeGlmGeneration(config).runtime, 'api');
  const env = {
    PATH: process.env.PATH,
    GRIGDESK_GLM_API_MODE: 'api',
    ZAI_API_KEY: 'synthetic-zai-key',
    ...envOverrides,
  };
  const deps = {
    env,
    admission: [
      { mode: 'api', compatibility: identity },
      { mode: 'coding-plan', compatibility: glmCompatibilityIdentity(describeGlmGeneration(config).runtime,
        'coding-plan') },
    ],
    catalog: CATALOG,
    spawn: (command, args, options) => {
      const overlayPath = args[args.indexOf('--patch') + 1];
      const launchDir = path.dirname(overlayPath);

      launches.push({
        launchDir,
        overlay: runtimeYaml(DEPENDENCIES.directory).load(readFileSync(overlayPath, 'utf8')),
        hooks: JSON.parse(readFileSync(path.join(launchDir, 'hooks.json'), 'utf8')),
        policy: JSON.parse(readFileSync(path.join(launchDir, 'glm-policy.json'), 'utf8')),
      });

      const child = spawn(command, args, options);

      children.push(child);

      return child;
    },
  };
  const sessions = [];

  return {
    root,
    project,
    stateDir,
    runDir,
    config,
    deps,
    children,
    launches,
    sessions,
    async log() {
      return (await fs.readFile(logFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    },
    async prompts() {
      return (await this.log()).filter((entry) => entry.message?.method === 'session/prompt').length;
    },
    run(overrides = {}) {
      return runGlmTurn({
        config,
        cwd: project,
        chatKey: `factory:${IDENTITY.task}:${IDENTITY.stage}:${IDENTITY.runId}:${IDENTITY.epoch}`,
        message: 'fixture-stage-prompt',
        model: MODEL,
        factory: true,
        factoryContext: {
          ...IDENTITY,
          filesystem: 'workspace-write',
          statusServer: statusServer(root),
        },
        onSessionCreated: async (sessionId) => {
          sessions.push(sessionId);
        },
        ...overrides,
      }, deps);
    },
    async closed() {
      await waitFor(() => children.every((child) => child.exitCode !== null || child.signalCode !== null));

      return true;
    },
  };
}

function rowsById(overlay) {
  return new Map(overlay.filter((row) => row.id).map((row) => [row.id, row]));
}

function inserted(overlay) {
  return overlay.find((row) => Array.isArray(row.insert))?.insert ?? [];
}

function toolCall(id, name, rawInput = {}) {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: id,
    title: name,
    rawInput,
  };
}

function toolResult(id, text = 'ok', isError = false) {
  return {
    sessionUpdate: 'tool_result',
    toolCallId: id,
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

test('SB10: factory ход доходит до транспорта с host status MCP и политикой этапа', async (t) => {
  for (const filesystem of ['workspace-write', 'state-only']) {
    const f = await fixture(t, {
      hooks: true,
      updates: [
        toolCall('call-1', PROGRESS, { message: 'fixture-progress' }),
        toolResult('call-1'),
        toolCall('call-2', RESULT, { result: 'done' }),
        toolResult('call-2'),
        { sessionUpdate: 'agent_message_chunk', content: { text: 'stage-ok' } },
      ],
    });
    const result = await f.run({
      factoryContext: {
        ...IDENTITY,
        filesystem,
        ...(filesystem === 'state-only' ? { stateDir: f.stateDir } : {}),
        statusServer: statusServer(f.root),
      },
    });
    const [launch] = f.launches;
    const rows = rowsById(launch.overlay);
    const mounted = inserted(launch.overlay).filter((row) => row.name === '@deepseek-ai/dsh-mcp-client');
    const steps = result.steps.filter((step) => step.k === 'tool').map((step) => step.name);

    assert.equal(result.reply, 'stage-ok');
    assert.equal(await f.prompts(), 1);
    assert.equal(f.sessions.length, 1);
    assert.equal(f.launches.length, 1);
    assert.deepEqual(launch.policy, {
      format: 1,
      consumer: 'factory',
      filesystem,
      ...(filesystem === 'state-only' ? { stateDir: await fs.realpath(f.stateDir) } : {}),
      rawTools: [...GLM_FACTORY_STATUS_TOOLS],
    });
    assert.deepEqual(rows.get('approval')?.config, { policy: 'never' });
    assert.equal(rows.get('sandbox-policy')?.config.mode, 'workspace-write');
    assert.equal(rows.get('sandbox-policy')?.config.workspaceRoot,
      await fs.realpath(filesystem === 'state-only' ? f.stateDir : f.project));
    assert.deepEqual(mounted.map((row) => row.config.serverName), ['factory-status']);
    assert.equal(mounted[0].config.env.FACTORY_RUN_ID, IDENTITY.runId);
    assert.equal(mounted[0].config.failOnStartupError, true);
    assert.deepEqual(mounted[0].config.reconnect, { enabled: false });
    assert.equal(launch.launchDir.startsWith(f.config.glmRuntimeHome + path.sep), true);
    assert.deepEqual(steps, [PROGRESS, RESULT]);
    assert.equal((await f.log()).filter((entry) => entry.message?.method === 'session/prompt').length, 1);
    assert.equal(await f.closed(), true);
  }
});

test('SB10: неполный host context, чужой MCP и неподдержанный режим отвергаются до prompt', async (t) => {
  const f = await fixture(t);
  const base = {
    ...IDENTITY,
    filesystem: 'workspace-write',
    statusServer: statusServer(f.root),
  };
  const status = statusServer(f.root);
  const mismatch = {
    ...status,
    env: status.env.map((entry) => entry.name === 'FACTORY_RUN_ID' ? { ...entry, value: 'other' } : entry),
  };
  const invalid = [
    { factoryContext: { ...base, task: '' } },
    { factoryContext: { ...base, epoch: '0' } },
    { factoryContext: { ...base, stage: 'lower' } },
    { factoryContext: { ...base, filesystem: 'full-access' } },
    { factoryContext: { ...base, filesystem: 'state-only' } },
    { factoryContext: {
      ...base,
      filesystem: 'state-only',
      stateDir: 'relative',
    } },
    { factoryContext: { ...base, statusServer: undefined } },
    { factoryContext: { ...base, statusServer: mismatch } },
    { factoryContext: { ...base, statusServer: { ...status, name: 'grigdesk-work' } } },
    { factoryContext: { ...base, statusServer: { ...status, command: 'node' } } },
    { factoryContext: base, mcpServers: [{ ...status, name: 'project-tool' }] },
    { factoryContext: base, sessionId: 'existing-session' },
    { factoryContext: base, permissionMode: 'auto' },
    { factoryContext: undefined },
    { factory: false },
    { factoryContext: base, scopedWorkspace: true },
    { factoryContext: base, untrustedInput: true },
  ];

  for (const overrides of invalid) {
    await assert.rejects(f.run(overrides), (error) => String(error.code).startsWith('glm_'),
      JSON.stringify(Object.keys(overrides)));
  }

  // Coding Plan допущен с factory-policy-v2 (29.10.2026): ход этапа идёт тем же путём,
  // ключ режима подставляет buildGlmChildEnv из ZAI_CODING_API_KEY.
  const coding = await fixture(t, { updates: [] }, {
    GRIGDESK_GLM_API_MODE: 'coding-plan',
    ZAI_CODING_API_KEY: 'synthetic-coding-key',
  });

  await coding.run();

  assert.equal(await coding.prompts(), 1);
  assert.equal(coding.launches.length, 1);
  assert.equal(coding.children.length, 1);

  const brokenMode = await fixture(t, { updates: [] }, {
    GRIGDESK_GLM_API_MODE: 'team-plan',
    ZAI_CODING_API_KEY: 'synthetic-coding-key',
  });

  await assert.rejects(brokenMode.run(), (error) => String(error.code).startsWith('glm_'));
  assert.equal(brokenMode.children.length, 0);
  assert.equal(await brokenMode.prompts(), 0);
});

test('SB10: вопрос и approval этапа отклоняются сразу, без человека', async (t) => {
  const f = await fixture(t, {
    updates: [],
    question: { questions: [{ id: 'q1', question: 'fixture-question' }] },
  });
  let asked = 0;

  await f.run({
    signal: AbortSignal.timeout(15_000),
    onPermission: async () => {
      asked += 1;

      return { allow: true, rawAnswers: [{ selected: ['yes'], text: 'fixture-answer' }] };
    },
  });

  const answer = (await f.log()).find((entry) => entry.kind === 'question_response');

  assert.equal(asked, 0);
  assert.deepEqual(answer.message.result.value.answers, [{ id: 'q1', selected: [] }]);

  const approval = await fixture(t, {
    updates: [],
    permission: { toolCallId: 'call-1', toolName: 'write' },
  });

  await approval.run({
    signal: AbortSignal.timeout(15_000),
    onPermission: async () => {
      asked += 1;

      return { allow: true };
    },
  });

  const verdict = (await approval.log()).find((entry) => entry.kind === 'permission_response');

  assert.equal(asked, 0);
  assert.deepEqual(verdict.message.result, { kind: 'result', value: 'rejected' });
});

test('SB10: потеря статусного MCP и вызов без hook останавливают ход', async (t) => {
  const lost = await fixture(t, {
    hooks: true,
    waitForCancel: true,
    updates: [toolCall('call-1', RESULT, { result: 'done' }), toolResult('call-1', 'Not connected', true)],
  });

  await assert.rejects(lost.run({ signal: AbortSignal.timeout(15_000) }), { code: 'glm_mcp_not_ready' });

  const unhooked = await fixture(t, {
    hooks: 'no-descriptor',
    waitForCancel: true,
    updates: [toolCall('call-1', 'mcp__factory-status-extra__stage_result'), toolResult('call-1')],
  });

  await assert.rejects(unhooked.run({ signal: AbortSignal.timeout(15_000) }),
    { code: 'glm_policy_hook_missing' });
  assert.equal(await lost.closed(), true);
  assert.equal(await unhooked.closed(), true);
});

test('SB10: обычный чат сохраняет политику grigdesk-work и привязку сессии', async (t) => {
  const f = await fixture(t, {
    updates: [{ sessionUpdate: 'agent_message_chunk', content: { text: 'ok' } }],
  });
  const result = await f.run({
    factory: undefined,
    factoryContext: undefined,
    chatKey: 'chat-a',
  });
  const [launch] = f.launches;

  assert.equal(result.reply, 'ok');
  assert.equal(f.sessions.length, 1);
  assert.deepEqual(launch.policy, {
    workTools: [],
    ssh: true,
    db: false,
    strictDb: false,
    delegation: 'foreground-v1',
  });
  assert.deepEqual(rowsById(launch.overlay).get('approval')?.config, { policy: 'ask' });
});
