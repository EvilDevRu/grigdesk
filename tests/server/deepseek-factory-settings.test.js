import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { routeLaunchEnv } from '../../server/src/lib/factoryRouteCli.ts';
import { syntheticProvider } from '../fixtures/executor-settings/syntheticProvider.js';
import { PrefsStore } from '../../server/src/lib/prefsStore.ts';
import { mergeNativeSettingsConsumers } from '../../server/src/lib/executorSettings/consumers.ts';
import { runDeepSeekFactory } from '../../server/scripts/deepseekRunner.mts';
import { runDeepSeekTurn, prepareDeepSeekLaunch } from '../../server/src/lib/deepseek/runtime.ts';
import { testDeepSeekBinarySelection } from '../helpers/deepseekBinary.mts';
import { ensureTestDeepSeekBinary, ensureTestDeepSeekBinaryPair } from '../helpers/deepseekBinary.mts';
import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';
import { writeDeepSeekBinaryStub } from '../helpers/deepseekBinaryStub.mts';
import { startDeepSeekLoopback, writeDeepSeekLoopbackOverlay } from '../helpers/deepseekLoopback.mts';

const factory = await import('../../server/src/lib/executorSettings/factorySettings.ts').catch(() => null);
const exec = promisify(execFile);
// Корень репозитория не зависит от cwd: `npm test` запускает набор из server/.
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * Fixture использует единственный настоящий writer и явно заданный private prefs path.
 * Провайдер синтетический; malformed и unreadable проверяются до launch/model.
 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-factory-prefs-'));
  const prefsPath = path.join(root, 'prefs.json');
  const prefs = new PrefsStore({ prefsPath });
  const adapter = syntheticProvider();

  adapter.nativeSettings.consumers = ['chat', 'pipeline'];
  adapter.nativeSettings.discover = async (context) => {
    const snapshot = await syntheticProvider().nativeSettings.discover(context);

    return mergeNativeSettingsConsumers(snapshot, snapshot);
  };
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  return {
    root,
    prefsPath,
    prefs,
    adapter,
  };
}

/**
 * Loopback patch добавляется к исходному Factory overlay без изменения hooks и policy.
 * Артефакт берётся из закреплённого descriptor, включая private binary cache.
 */
async function factoryLoopbackLaunch(args, endpoint) {
  const launch = await prepareDeepSeekLaunch(args);
  const runtime = args.runtime;
  const artifact = runtime.kind === 'binary'
    ? path.join(args.config.deepseekCacheDir, 'packages', runtime.metadata.packageId, 'generation')
    : runtime.generationDir;
  const original = await fs.readFile(launch.overlayPath, 'utf8');
  const patch = await writeDeepSeekLoopbackOverlay({
    root: launch.launchDir,
    artifact,
    endpoint,
    document: path.join(launch.launchDir, 'native-settings.yaml'),
  });
  const combined = path.join(launch.launchDir, 'combined.yml');

  await fs.writeFile(combined, original + await fs.readFile(patch, 'utf8'), { mode: 0o600 });

  return { ...launch, overlayPath: combined };
}

test('Factory читает canonical prefs заново для каждого узла и сохраняет busy snapshot', async (t) => {
  assert.ok(factory, 'Factory prepare пока отсутствует');

  const f = await fixture(t);
  const save = (value, revision) => f.prefs.write({ providerSettings: {
    [f.adapter.id]: {
      blockDirectSsh: false,
      nativeSettings: {
        format: 1,
        revision,
        overrides: value === undefined ? {} : {
          '["enabled"]': { path: ['enabled'], value },
        },
      },
    },
  } });
  const prepare = () => factory.prepareFactoryNativeSettings({
    adapter: f.adapter,
    config: {},
    cwd: f.root,
    mode: 'default',
    prefsPath: f.prefsPath,
  });

  save(false, 1);

  const first = await prepare();

  save(true, 2);

  const second = await prepare();

  save(undefined, 3);

  const unset = await prepare();

  assert.equal(first.nativeSettings.accepted[0].value, false);
  assert.equal(second.nativeSettings.accepted[0].value, true);
  assert.equal(unset.nativeSettings, undefined);
  assert.equal(Object.hasOwn(first, 'providerSettings'), false);
  assert.ok(Object.isFrozen(first.nativeSettings));
});

test('узел конвейера блокирует прямой SSH даже при чатовом blockDirectSsh: false', async (t) => {
  const f = await fixture(t);
  const { candidate } = await testDeepSeekBinarySelection();
  const runDir = path.join(f.root, 'run');
  const prompt = path.join(runDir, 'prompt.md');
  let hooks;

  await fs.mkdir(runDir, { mode: 0o700 });
  await fs.writeFile(prompt, 'не выполнять', { mode: 0o600 });
  // Чатовые тумблеры ослабляют SSH и включают блок БД; автономный узел их не наследует.
  f.prefs.write({ providerSettings: { deepseek: {
    blockDirectSsh: false,
    blockDirectDb: true,
    strictUnknownDbClient: true,
  } } });

  await assert.rejects(runDeepSeekFactory([
    '--bin', candidate.binary, '--cache-dir', candidate.cacheDir,
    '--cwd', f.root, '--run-dir', runDir, '--runtime-home', path.join(runDir, 'runtime'),
    '--prompt-file', prompt, '--model', '["deepseek-official","deepseek-v4-flash"]',
    '--effort', 'off', '--mode', 'workspace-write',
  ], {
    PATH: process.env.PATH,
    HOME: f.root,
    GRIGDESK_PROVIDER_PREFS_PATH: f.prefsPath,
    FACTORY_RUN_TASK: '123',
    FACTORY_RUN_STAGE: 'BUILD',
    FACTORY_RUN_ID: 'ssh-policy',
    FACTORY_RUN_EPOCH: '1',
    FACTORY_STATUS_MODE: 'request',
    FACTORY_STATUS_REQUEST_DIR: path.join(f.root, 'requests'),
  }, {
    emit: () => {},
    runTurn: (options) => runDeepSeekTurn({
      ...options,
      deps: {
        prepareLaunch: async (args) => {
          const launch = await prepareDeepSeekLaunch(args);

          hooks = JSON.parse(await fs.readFile(path.join(launch.launchDir, 'hooks.json'), 'utf8'));

          throw Object.assign(new Error('launch captured'), { code: 'fixture_launch_captured' });
        },
      },
    }),
  }), { code: 'fixture_launch_captured' });

  const policy = hooks.hooks.PreToolUse?.[0]?.hooks?.[0]?.command || '';

  assert.match(policy, / --ssh(?: |$)/);
  assert.doesNotMatch(policy, /--no-ssh|--db|--strict-db/);
});

/**
 * Тело проверки overrides общее для legacy и ELF: меняется только fixture доставки.
 * Настоящий wrapper, native bridge, ACP и HTTP payload не подменяются.
 */
function registerFactoryOverrides(delivery) {
  test(`${delivery}: настоящий Factory wrapper читает общие overrides каждого узла`, async (t) => {
    const f = await fixture(t);
    const candidate = await ensureTestDeepSeekBinary();
    const artifact = path.join(candidate.cacheDir, 'packages', candidate.info.packageId, 'generation');
    const mock = await startDeepSeekLoopback();
    const events = [];
    const launches = [];

    t.after(() => mock.stop());

    for (const [index, maxTokens] of [64, 128, undefined].entries()) {
      f.prefs.write({ providerSettings: { deepseek: {
        nativeSettings: {
          format: 1,
          revision: index + 1,
          overrides: maxTokens === undefined ? {} : {
            '["llm-deepseek","maxTokens"]': { path: ['llm-deepseek', 'maxTokens'], value: maxTokens },
          },
        },
      } } });

      const runDir = path.join(f.root, `run-${index}`);
      const prompt = path.join(runDir, 'prompt.md');
      const runtimeHome = path.join(runDir, 'runtime');

      await fs.mkdir(runDir, { mode: 0o700 });
      await fs.writeFile(prompt, 'fixture-factory-prompt', { mode: 0o600 });

      await runDeepSeekFactory([
        '--bin', candidate.binary, '--cache-dir', candidate.cacheDir,
        '--cwd', f.root, '--run-dir', runDir, '--runtime-home', runtimeHome,
        '--prompt-file', prompt, '--model', '["deepseek-official","deepseek-v4-flash"]',
        '--effort', 'off', '--mode', 'workspace-write',
      ], {
        PATH: process.env.PATH,
        HOME: f.root,
        DEEPSEEK_API_KEY: 'grigdesk-loopback-only',
        GRIGDESK_PROVIDER_PREFS_PATH: f.prefsPath,
        GRIGDESK_DEEPSEEK_RUNTIME_MODE: delivery,
        FACTORY_RUN_TASK: '123',
        FACTORY_RUN_STAGE: 'BUILD',
        FACTORY_RUN_ID: `fixture-${index}`,
        FACTORY_RUN_EPOCH: '1',
        FACTORY_STATUS_MODE: 'request',
        FACTORY_STATUS_REQUEST_DIR: path.join(f.root, 'requests'),
      }, {
        emit: (event) => events.push(event),
        runTurn: (options) => runDeepSeekTurn({
          ...options,
          deps: {
            prepareLaunch: async (args) => {
              const launch = await factoryLoopbackLaunch(args, mock.endpoint);

              launches.push(launch);

              assert.equal((await fs.stat(launch.launchDir)).mode & 0o777, 0o700);

              return launch;
            },
          },
        }),
      });

      assert.equal(await fs.readFile(path.join(runDir, 'last.md'), 'utf8'), 'loopback-ok');
      await assert.rejects(fs.stat(launches[index].launchDir), { code: 'ENOENT' });
    }

    assert.deepEqual(mock.payloads.slice(0, 2).map((payload) => payload.max_tokens), [64, 128]);
    assert.notEqual(mock.payloads[2].max_tokens, 128);
    assert.equal(events.filter((event) => event.event === 'result').length, 3);
    assert.equal(JSON.stringify(events).includes(f.prefsPath), false);
    assert.equal(JSON.stringify(events).includes('grigdesk-loopback-only'), false);
  });
}

registerFactoryOverrides('binary');

test('binary Factory: замена ELF после prefs до run отклоняется до ACP/model', {
  timeout: 900000,
}, async (t) => {
  const f = await fixture(t);
  const { a, b } = await ensureTestDeepSeekBinaryPair();
  const binary = path.join(f.root, 'selected binary');
  const prompt = path.join(f.root, 'prompt.md');
  const mock = await startDeepSeekLoopback();
  let runs = 0;

  t.after(() => mock.stop());
  await fs.symlink(a.binary, binary);
  await fs.writeFile(prompt, 'Не отправлять при подмене ELF', { mode: 0o600 });

  await assert.rejects(runDeepSeekFactory([
    '--bin', binary, '--cache-dir', a.cacheDir,
    '--cwd', f.root, '--run-dir', f.root, '--runtime-home', path.join(f.root, 'runtime'),
    '--prompt-file', prompt, '--model', '["deepseek-official","deepseek-v4-flash"]',
    '--effort', 'off', '--mode', 'workspace-write',
  ], {
    PATH: process.env.PATH,
    HOME: f.root,
    DEEPSEEK_API_KEY: 'grigdesk-loopback-only',
    GRIGDESK_DEEPSEEK_RUNTIME_MODE: 'binary',
    GRIGDESK_DEEPSEEK_BIN: binary,
    GRIGDESK_PROVIDER_PREFS_PATH: f.prefsPath,
    FACTORY_RUN_TASK: '123',
    FACTORY_RUN_STAGE: 'BUILD',
    FACTORY_RUN_ID: 'binary-barrier',
    FACTORY_RUN_EPOCH: '1',
    FACTORY_STATUS_MODE: 'request',
    FACTORY_STATUS_REQUEST_DIR: path.join(f.root, 'requests'),
  }, {
    emit: () => {},
    runTurn: async (options) => {
      runs += 1;
      await fs.symlink(b.binary, `${binary}.next`);
      await fs.rename(`${binary}.next`, binary);

      return runDeepSeekTurn({
        ...options,
        deps: { prepareLaunch: (args) => factoryLoopbackLaunch(args, mock.endpoint) },
      });
    },
  }), { code: 'deepseek_runtime_changed' });
  assert.equal(runs, 1, 'Без автоматического retry');
  assert.equal(mock.payloads.length, 0, 'Подмена обнаружена до prompt');
});

test('Factory только ENOENT считает отсутствием prefs; порча и unreadable запрещают launch', async (t) => {
  assert.ok(factory, 'Factory prepare пока отсутствует');

  const f = await fixture(t);
  const prepare = () => factory.prepareFactoryNativeSettings({
    adapter: f.adapter,
    config: {},
    cwd: f.root,
    prefsPath: f.prefsPath,
  });

  assert.equal((await prepare()).nativeSettings, undefined);

  for (const malformed of ['{', 'null', '[]', '{"providerSettings":null}',
    '{"providerSettings":{"future-provider":{"nativeSettings":{"format":7}}}}']) {
    await fs.writeFile(f.prefsPath, malformed);
    await assert.rejects(prepare());
  }

  await fs.rm(f.prefsPath);
  await fs.mkdir(f.prefsPath);
  await assert.rejects(prepare());
});

/**
 * Terminal status проходит через тот же настоящий MCP и host consumer для обеих поставок.
 * Доставка runtime не меняет run identity, capability или проверку единственного результата.
 */
function registerFactoryStatus(delivery) {
  test(`${delivery}: настоящий compiled Factory завершает узел через host status MCP`, async (t) => {
    const f = await fixture(t);
    const candidate = await ensureTestDeepSeekBinary();
    const state = path.join(f.root, 'state');
    const runDir = path.join(state, 'logs/runs/t123/BUILD/compiled-status');
    const requestDir = path.join(runDir, 'control-requests');
    const env = {
      PATH: process.env.PATH,
      HOME: f.root,
      FACTORY_HOME: path.join(REPO_ROOT, 'engine'),
      FACTORY_STATE: state,
      STATE_DIR: state,
      FACTORY_TESTING: '1',
      DEEPSEEK_API_KEY: 'grigdesk-loopback-only',
      GRIGDESK_PROVIDER_PREFS_PATH: f.prefsPath,
      GRIGDESK_DEEPSEEK_RUNTIME_MODE: delivery,
      FACTORY_RUN_TASK: '123',
      FACTORY_RUN_STAGE: 'BUILD',
      FACTORY_RUN_ID: 'compiled-status',
      FACTORY_RUN_EPOCH: '1',
      FACTORY_STATUS_MODE: 'request',
      FACTORY_STATUS_REQUEST_DIR: requestDir,
    };
    const hostScript = `
      source "$FACTORY_HOME/lib/pipeline-store.sh"
      source "$FACTORY_HOME/lib/run-state.sh"
      source "$FACTORY_HOME/lib/status-request.sh"
    `;

    await fs.mkdir(requestDir, { recursive: true });
    await exec('bash', ['-c', hostScript + `
      pipeline_store_route_init 123 BUILD
      factory_control_init fixture-control
      run_state_begin 123 BUILD compiled-status 1 fixture-status-token
    `], { env });

    const mock = await startDeepSeekLoopback({
      respond: (payload, index) => {
        if (index === 0) {
          const tool = payload.tools.find((entry) => entry.function.name.includes('stage_result'));

          assert.ok(tool, 'host status tool объявлен настоящим MCP client');

          return {
            deltas: [{ tool_calls: [{
              index: 0,
              id: 'status',
              type: 'function',
              function: {
                name: tool.function.name,
                arguments: JSON.stringify({ result: 'done', comment: 'compiled host status' }),
              },
            }] }],
            finishReason: 'tool_calls',
          };
        }

        return { deltas: [{ content: 'готово' }], finishReason: 'stop' };
      },
    });

    t.after(() => mock.stop());
    await fs.writeFile(path.join(runDir, 'prompt.md'), 'use host stage_result once', { mode: 0o600 });
    await runDeepSeekFactory([
      '--bin', candidate.binary, '--cache-dir', candidate.cacheDir,
      '--cwd', f.root,
      '--run-dir', runDir, '--runtime-home', path.join(runDir, 'runtime'),
      '--prompt-file', path.join(runDir, 'prompt.md'),
      '--model', '["deepseek-official","deepseek-v4-flash"]', '--mode', 'workspace-write', '--effort', 'off',
    ], env, {
      emit: () => {},
      runTurn: (options) => runDeepSeekTurn({
        ...options,
        deps: {
          prepareLaunch: async (args) => {
            return factoryLoopbackLaunch(args, mock.endpoint);
          },
        },
      }),
    });

    assert.equal((await fs.readdir(requestDir)).filter((name) => name.endsWith('.request')).length, 1);

    const { stdout } = await exec('bash', ['-c', hostScript + `
    status_request_consume_all 123 BUILD compiled-status 1 fixture-status-token "$FACTORY_STATUS_REQUEST_DIR"
      pipeline_store_get 123 BUILD
      pipeline_store_get 123 BUILD_COMMENT
    `], { env });

    assert.equal(stdout.trim(), 'done\ncompiled host status');
  });
}

registerFactoryStatus('binary');

test('Factory env по умолчанию закрепляет binary без embedded roots поверх extra env', () => {
  const config = {
    rootDir: '/opt/grigdesk',
    factoryHome: '/opt/grigdesk/engine',
    profilesDir: '/opt/profiles',
    factoryConfigRoot: '/opt/config',
    prefsPath: '/private/host-prefs.json',
  };
  const env = routeLaunchEnv(config, {
    GRIGDESK_PROVIDER_PREFS_PATH: '/project/fake-prefs',
    GRIGDESK_DEEPSEEK_NODE_BIN: '/project/node',
    GRIGDESK_DEEPSEEK_BIN: '/project/dsh',
    GRIGDESK_DEEPSEEK_ARTIFACT_DIR: '/project/generation',
    GRIGDESK_DEEPSEEK_RUNTIME_MODE: 'installed',
    GRIGDESK_DEEPSEEK_GENERATION_ROOT: '/project/runtime',
  });

  assert.equal(env.GRIGDESK_PROVIDER_PREFS_PATH, config.prefsPath);
  assert.equal(env.GRIGDESK_DEEPSEEK_NODE_BIN, process.execPath);
  assert.equal(env.GRIGDESK_DEEPSEEK_BIN, '/opt/grigdesk/bin/deepseek');
  assert.equal(env.GRIGDESK_DEEPSEEK_ARTIFACT_DIR, '');
  assert.equal(env.GRIGDESK_DEEPSEEK_RUNTIME_MODE, 'binary');
  assert.equal(env.GRIGDESK_DEEPSEEK_GENERATION_ROOT, '');
});

test('Factory env закрепляет ELF и cache binary-поставки поверх extra env', () => {
  const config = {
    rootDir: '/opt/grigdesk',
    factoryHome: '/opt/grigdesk/engine',
    profilesDir: '/opt/profiles',
    factoryConfigRoot: '/opt/config',
    deepseekRuntimeMode: 'binary',
    deepseekBin: '/opt/grigdesk/bin/deepseek',
    deepseekCacheDir: '/private/deepseek-cache',
    deepseekGenerationRoot: '/private/installed-legacy',
  };
  const env = routeLaunchEnv(config, {
    GRIGDESK_DEEPSEEK_BIN: '/project/fake-binary',
    GRIGDESK_DEEPSEEK_CACHE_DIR: '/project/fake-cache',
  });

  assert.equal(env.GRIGDESK_DEEPSEEK_RUNTIME_MODE, 'binary');
  assert.equal(env.GRIGDESK_DEEPSEEK_BIN, config.deepseekBin);
  assert.equal(env.GRIGDESK_DEEPSEEK_CACHE_DIR, config.deepseekCacheDir);
  assert.equal(env.GRIGDESK_DEEPSEEK_GENERATION_ROOT, config.deepseekGenerationRoot);
});

test('stock override с активной общей настройкой отклоняется до launch по metadata contract', async (t) => {
  const f = await fixture(t);
  const bin = path.join(f.root, 'dsh');
  const prompt = path.join(f.root, 'prompt.md');

  await fs.writeFile(bin, '#!/bin/sh\nprintf "0.1.5-rc.2\\n"\n', { mode: 0o700 });
  await fs.writeFile(prompt, 'не выполнять', { mode: 0o600 });
  f.prefs.write({ providerSettings: { deepseek: { nativeSettings: {
    format: 1,
    revision: 1,
    overrides: { '["llm-deepseek","maxTokens"]': { path: ['llm-deepseek', 'maxTokens'], value: 64 } },
  } } } });

  await assert.rejects(runDeepSeekFactory([
    '--bin', bin, '--cwd', f.root, '--run-dir', f.root,
    '--runtime-home', path.join(f.root, 'home'), '--prompt-file', prompt,
    '--model', '["deepseek-official","deepseek-v4-flash"]', '--mode', 'read-only',
  ], {
    GRIGDESK_DEEPSEEK_BIN: bin,
    GRIGDESK_PROVIDER_PREFS_PATH: f.prefsPath,
    FACTORY_RUN_TASK: '1',
    FACTORY_RUN_STAGE: 'BUILD',
    FACTORY_RUN_ID: 'external',
    FACTORY_RUN_EPOCH: '1',
    FACTORY_STATUS_MODE: 'request',
    FACTORY_STATUS_REQUEST_DIR: f.root,
  }, {
    runTurn: async () => {
      throw new Error('Prompt не должен вызываться');
    },
  }), { code: 'deepseek_binary_metadata_invalid' });
});

test('metadata без обязательного ACP bridge отклоняется до launch с активным override', async (t) => {
  const f = await fixture(t);
  const prompt = path.join(f.root, 'prompt.md');
  const info = runtimeInfoFixture();

  info.capabilities.settingsAcp = false;

  const { binary: bin } = await writeDeepSeekBinaryStub(t,
    `process.stdout.write(${JSON.stringify(JSON.stringify(info))});`);

  await fs.writeFile(prompt, 'Не отправлять', { mode: 0o600 });
  f.prefs.write({ providerSettings: { deepseek: { nativeSettings: {
    format: 1,
    revision: 1,
    overrides: { '["llm-deepseek","maxTokens"]': { path: ['llm-deepseek', 'maxTokens'], value: 64 } },
  } } } });

  let runs = 0;

  await assert.rejects(runDeepSeekFactory([
    '--bin', bin, '--cwd', f.root, '--run-dir', f.root,
    '--runtime-home', path.join(f.root, 'home'), '--prompt-file', prompt,
    '--model', '["deepseek-official","deepseek-v4-flash"]', '--mode', 'read-only',
  ], {
    GRIGDESK_DEEPSEEK_BIN: bin,
    GRIGDESK_PROVIDER_PREFS_PATH: f.prefsPath,
    FACTORY_RUN_TASK: '1',
    FACTORY_RUN_STAGE: 'BUILD',
    FACTORY_RUN_ID: 'missing-bridge',
    FACTORY_RUN_EPOCH: '1',
    FACTORY_STATUS_MODE: 'request',
    FACTORY_STATUS_REQUEST_DIR: f.root,
  }, {
    runTurn: async () => {
      runs += 1;

      throw new Error('ACP не должен запускаться');
    },
  }), { code: 'deepseek_binary_incompatible' });
  assert.equal(runs, 0);
});
