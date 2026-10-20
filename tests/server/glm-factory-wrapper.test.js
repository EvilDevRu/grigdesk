import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { runGlmFactory } from '../../server/scripts/glmRunner.mts';
import { writeCompatibility } from '../../server/scripts/sea/compatibility.mts';
import { buildHelper, loadHelpers } from '../../server/scripts/sea/helpers.mts';
import {
  GLM_FACTORY_POLICY_REVISION,
  GLM_FACTORY_PROFILE_REVISION,
  glmCompatibilityIdentity,
} from '../../server/src/lib/glm/contract.ts';
import { preparedGlmRuntime } from '../../server/src/lib/glm/preparedRuntime.ts';
import { runGlmTurn } from '../../server/src/lib/glm/runtime.ts';
import { helperCommand } from '../../server/src/lib/runtimePaths.ts';
import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';
import { writeDeepSeekBinaryStub } from '../helpers/deepseekBinaryStub.mts';

const exec = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const INFO_SCRIPT = path.join(ROOT, 'server/scripts/glmRuntimeInfo.mts');
const MANIFEST = path.join(ROOT, 'server/build/helpers.json');
const MODEL = '["zai","glm-5.3"]';

/**
 * Metadata отдельного DSH ELF с допуском, посчитанным по его же входам.
 * Синтетический допуск не читает и не переписывает производственный файл.
 */
function admittedInfo(packageId = 'a'.repeat(64)) {
  const info = runtimeInfoFixture();

  info.packageId = packageId;
  info.glm.admission = [{ mode: 'api', compatibility: glmCompatibilityIdentity(info.glm.inputs, 'api') }];

  return info;
}

async function metadataBinary(t, info) {
  return writeDeepSeekBinaryStub(t, [
    'if (!process.argv.includes("--runtime-info")) throw new Error("Только metadata double");',
    `process.stdout.write(${JSON.stringify(JSON.stringify(info))});`,
  ].join('\n'));
}

/**
 * Каталог попытки как у движка: private prompt в RUN_DIR, runtime home рядом,
 * server-owned identity этапа только в env. Ключ синтетический.
 */
async function wrapperFixture(t, { info = admittedInfo(), env: extra = {}, mode = 'read-only' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-factory-wrapper-'));
  const project = path.join(root, 'project');
  const runDir = path.join(root, 'run');
  const prompt = path.join(runDir, 'glm/prompt.md');
  const { binary } = await metadataBinary(t, info);

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(project, '.git'), { recursive: true });
  await fs.mkdir(path.dirname(prompt), { recursive: true, mode: 0o700 });
  await fs.writeFile(prompt, 'fixture-stage-prompt', { mode: 0o600 });

  const argv = [
    '--bin', binary,
    '--cwd', project,
    '--run-dir', runDir,
    '--runtime-home', path.join(runDir, 'glm/runtime'),
    '--prompt-file', prompt,
    '--model', MODEL,
    '--effort', 'high',
    '--mode', mode,
    '--cache-dir', path.join(root, 'cache'),
  ];
  const env = {
    HOME: path.join(root, 'home'),
    PATH: process.env.PATH,
    GRIGDESK_GLM_API_MODE: 'api',
    ZAI_API_KEY: 'synthetic-zai-key',
    FACTORY_RUN_TASK: '123',
    FACTORY_RUN_STAGE: 'BUILD',
    FACTORY_RUN_ID: 'fixture',
    FACTORY_RUN_EPOCH: '1',
    FACTORY_STATUS_MODE: 'request',
    FACTORY_STATUS_REQUEST_DIR: path.join(root, 'state/control-requests'),
    FACTORY_STATE: path.join(root, 'state'),
    FACTORY_LOOP_ROLE: 'lead',
    ...extra,
  };

  return {
    root,
    project,
    runDir,
    prompt,
    binary,
    argv,
    env,
    info,
  };
}

function withArgument(argv, name, value) {
  const index = argv.indexOf(name);

  return index >= 0 ? [...argv.slice(0, index + 1), value, ...argv.slice(index + 2)] : [...argv, name, value];
}

test('SB11: wrapper отдаёт runTurn пару zai, режим ФС, prepared runtime и host status', async (t) => {
  for (const [mode, filesystem] of [['read-only', 'state-only'], ['workspace-write', 'workspace-write']]) {
    const f = await wrapperFixture(t, { mode });
    const events = [];
    let captured;

    await runGlmFactory(f.argv, f.env, {
      emit: (event) => events.push(event),
      runTurn: async (options) => {
        captured = options;
        await options.onSessionCreated('fixture-session');

        return { reply: 'stage-done', steps: [] };
      },
    });

    const status = helperCommand('factory-status-mcp', []);
    const statusEnv = new Map(captured.factoryContext.statusServer.env
      .map((entry) => [entry.name, entry.value]));
    const runtime = await preparedGlmRuntime(captured.config, captured.preparedRuntime);
    const last = path.join(f.runDir, 'last.md');

    assert.equal(captured.model, MODEL);
    assert.equal(captured.effort, 'high');
    assert.equal(captured.factory, true);
    assert.equal(captured.message, 'fixture-stage-prompt');
    assert.equal(captured.cwd, await fs.realpath(f.project));
    assert.equal(captured.chatKey, 'factory:123:BUILD:fixture:1');
    assert.deepEqual({ ...captured.factoryContext, statusServer: undefined }, {
      task: '123',
      stage: 'BUILD',
      runId: 'fixture',
      epoch: '1',
      filesystem,
      statusServer: undefined,
    });
    assert.equal(captured.factoryContext.statusServer.name, 'factory-status');
    assert.equal(captured.factoryContext.statusServer.command, status.command);
    assert.deepEqual(captured.factoryContext.statusServer.args, status.args);
    assert.equal(statusEnv.get('FACTORY_LOOP_ROLE'), 'lead');
    assert.equal(statusEnv.has('ZAI_API_KEY'), false);
    assert.equal(statusEnv.has('GRIGDESK_GLM_API_MODE'), false);
    assert.equal(captured.config.glmRuntimeHome, path.join(f.runDir, 'glm/runtime'));
    assert.equal(runtime.identity, `deepseek-package:${f.info.packageId}`);
    assert.equal(await fs.readFile(last, 'utf8'), 'stage-done');
    assert.equal((await fs.stat(last)).mode & 0o777, 0o600);
    assert.deepEqual(events.map((event) => event.event), ['glm_start', 'session_created', 'result']);
    assert.equal(JSON.stringify(events).includes('synthetic-zai-key'), false);
    assert.equal(JSON.stringify(events).includes('fixture-stage-prompt'), false);
  }
});

test('SB11: SIGTERM не публикует ложный успешный result', async (t) => {
  const f = await wrapperFixture(t);
  const events = [];

  await runGlmFactory(f.argv, f.env, {
    emit: (event) => events.push(event),
    runTurn: async (options) => {
      queueMicrotask(() => process.emit('SIGTERM'));
      await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));

      return { reply: 'partial', steps: [] };
    },
  });

  assert.deepEqual(events.map((event) => event.event), ['glm_start']);
});

test('SB11: неверная identity, режим доступа и аргументы отвергаются до prompt', async (t) => {
  const f = await wrapperFixture(t);
  let calls = 0;
  const runTurn = async () => {
    calls += 1;

    return { reply: 'unexpected', steps: [] };
  };

  const foreignIdentity = withArgument(f.argv, '--runtime-identity', `deepseek-package:${'f'.repeat(64)}`);

  await assert.rejects(runGlmFactory(foreignIdentity, f.env, {
    emit: () => {},
    runTurn,
  }), { code: 'glm_runtime_changed' });
  await assert.rejects(runGlmFactory(withArgument(f.argv, '--runtime-version', '0.0.0'), f.env, {
    emit: () => {},
    runTurn,
  }), { code: 'glm_runtime_changed' });
  await assert.rejects(runGlmFactory(f.argv, {
    ...f.env,
    GRIGDESK_GLM_API_MODE: 'coding-plan',
    ZAI_CODING_API_KEY: 'synthetic-coding-key',
  }, { emit: () => {}, runTurn }), { code: 'glm_factory_mode_unsupported' });

  for (const argv of [
    withArgument(f.argv, '--model', '["zai","glm-9"]'),
    withArgument(f.argv, '--model', '["deepseek-official","deepseek-v4-flash"]'),
    withArgument(withArgument(f.argv, '--model', '["zai","glm-4.7"]'), '--effort', 'max'),
    withArgument(f.argv, '--mode', 'danger-full-access'),
    withArgument(f.argv, '--cwd', 'relative'),
    [...f.argv, '--unknown', 'x'],
  ]) {
    await assert.rejects(runGlmFactory(argv, f.env, { emit: () => {}, runTurn }), JSON.stringify(argv));
  }

  await fs.chmod(f.prompt, 0o644);
  await assert.rejects(runGlmFactory(f.argv, f.env, { emit: () => {}, runTurn }));
  assert.equal(calls, 0);
});

test('SB11: API-режим без ключа API не берёт ключ Coding Plan', async (t) => {
  const env = {
    GRIGDESK_GLM_API_MODE: 'api',
    ZAI_API_KEY: '',
    ZAI_CODING_API_KEY: 'synthetic-coding-key',
  };
  const f = await wrapperFixture(t, { env });
  const admission = f.info.glm.admission;

  await assert.rejects(runGlmFactory(f.argv, f.env, {
    emit: () => {},
    runTurn: (options) => runGlmTurn(options, {
      env: f.env,
      admission,
      spawn: () => {
        throw new Error('процесс не должен запускаться');
      },
    }),
  }), { code: 'glm_key_missing' });
});

test('SB11: metadata helper без ключей и модели, packageId меняет runnerVersion', async (t) => {
  const a = await metadataBinary(t, admittedInfo('a'.repeat(64)));
  const b = await metadataBinary(t, admittedInfo('c'.repeat(64)));
  const refused = await metadataBinary(t, runtimeInfoFixture());
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-runtime-info-'));
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    GRIGDESK_HOME: path.join(home, 'data'),
    GRIGDESK_GLM_API_MODE: 'api',
  };
  const info = (binary, args, extra = {}) => exec(process.execPath, [INFO_SCRIPT, '--binary', binary,
    '--cache-dir', path.join(home, 'cache'), ...args], { env: { ...env, ...extra }, timeout: 30_000 });

  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const versionA = (await info(a.binary, ['--probe'])).stdout.trim();
  const versionB = (await info(b.binary, ['--probe'])).stdout.trim();
  const descriptor = JSON.parse((await info(a.binary, [])).stdout);
  const rows = (await info(a.binary, ['--catalog'])).stdout.trim().split('\n').map((row) => row.split('\t'));

  assert.match(versionA, new RegExp(`p${'a'.repeat(64)}`));
  assert.ok(versionA.includes(GLM_FACTORY_PROFILE_REVISION));
  assert.ok(versionA.includes(GLM_FACTORY_POLICY_REVISION));
  assert.notEqual(versionA, versionB);
  assert.equal(descriptor.kind, 'binary');
  assert.equal(descriptor.runnerVersion, versionA);
  assert.equal(descriptor.identity, `deepseek-package:${'a'.repeat(64)}`);
  assert.ok(rows.length >= 1);
  assert.equal(rows[0][0], MODEL);
  assert.ok(rows.every((row) => row[1] === 'glm' && row[9] === versionA && row[10] === versionA), rows);
  assert.ok(rows.every((row) => JSON.parse(row[0])[0] === 'zai'));
  await assert.rejects(info(refused.binary, ['--probe']));
  await assert.rejects(info(a.binary, ['--probe'], { GRIGDESK_GLM_API_MODE: 'coding-plan' }));
});

test('SB11-catalog: собранные GLM helpers работают из перенесённого R по прежним путям', {
  timeout: 120_000,
}, async (t) => {
  const catalog = await loadHelpers(MANIFEST, ROOT);
  const compatibilityFile = path.join(ROOT, 'server/build/compatibility.json');
  const compatibility = JSON.parse(await fs.readFile(compatibilityFile, 'utf8'));
  const runner = catalog.helpers.find((helper) => helper.id === 'glm-runner');
  const info = catalog.helpers.find((helper) => helper.id === 'glm-runtime-info');

  assert.equal(runner?.entryKind, 'main');
  assert.deepEqual([...runner.exports].sort(), ['main', 'runGlmFactory']);
  assert.equal(info?.entryKind, 'script');

  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'glm-factory-helpers-'));
  const root = path.join(base, 'R with spaces');
  const helpers = path.join(root, 'server/runtime/helpers');
  const f = await wrapperFixture(t);

  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'runtime/node/bin'), { recursive: true });
  await fs.symlink(process.execPath, path.join(root, 'runtime/node/bin/node'));
  await fs.mkdir(helpers, { recursive: true });
  await fs.writeFile(path.join(helpers, 'helpers.json'), await fs.readFile(MANIFEST));
  // Внешние npm-зависимости helper-ов R разрешает из своего server/node_modules, как payload.
  await fs.symlink(path.join(ROOT, 'server/node_modules'), path.join(root, 'server/node_modules'));

  for (const id of ['glm-runtime-info', 'glm-runner', 'factory-status-mcp']) {
    await buildHelper({
      root: ROOT,
      manifest: catalog,
      id,
      outDir: helpers,
      workDir: path.join(base, 'build'),
    });
  }

  const selected = {
    ...compatibility,
    wrappers: compatibility.wrappers.filter((wrapper) => wrapper.helper.startsWith('glm-')),
  };

  assert.deepEqual(selected.wrappers.map((wrapper) => [wrapper.path, wrapper.kind]).sort(), [
    ['server/scripts/glmRunner.mts', 'script'],
    ['server/scripts/glmRuntimeInfo.mts', 'script'],
  ]);
  await writeCompatibility(root, selected, catalog);

  const node = path.join(root, 'runtime/node/bin/node');
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: path.join(base, 'home'),
    GRIGDESK_HOME: path.join(base, 'data'),
    GRIGDESK_GLM_API_MODE: 'api',
  };
  const probe = await exec(node, [path.join(root, 'server/scripts/glmRuntimeInfo.mts'), '--binary', f.binary,
    '--cache-dir', path.join(base, 'cache'), '--probe'], { env, timeout: 30_000 });

  assert.ok(probe.stdout.trim().includes(`p${f.info.packageId}`));

  const failed = await exec(node, [path.join(root, 'server/scripts/glmRunner.mts'), ...f.argv], {
    env: {
      ...f.env,
      PATH: '/usr/bin:/bin',
      ZAI_API_KEY: '',
      ZAI_CODING_API_KEY: 'synthetic-coding-key',
    },
    timeout: 30_000,
  }).then(() => null, (error) => error);
  const events = String(failed?.stdout ?? '').trim().split('\n').filter(Boolean).map(JSON.parse);

  assert.equal(failed?.code, 1);
  assert.deepEqual(events.map((event) => [event.event, event.code ?? '']), [
    ['glm_start', ''],
    ['wrapper_error', 'glm_key_missing'],
  ]);
  assert.equal(String(failed.stdout).includes('synthetic-coding-key'), false);
  assert.equal(String(failed.stdout).includes('fixture-stage-prompt'), false);
  await assert.rejects(fs.stat(path.join(root, 'server/src')), { code: 'ENOENT' });
});
