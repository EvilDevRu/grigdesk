import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { buildHelper } from '../../server/scripts/sea/helpers.mts';
import { stageFactoryCandidate } from '../../server/scripts/binary/factoryCandidate.mts';
import { reserveFactoryRuntime } from '../../server/src/lib/factoryRuntimePins.ts';
import { acquireCliLease, inspectCliLeases } from '../../server/src/lib/providerInstall/leases.ts';
import { executableIdentity } from '../../server/src/lib/providerInstall/executableIdentity.ts';
import {
  createRuntimePaths, helperCommandFor, readHelperCatalog,
} from '../../server/src/lib/runtimePaths.ts';
import {
  decodeStageRunnerOptions, STAGE_RUNNER_SPEED_ACCEPT, type StageRunnerApply, type StageRunnerOptions,
} from '../../shared/pipeline/stageRunnerSettings.ts';
import { testFactoryBinary } from '../helpers/factoryBinary.mjs';
import { codexModelFixture } from '../helpers/factoryStageModelMetadata.mjs';
import {
  expectAttempt, prepareCommandServer, prepareIsolatedCommandWorkspace,
} from './helpers/factoryGoRuntime.mts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const flash = '["deepseek-official","deepseek-v4-flash"]';
const pro = '["deepseek-official","deepseek-v4-pro"]';
const runFile = promisify(execFile);

for (const liveMode of ['next', 'restart'] as const) {
  test(`Go сохраняет параметры этапа и обслуживает живой режим ${liveMode}`, async (t) => {
    await exerciseStageSettings(t, liveMode);
  });
}

/**
 * Публикует Go ELF и собранный bind helper в пакете с отдельным идентификатором.
 * Прямой start и HTTP используют один реальный пин.
 */
async function stageSettingsRuntime(
  root: string,
  candidate: string,
  helpers: readonly string[] = ['factory-runtime-pin'],
  packageId = 'a'.repeat(64),
) {
  const cacheDir = path.join(root, 'cache');
  const runtimeRoot = path.join(cacheDir, 'packages', packageId);
  const engineHome = path.join(runtimeRoot, 'engine');
  const engineBin = path.join(engineHome, 'bin/factory');
  const node = path.join(runtimeRoot, 'runtime/node/bin/node');
  const helperDir = path.join(runtimeRoot, 'server/runtime/helpers');

  await fs.mkdir(path.dirname(node), { recursive: true, mode: 0o700 });
  await fs.copyFile(process.execPath, node);
  await fs.chmod(node, 0o700);
  await stageFactoryCandidate({
    root: runtimeRoot,
    binary: candidate,
    profileAbi: path.join(repo, 'engine/lib/delivery_contract.py'),
    os: process.platform,
    arch: process.arch,
  });

  const files: Record<string, string> = {};

  for (const id of helpers) {
    const helper = await buildHelper({
      root: repo,
      manifestPath: path.join(repo, 'server/build/helpers.json'),
      id,
      outDir: helperDir,
      workDir: path.join(root, 'helper-build'),
    });

    files[id] = helper.file;
  }

  const manifest = readHelperCatalog(path.join(repo, 'server/build/helpers.json'));
  // Общий граф загрузки модели разрешает путь SSH-hook при импорте конфигурации.
  // Офлайн metadata не вызывает его и не объявляет поддержку browser helper.
  const entries = manifest.helpers.filter(({ id }) => files[id] ||
    (files['factory-runner-models'] && id === 'direct-ssh-policy-hook'))
    .map((entry) => files[entry.id] ? {
      ...entry,
      entry: path.basename(files[entry.id]!),
    } : entry);

  await fs.writeFile(path.join(helperDir, 'helpers.json'), JSON.stringify({
    schema: 1,
    helpers: entries,
  }));

  return {
    cacheDir,
    packageId,
    runtimeRoot,
    engineHome,
    engineBin,
    node,
    helper: files['factory-runtime-pin']!,
    helpers: files,
  };
}

/**
 * Готовит точную попытку на воротах и проверяет оба способа применения.
 * Повтор с next разрешён только после штатного выхода старого процесса.
 */
async function exerciseStageSettings(t: TestContext, liveMode: 'next' | 'restart') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-settings-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const engine = path.join(root, 'factory');
  const deepseekBin = path.join(root, 'deepseek');

  execFileSync('go', ['build', '-trimpath', '-o', engine, './utilities/factory/cmd/factory'], { cwd: repo });

  const runtime = await stageSettingsRuntime(root, engine);
  const fixture = await prepareCommandServer(t, root, engine, true, false, 1);
  const controlEvents = path.join(root, 'agent-control.log');
  const controlChannel = path.join(root, 'agent-control');
  const scripts = path.join(runtime.runtimeRoot, 'server/scripts');
  const helpers = path.join(runtime.runtimeRoot, 'server/runtime/helpers');

  await fs.appendFile(path.join(fixture.config.profilesDir, 'demo-profile/profile.sh'), String.raw`
profile_agent_control_start() {
  [[ "$1:$2" == 71:BUILD ]] || return 91
  fixture_control_shell=$BASHPID
  export PROFILE_AGENT_CONTROL_DIR="$HOME/agent-control"
  mkdir -m 700 "$PROFILE_AGENT_CONTROL_DIR" || return
  printf 'start %s %s\n' "$@" >>"$HOME/agent-control.log"
}
profile_agent_control_stop() {
  [[ "$fixture_control_shell" == "$BASHPID" ]] || return 92
  rmdir "$PROFILE_AGENT_CONTROL_DIR" || return
  printf 'stop %s %s %s\n' "$@" >>"$HOME/agent-control.log"
}
`);

  const reservation = await reserveFactoryRuntime({
    ...runtime,
    controlRoot: fixture.config.factoryControlDir,
    stateRoot: fixture.config.stateDir,
    profileRoot: fixture.config.profilesDir,
    task: '71',
  });

  await fs.mkdir(scripts, { recursive: true });
  await fs.mkdir(helpers, { recursive: true });
  await fs.writeFile(path.join(scripts, 'deepseekRunner.mts'), 'throw new Error("Unexpected model call");\n');
  await fs.writeFile(deepseekBin, '#!/bin/bash\n[[ "$1" == --version ]] && echo "deepseek 0.2.0"\n', {
    mode: 0o700,
  });

  const metadata = path.join(helpers, 'factory-runner-models.mjs');
  const catalog = {
    schema: 1,
    models: [{ id: flash, efforts: ['off', 'high'] }, { id: pro, efforts: ['off', 'max'] }],
  };

  /**
   * Модели приходят из зафиксированного metadata helper тестовой установки.
   * Дополнительная версия имитирует обновление каталога между options и apply.
   */
  async function writeCatalog(label?: string) {
    const models = catalog.models.map((entry) => ({ ...entry, label }));

    await fs.writeFile(metadata, `console.log(${JSON.stringify(JSON.stringify({ ...catalog, models }))});\n`);
  }

  await writeCatalog();

  const ticket = path.join(root, 'ticket.json');

  await fs.writeFile(ticket, JSON.stringify({
    schema: 1,
    taskId: '71',
    title: 'Настройки этапа в Go',
    description: 'Правка будущего этапа на воротах',
    acceptanceCriteria: ['Сохранение ровно один раз'],
    sourceUrl: 'https://example.test/tasks/71',
  }));

  const paths = [
    '--profile', 'demo-profile', '--routes-dir', fixture.config.routesDir,
    '--control-dir', fixture.config.factoryControlDir, '--state-dir', fixture.config.stateDir,
  ];
  const environment = {
    HOME: root,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    NODE_BIN: process.execPath,
    GRIGDESK_DEEPSEEK_BIN: deepseekBin,
    FACTORY_HOME: runtime.engineHome,
    GRIGDESK_SERVER_RUNTIME_RESERVATION: reservation.reservation,
    GRIGDESK_SERVER_RUNTIME_NODE: runtime.node,
    GRIGDESK_SERVER_RUNTIME_PIN_HELPER: runtime.helper,
    FACTORY_PROFILES_DIR: fixture.config.profilesDir,
  };

  await fs.writeFile(path.join(root, 'release-command'), '');

  const invocation = {
    cwd: root,
    encoding: 'utf8' as const,
    env: environment,
  };
  const launch = spawnSync(runtime.engineBin, [
    '71', 'start', '--route', 'command', '--ticket-json', ticket, ...paths,
  ], invocation);

  assert.equal(launch.status, 0, launch.stderr);

  const cursor = await expectAttempt(fixture.adapter, (value) => value.cursor?.node === 'gate_accept');
  const identity = {
    task: '71',
    profile: 'demo-profile',
    attempt: cursor.attempt,
    node: 'build',
    stage: 'BUILD',
  };

  /**
   * Вызывает штатный exact CLI с каталогами тестовой установки.
   * Настройки окружения ограничены доверенными путями и stub CLI.
   */
  function invoke(operation: string, ...tail: string[]) {
    return spawnSync(runtime.engineBin, [
      '71', 'runner', 'settings', operation, '--attempt', identity.attempt,
      '--node', identity.node, '--stage', identity.stage, ...paths, ...tail,
    ], invocation);
  }

  const read = invoke('options', '--provider', 'deepseek');

  assert.equal(read.status, 0, read.stderr);

  const options = decodeStageRunnerOptions(JSON.parse(read.stdout));

  assert.equal(options.revision, 0);
  assert.equal(options.inherited?.model, flash);
  assert.equal(options.actual, null);

  const payload = {
    identity,
    expectedRevision: options.revision,
    catalogRevision: options.catalogRevision,
    expectedRun: null,
    mode: 'next',
    requestId: 'owner-save',
    selection: {
      primary: null,
      parametersFor: 'deepseek',
      model: pro,
      effort: 'max',
    },
  };

  const foreign = { ...payload, identity: { ...identity, node: 'verify' } };

  assert.match(invoke('apply', '--payload', JSON.stringify(foreign)).stderr, /identity_conflict/u);

  const refusedEffort = { ...payload, selection: { ...payload.selection, effort: 'high' } };

  assert.match(invoke('apply', '--payload', JSON.stringify(refusedEffort)).stderr, /effort_unavailable/u);
  await writeCatalog('Изменившийся каталог');
  assert.match(invoke('apply', '--payload', JSON.stringify(payload)).stderr, /catalog_stale/u);
  await writeCatalog();

  const invalid = invoke('apply', '--payload', JSON.stringify({
    ...payload,
    selection: { ...payload.selection, model: 'missing' },
  }));

  assert.match(invalid.stderr, /model_unavailable/u);

  const accepted = invoke('apply', '--payload', JSON.stringify(payload));

  assert.equal(accepted.status, 0, accepted.stderr);

  const result = decodeStageRunnerOptions(JSON.parse(accepted.stdout));

  assert.equal(result.revision, 1);
  assert.equal(result.receipt?.state, 'saved');
  assert.deepEqual(result.selection, payload.selection);

  const changed = { ...payload, selection: { ...payload.selection, effort: 'off' } };

  assert.match(invoke('apply', '--payload', JSON.stringify(changed)).stderr, /request_conflict/u);
  assert.match(invoke('apply', '--payload', JSON.stringify({
    ...changed, requestId: 'stale-save',
  })).stderr, /revision_conflict/u);

  await fs.unlink(metadata);

  const unavailable = invoke('options', '--provider', 'deepseek');

  assert.equal(unavailable.status, 69, unavailable.stderr);

  const replay = invoke('apply', '--payload', JSON.stringify(payload));

  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(decodeStageRunnerOptions(JSON.parse(replay.stdout)).revision, 1);

  const app = await fixture.open({ runtime, deepseekBin });
  let savedRevision = 1;

  if (liveMode === 'next') {
    await writeCatalog();

    const override = await app.inject({
      method: 'POST',
      url: '/api/tasks/71/runner/override',
      payload: { stage: 'BUILD', primary: 'deepseek' },
    });

    assert.equal(override.statusCode, 200, override.body);

    const result = decodeStageRunnerOptions(JSON.parse(override.json().output));

    assert.equal(result.revision, 2);
    assert.equal(result.selection.primary, 'deepseek');
    assert.equal(result.selection.model, pro);
    savedRevision = result.revision;
  }

  const state = path.join(fixture.config.factoryControlDir,
    'protocol-v2/tasks/t71/attempts', identity.attempt, 'runner-settings/build.json');

  assert.equal((await fs.stat(state)).mode & 0o777, 0o600);

  const ready = path.join(root, 'provider.ready');
  const release = path.join(root, 'provider.release');
  const retry = path.join(root, 'provider.retry');
  const wrapper = [
    'import assert from "node:assert/strict";',
    'import { execFileSync } from "node:child_process";',
    'import { existsSync, writeFileSync } from "node:fs";',
    'import { setTimeout as delay } from "node:timers/promises";',
    'const get = (key) => process.argv[process.argv.indexOf(key) + 1];',
    'const stage = process.env.FACTORY_RUN_STAGE;',
    'const run = process.env.FACTORY_RUN_ID;',
    'const epoch = Number(process.env.FACTORY_RUN_EPOCH);',
    'assert.equal(process.env.PROFILE_AGENT_CONTROL_DIR, undefined);',
    'if (epoch === 1) {',
    `  assert.equal(get("--model"), ${JSON.stringify(pro)});`,
    '  assert.equal(get("--effort"), "max");',
    `  writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ id: run, epoch }));`,
    `  while (!existsSync(${JSON.stringify(release)})) { await delay(25); }`,
    `  assert.equal(get("--model"), ${JSON.stringify(pro)});`,
    '  process.exit(0);',
    '}',
    `assert.equal(get("--model"), ${JSON.stringify(flash)});`,
    'assert.equal(get("--effort"), "high");',
    `writeFileSync(${JSON.stringify(retry)}, JSON.stringify({ id: run, epoch }));`,
    'execFileSync(process.env.FACTORY_STATUS_BIN, [',
    '  "stage-result", "--task", "71", "--stage", stage, "--run-id", run, "--epoch", String(epoch),',
    '  "done", "Сохранённая модель запущена",',
    ']);',
    '',
  ];

  await fs.writeFile(path.join(scripts, 'deepseekRunner.mts'), wrapper.join('\n'));

  const gate = spawnSync(runtime.engineBin, [
    '71', 'gate', '--attempt', identity.attempt, '--node', 'gate_accept', '--decision', 'approved',
    '--commit-only', ...paths,
  ], invocation);

  assert.equal(gate.status, 0, gate.stderr);

  const resume = runFile(runtime.engineBin, ['71', 'resume', '--attempt', identity.attempt, ...paths], {
    ...invocation,
    timeout: 15_000,
  });
  const finished = resume.catch((error: Error) => error);
  let verified = false;

  try {
    for (let probe = 0; probe < 100; probe += 1) {
      if (await fs.access(ready).then(() => true, () => false)) {
        break;
      }

      await delay(25);
    }

    const run = JSON.parse(await fs.readFile(ready, 'utf8'));
    const file = path.join(fixture.config.stateDir, 'logs/runs/t71/BUILD', run.id, 'meta.env');

    assert.equal(await fs.readFile(controlEvents, 'utf8'), 'start 71 BUILD\n');
    assert.equal((await fs.stat(controlChannel)).mode & 0o777, 0o700);
    await fs.appendFile(file, 'RUNNER=codex\nMODEL=false\nEFFORT=false\n');

    const active = invoke('show');

    assert.equal(active.status, 0, active.stderr);
    assert.deepEqual(decodeStageRunnerOptions(JSON.parse(active.stdout)).actual, {
      run,
      provider: 'deepseek',
      model: pro,
      effort: 'max',
    });

    await writeCatalog();

    const query = new URLSearchParams({
      profile: identity.profile,
      attempt: identity.attempt,
      node: identity.node,
      stage: identity.stage,
      provider: 'deepseek',
    });
    const liveRead = await app.inject({ method: 'GET', url: `/api/tasks/71/runner/options?${query}` });

    assert.equal(liveRead.statusCode, 200, liveRead.body);

    const liveOptions = decodeStageRunnerOptions(liveRead.json());
    const livePayload = {
      ...payload,
      expectedRevision: liveOptions.revision,
      expectedRun: run,
      catalogRevision: liveOptions.catalogRevision,
      requestId: 'next-epoch',
      mode: liveMode,
      selection: {
        ...payload.selection,
        model: flash,
        effort: 'high',
      },
    };
    const stale = invoke('apply', '--payload', JSON.stringify({
      ...livePayload,
      expectedRun: { ...run, epoch: run.epoch + 1 },
    }));

    assert.match(stale.stderr, /identity_conflict/u);

    const saved = await app.inject({
      method: 'POST',
      url: '/api/tasks/71/runner/settings',
      payload: livePayload,
    });

    assert.equal(saved.statusCode, 200, saved.body);

    const view = decodeStageRunnerOptions(saved.json());

    assert.equal(view.revision, savedRevision + 1);
    assert.equal(view.receipt?.state, liveMode === 'next' ? 'saved' : 'pending');
    assert.deepEqual(view.selection, livePayload.selection);

    if (liveMode === 'next') {
      assert.deepEqual(view.actual, liveOptions.actual);
    } else {
      for (let probe = 0; probe < 100; probe += 1) {
        if (await fs.access(retry).then(() => true, () => false)) {
          break;
        }

        await delay(25);
      }

      await fs.access(retry);
      await assert.rejects(fs.access(release), { code: 'ENOENT' });

      const requests = path.join(fixture.config.stateDir, 'logs/runs/t71/BUILD', run.id, 'control-requests');
      const late = spawnSync(runtime.engineBin, [
        'stage-result', '--task', '71', '--stage', 'BUILD', '--run-id', run.id,
        '--epoch', String(run.epoch), 'done', 'Просроченный результат',
      ], {
        ...invocation,
        env: {
          ...environment,
          FACTORY_RUN_TASK: '71',
          FACTORY_RUN_STAGE: 'BUILD',
          FACTORY_RUN_ATTEMPT: identity.attempt,
          FACTORY_RUN_ID: run.id,
          FACTORY_RUN_EPOCH: String(run.epoch),
          FACTORY_STATE: fixture.config.stateDir,
          FACTORY_STATUS_MODE: 'request',
          FACTORY_STATUS_REQUEST_DIR: requests,
        },
      });

      assert.equal(late.status, 0, late.stderr);
    }

    verified = true;
  } finally {
    await fs.writeFile(release, '');

    const result = await finished;

    if (verified && result instanceof Error) {
      const runs = path.join(fixture.config.stateDir, 'logs/runs/t71/BUILD');
      const files = await fs.readdir(runs);
      const diagnostics = await Promise.all(files.map((id) => fs.readFile(path.join(runs, id, 'stderr.log'),
        'utf8').catch(() => '')));

      throw new Error(diagnostics.join('\n') || result.message, { cause: result });
    }
  }

  const terminal = await expectAttempt(fixture.adapter, (value) => value.terminal === 'completed');

  assert.equal(terminal.attempt, identity.attempt);
  assert.equal(await fs.readFile(controlEvents, 'utf8'), 'start 71 BUILD\nstop 71 BUILD 0\n');
  await assert.rejects(fs.access(controlChannel), { code: 'ENOENT' });

  const { registry } = await fixture.adapter.readRegistry('71');

  assert.equal(registry.BUILD_COMMENT, 'Сохранённая модель запущена');

  const first = JSON.parse(await fs.readFile(ready, 'utf8'));
  const second = JSON.parse(await fs.readFile(retry, 'utf8'));

  assert.notEqual(second.id, first.id);
  assert.equal(second.epoch, first.epoch + 1);

  if (liveMode === 'restart') {
    const journal = spawnSync(runtime.engineBin, [
      '71', 'lifecycle-read', '--attempt', identity.attempt,
      '--control-dir', fixture.config.factoryControlDir,
    ], invocation);

    assert.equal(journal.status, 0, journal.stderr);

    const events = journal.stdout.trim().split('\n').map((line) => JSON.parse(line))
      .filter((event) => event.kind === 'runner_switch_requested' || event.kind === 'runner_switch_consumed');

    assert.deepEqual(events.map((event) => event.kind), [
      'runner_switch_requested', 'runner_switch_consumed',
    ]);
    assert.ok(events.every((event) => event.runId === first.id && event.epoch === first.epoch));
    assert.equal(events[0].details.requestRecordSha256, events[1].details.requestRecordSha256);
  }

  assert.equal((await fs.readdir(path.join(fixture.config.stateDir, 'logs/runs/t71/BUILD'))).length, 2);
  await assert.rejects(fs.access(path.join(fixture.config.factoryControlDir, 'runner-processes/t71.go.json')),
    { code: 'ENOENT' });
}

const modelSol = 'gpt-9.1-sol';
const modelOther = 'gpt-9.1-other';
const speedTimeout = { timeout: 240_000 };
const stdTier = 'service_tier="default"';
const fastTier = 'service_tier="priority"';

interface SpeedScenario {
  legacy?: boolean;
  auth?: { cliToken: string };
  twoNodes?: boolean;
  inherited?: string;
  provider?: 'codex' | 'claude';
  model?: string | null;
  packedHelpers?: boolean;
}

interface RunTrace {
  run: string;
  epoch: number;
  tier?: string;
  model?: string;
  effort?: string;
  fastMode?: boolean;
}

/**
 * Берёт старый ELF из офлайн-архива базового коммита или явной фикстуры CI.
 * Подмена ответа capabilities здесь не подтверждает совместимость со старым parser.
 */
async function legacyFactory(root: string) {
  if (process.env.FACTORY_TEST_LEGACY_BINARY) {
    return process.env.FACTORY_TEST_LEGACY_BINARY;
  }

  const source = path.join(root, 'legacy-source');
  const binary = path.join(root, 'legacy-factory');
  const archive = spawnSync('git', ['archive', 'a2d421977', 'go.mod', 'go.sum', 'utilities'], {
    cwd: repo,
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });

  assert.equal(archive.status, 0, 'legacy_source_unavailable');
  await fs.mkdir(source);
  execFileSync('tar', ['-x', '-C', source], {
    input: archive.stdout,
    timeout: 30_000,
  });

  const build = ['build', '-trimpath', '-buildvcs=false', '-o', binary, './utilities/factory/cmd/factory'];

  execFileSync('go', build, {
    cwd: source,
    env: {
      ...process.env,
      GOTOOLCHAIN: 'local',
      GOWORK: 'off',
    },
    timeout: 120_000,
  });

  return binary;
}

/**
 * Офлайн CLI пишет фактически полученные аргументы и держит BUILD до разрешения теста.
 * Команда версии, список флагов и запуск имеют отдельные входы.
 */
function speedCli(root: string, provider: 'codex' | 'claude') {
  return `#!${process.execPath}
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = ${JSON.stringify(root)};
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log(${JSON.stringify(provider === 'codex' ? 'codex-cli 0.172.0' : '2.1.200 (Claude Code)')});
  process.exit(0);
}
if (argv[0] === 'features' && argv[1] === 'list') {
  console.log('fast_mode stable true');
  console.log('ultrafast_mode stable true');
  process.exit(0);
}
const provider = ${JSON.stringify(provider)};
assert.equal(argv[0], provider === 'codex' ? 'exec' : '-p');
const option = (name) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const model = option(provider === 'codex' ? '-m' : '--model');
const reasoning = argv.find((arg) => arg.startsWith('model_reasoning_effort='));
const effort = provider === 'codex' && reasoning
  ? JSON.parse(reasoning.slice('model_reasoning_effort='.length)) : option('--effort');
const requested = argv.find((arg) => arg.startsWith('service_tier='));
const settings = provider === 'claude' ? JSON.parse(readFileSync(option('--settings'), 'utf8')) : {};
const stage = process.env.FACTORY_RUN_STAGE;
const run = process.env.FACTORY_RUN_ID;
const epoch = Number(process.env.FACTORY_RUN_EPOCH);
const key = stage + '-' + epoch;
writeFileSync(join(root, key + '.json'), JSON.stringify({
  run, epoch, model, effort, tier: requested, fastMode: settings.fastMode,
}));
if (stage === 'BUILD') {
  while (!existsSync(join(root, 'release-' + key))) await delay(25);
}
execFileSync(process.env.FACTORY_STATUS_BIN, [
  'stage-result', '--task', '71', '--stage', stage, '--run-id', run, '--epoch', String(epoch),
  'done', 'Тестовый результат',
]);
`;
}

/**
 * Helper распознаёт daemon и settings по реальному родителю.
 * Барьер держит один daemon probe, а HTTP продолжает читать обычный каталог.
 */
function speedCatalogHelper(root: string) {
  return `
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const root = ${JSON.stringify(root)};
const file = (name) => join(root, name);
const parent = readFileSync('/proc/' + process.ppid + '/cmdline', 'utf8').split('\0');
const daemon = parent[2] === 'resume';
assert.ok(daemon || (parent[2] === 'runner' && parent[3] === 'settings'), JSON.stringify(parent));
if (!daemon) appendFileSync(file('settings-argv.jsonl'), JSON.stringify(parent) + '\\n');
const catalog = JSON.parse(readFileSync(file('catalog.json'), 'utf8'));
if (parent[4] === 'apply' && existsSync(file('hold-apply'))) {
  writeFileSync(file('apply-ready'), '');
  while (!existsSync(file('apply-release'))) await delay(20);
}
if (daemon && existsSync(file('probe-mode')) && !existsSync(file('probe-ready'))) {
  const mode = readFileSync(file('probe-mode'), 'utf8');
  writeFileSync(file('probe-ready'), '');
  while (!existsSync(file('probe-release'))) await delay(20);
  catalog.models[0].speedModes = mode === 'fast' ? ['standard', 'fast'] : ['standard'];
}
console.log(JSON.stringify(catalog));
`;
}

/**
 * Ждёт собственный маркер с явным сроком и сохраняет диагностику неполного сценария.
 * Результат процесса не определяется задержкой между двумя проверками.
 */
async function waitSpeedFile(file: string) {
  const deadline = Date.now() + 30_000;

  for (;;) {
    try {
      return await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() >= deadline) {
        throw error;
      }
    }

    await delay(25);
  }
}

/**
 * Собирает независимую закреплённую попытку на воротах.
 * Профиль, CLI, каталоги и HTTP живут в одном временном корне.
 */
async function speedStage(t: TestContext, scenario: SpeedScenario = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speed-stage-'));
  const live: Promise<{ code: number; stderr: string }>[] = [];

  t.after(async () => {
    const barriers = [
      'release-BUILD-1', 'release-BUILD-2', 'release-BUILD-3', 'probe-release', 'apply-release',
    ];

    for (const name of barriers) {
      await fs.writeFile(path.join(root, name), '');
    }

    await Promise.all(live);
    await fs.rm(root, { recursive: true, force: true });
  });

  const engine = scenario.legacy ? await legacyFactory(root) : testFactoryBinary();
  const packageId = randomBytes(32).toString('hex');
  const helpers = scenario.packedHelpers
    ? ['factory-runtime-pin', 'factory-runner-models', 'external-cli-lease'] : ['factory-runtime-pin'];
  const runtime = await stageSettingsRuntime(root, engine, helpers, packageId);
  const fixture = await prepareCommandServer(t, root, engine, true, false, 1, scenario.twoNodes);
  const provider = scenario.provider ?? 'codex';
  const selectedModel = scenario.model === undefined ? modelSol : scenario.model;
  const binDir = path.join(root, 'bin');
  const binary = path.join(binDir, provider);
  const configFile = path.join(fixture.config.profilesDir, 'demo-profile', 'runners.env');
  const catalogFile = path.join(root, 'catalog.json');
  const metadata = path.join(runtime.runtimeRoot, 'server/runtime/helpers/factory-runner-models.mjs');

  await prepareIsolatedCommandWorkspace(fixture);
  await fs.mkdir(binDir);
  await fs.mkdir(path.join(root, 'codex-home'));

  if (!scenario.packedHelpers) {
    await fs.writeFile(binary, speedCli(root, provider), { mode: 0o700 });
  }

  if (scenario.legacy) {
    const previous = process.env.GRIGDESK_CODEX_BIN;

    process.env.GRIGDESK_CODEX_BIN = binary;
    t.after(() => {
      if (previous === undefined) {
        delete process.env.GRIGDESK_CODEX_BIN;
      } else {
        process.env.GRIGDESK_CODEX_BIN = previous;
      }
    });
  }

  /**
   * Пишет отдельные профильные ключи, которые можно заменить между двумя эпохами.
   * Нативная модель остаётся свободной при пустом model ID.
   */
  async function profile(inherited: string) {
    const prefix = `MODEL_DEFAULT_${provider.toUpperCase()}_`;
    const model = selectedModel ? [prefix + 'EXACT=' + selectedModel, prefix + 'EFFORT=high'] : [];

    await fs.writeFile(configFile, [
      'RUNNERS_SCHEMA=1',
      'CONFIG_REVISION=1',
      'RUNNERS_COVERAGE=required',
      `PROJECT_RUNNER_PRIMARY=${provider}`,
      'PROJECT_RUNNER_FAILOVER=',
      ...model,
      prefix + 'SPEED=' + inherited,
      'MODEL_VALIDATE_SPEED_CODEX_SPEED=standard',
      '',
    ].join('\n'));
  }

  /**
   * Переписывает только метаданные каталога и сохраняет model/effort неизменными.
   * Для Claude каталог содержит alias одной точной модели.
   */
  async function catalog(fast: boolean) {
    const modes = fast ? ['standard', 'fast'] : ['standard'];
    const id = provider === 'claude' ? 'claude-opus-fast' : modelSol;
    const models = [{
      id,
      efforts: ['low', 'high'],
      speedModes: modes,
      aliases: provider === 'claude' ? ['opus'] : [],
    }, {
      id: modelOther,
      efforts: ['high'],
      speedModes: ['standard'],
      aliases: [],
    }];

    await fs.writeFile(catalogFile, JSON.stringify({
      schema: 1,
      models,
    }));
  }

  await profile(scenario.inherited ?? 'standard');
  await catalog(true);

  if (!scenario.packedHelpers) {
    await fs.writeFile(metadata, speedCatalogHelper(root));
  } else {
    await fs.symlink(
      path.join(repo, 'server/node_modules'), path.join(runtime.runtimeRoot, 'server/node_modules'),
    );
  }

  const reservation = await reserveFactoryRuntime({
    ...runtime,
    controlRoot: fixture.config.factoryControlDir,
    stateRoot: fixture.config.stateDir,
    profileRoot: fixture.config.profilesDir,
    task: '71',
  });
  const environment: NodeJS.ProcessEnv = {
    HOME: root,
    PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    CODEX_HOME: path.join(root, 'codex-home'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude-home'),
    NODE_BIN: runtime.node,
    [`GRIGDESK_${provider.toUpperCase()}_BIN`]: binary,
    FACTORY_HOME: runtime.engineHome,
    GRIGDESK_SERVER_RUNTIME_RESERVATION: reservation.reservation,
    GRIGDESK_SERVER_RUNTIME_NODE: runtime.node,
    GRIGDESK_SERVER_RUNTIME_PIN_HELPER: runtime.helper,
    FACTORY_PROFILES_DIR: fixture.config.profilesDir,
  };
  const ticket = path.join(root, 'ticket.json');
  const paths = [
    '--profile', 'demo-profile', '--routes-dir', fixture.config.routesDir,
    '--control-dir', fixture.config.factoryControlDir, '--state-dir', fixture.config.stateDir,
  ];

  await fs.writeFile(ticket, JSON.stringify({
    schema: 1,
    taskId: '71',
    title: 'Проверка настроек скорости',
    description: 'Закреплённая офлайн-попытка',
    acceptanceCriteria: ['Запуск получает выбранную скорость'],
    sourceUrl: 'https://example.test/tasks/71',
  }));
  await fs.writeFile(path.join(root, 'release-command'), '');

  const invocation = {
    cwd: root,
    encoding: 'utf8' as const,
    env: environment,
  };
  const cli = (...args: string[]) => spawnSync(runtime.engineBin, ['71', ...args, ...paths], {
    ...invocation,
    timeout: 60_000,
  });
  const app = await fixture.open({ runtime }, scenario.auth);
  const headers = scenario.auth ? { 'X-GrigDesk-Token': scenario.auth.cliToken } : {};

  /**
   * Подтверждает реальный start и сохраняет точную identity выбранного узла.
   * Descriptor можно записать до старта для отдельной проверки lease.
   */
  async function start() {
    const result = cli('start', '--route', 'command', '--ticket-json', ticket);

    assert.equal(result.status, 0, result.stderr);

    const attempt = await expectAttempt(fixture.adapter,
      (value) => value.cursor?.node === 'gate_accept', 30_000);
    const identity = {
      task: '71',
      profile: 'demo-profile',
      attempt: attempt.attempt,
      node: 'build',
      stage: 'BUILD',
    };
    const query = new URLSearchParams({
      profile: identity.profile,
      attempt: identity.attempt,
      node: identity.node,
      stage: identity.stage,
      provider,
    });
    const get = (accept?: string) => app.inject({
      method: 'GET',
      url: `/api/tasks/71/runner/options?${query}`,
      headers: accept ? { ...headers, Accept: accept } : headers,
    });

    /**
     * Читает полную форму через HTTP и проверяет согласование кеширования.
     * Вариант без Accept вызывается отдельно для проверки старых клиентов.
     */
    async function options(accept = STAGE_RUNNER_SPEED_ACCEPT) {
      const response = await get(accept);

      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers.vary, 'Accept');
      assert.equal(response.headers['cache-control'], 'no-store');

      return decodeStageRunnerOptions(response.json());
    }

    const post = (payload: StageRunnerApply, accept?: string, authorized = true) => app.inject({
      method: 'POST',
      url: '/api/tasks/71/runner/settings',
      payload,
      headers: {
        ...(authorized ? headers : {}),
        ...(accept ? { Accept: accept } : {}),
      },
    });

    /**
     * Продолжает тот же пин с ограниченным сроком и сохраняет фактический код выхода.
     * Управляемые процессы дождутся освобождения при очистке теста.
     */
    function resume() {
      const result = runFile(runtime.engineBin, ['71', 'resume', '--attempt', identity.attempt, ...paths], {
        ...invocation,
        timeout: 180_000,
      }).then(({ stderr }) => ({ code: 0, stderr }), (error) => ({
        code: Number(error.code),
        stderr: String(error.stderr || error.message),
      }));

      live.push(result);

      return result;
    }

    /**
     * Снимает ровно текущие ворота без автоматического фонового запуска.
     * Дальнейший процесс принадлежит resume этого теста.
     */
    function approve() {
      const result = cli('gate', '--attempt', identity.attempt, '--node', 'gate_accept',
        '--decision', 'approved', '--commit-only');

      assert.equal(result.status, 0, result.stderr);
    }

    const invoke = (operation: string, ...tail: string[]) => cli(
      'runner', 'settings', operation, '--attempt', identity.attempt,
      '--node', 'build', '--stage', 'BUILD', ...tail,
    );

    return {
      identity,
      get,
      options,
      post,
      resume,
      approve,
      invoke,
    };
  }

  const mark = (name: string, text = '') => fs.writeFile(path.join(root, name), text);
  const release = (epoch: number) => mark(`release-BUILD-${epoch}`);
  const record = async (stage: string, epoch: number): Promise<RunTrace> =>
    JSON.parse(await waitSpeedFile(path.join(root, `${stage}-${epoch}.json`)));

  return {
    root,
    runtime,
    fixture,
    environment,
    binary,
    metadata,
    profile,
    catalog,
    start,
    mark,
    release,
    record,
  };
}

/**
 * Формирует новую запись из последнего exact снимка.
 * Переиспользование того же объекта в replay сохраняет все байты намерения.
 */
function speedPayload(view: StageRunnerOptions, requestId: string): StageRunnerApply {
  return {
    identity: view.identity,
    expectedRevision: view.revision,
    expectedRun: view.actual?.run ?? null,
    catalogRevision: view.catalogRevision,
    requestId,
    mode: 'next',
    selection: { ...view.selection },
  };
}

/**
 * Проверяет HTTP приём записи и возвращает тот же закрытый DTO.
 * Любой отказ сохраняет status и диагностику ответа Fastify.
 */
async function acceptedSpeed(
  live: Awaited<ReturnType<Awaited<ReturnType<typeof speedStage>>['start']>>,
  payload: StageRunnerApply,
  accept = STAGE_RUNNER_SPEED_ACCEPT,
) {
  const response = await live.post(payload, accept);

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers.vary, 'Accept');

  return decodeStageRunnerOptions(response.json());
}

test('скорость Codex через HTTP сохраняется и действует на одну эпоху и узел', speedTimeout, async (t) => {
  const fx = await speedStage(t, { twoNodes: true });
  const live = await fx.start();

  live.approve();

  const finished = live.resume();
  const first = await fx.record('BUILD', 1);
  const before = await live.options();

  assert.equal(first.tier, stdTier);
  assert.equal(before.actual?.speed, 'standard');
  assert.deepEqual(before.models[0]?.speedModes, ['standard', 'fast']);

  const next = speedPayload(before, 'speed-next');

  next.selection.speed = 'fast';

  const saved = await acceptedSpeed(live, next);

  assert.equal(saved.selection.speed, 'fast');
  assert.equal(saved.actual?.speed, 'standard');
  assert.deepEqual(saved.actual?.run, before.actual?.run);

  const current = await live.options();
  const { speed, ...legacy } = current.selection;
  const old = speedPayload(current, 'speed-old-client');

  assert.equal(speed, 'fast');
  old.selection = legacy;

  const legacyResponse = await live.post(old);

  assert.equal(legacyResponse.statusCode, 200, legacyResponse.body);
  assert.equal(Object.hasOwn(legacyResponse.json().selection, 'speed'), false);
  assert.equal(Object.hasOwn(legacyResponse.json().models[0], 'speedModes'), false);

  const incompatible = await live.options();
  const { speed: hidden, ...oldSelection } = incompatible.selection;
  const refused = speedPayload(incompatible, 'speed-old-model');

  assert.equal(hidden, 'fast');
  refused.selection = { ...oldSelection, model: modelOther };

  const failed = await live.post(refused);

  assert.equal(failed.statusCode, 409, failed.body);
  assert.match(failed.json().message, /speed_unavailable/u);
  assert.match(failed.json().message, /обновлённый редактор скорости.*совместимую модель/iu);

  const preserved = await live.options();

  assert.equal(preserved.revision, incompatible.revision);
  assert.deepEqual(preserved.selection, incompatible.selection);

  const modelOnly = speedPayload(preserved, 'speed-model-only');

  delete modelOnly.selection.speed;
  modelOnly.selection.model = modelSol;

  const modelSaved = await acceptedSpeed(live, modelOnly);

  assert.deepEqual(modelSaved.models[0]?.speedModes, ['standard', 'fast']);
  assert.equal(modelSaved.selection.speed, 'fast');

  const stale = speedPayload(modelSaved, 'speed-restart-stale');

  stale.mode = 'restart';
  await fx.catalog(false);

  const refusedRestart = await live.post(stale, STAGE_RUNNER_SPEED_ACCEPT);

  assert.equal(refusedRestart.statusCode, 409, refusedRestart.body);
  assert.equal((await live.options()).actual?.run.id, first.run);
  await fx.catalog(true);

  const restart = speedPayload(await live.options(), 'speed-restart');

  restart.mode = 'restart';

  const accepted = await acceptedSpeed(live, restart);
  const second = await fx.record('BUILD', 2);

  assert.equal(accepted.receipt?.state, 'pending');
  assert.notEqual(second.run, first.run);
  assert.equal(second.epoch, first.epoch + 1);
  assert.equal(second.tier, fastTier);
  assert.equal(second.model, first.model);
  assert.equal(second.effort, first.effort);

  const active = await live.options();

  assert.equal(active.inherited?.speed, 'standard');
  assert.equal(active.selection.speed, 'fast');
  assert.equal(active.actual?.speed, 'fast');
  await fs.rename(fx.metadata, fx.metadata + '.parked');

  const replay = await acceptedSpeed(live, restart);

  assert.equal(replay.receipt?.requestId, restart.requestId);
  assert.equal(replay.revision, accepted.revision);
  await fs.rename(fx.metadata + '.parked', fx.metadata);
  await fx.release(2);

  const result = await finished;

  assert.equal(result.code, 0, result.stderr);

  const neighbor = await fx.record('VALIDATE_SPEED', 1);

  assert.equal(neighbor.tier, stdTier);
  assert.equal(neighbor.model, first.model);
  assert.equal(neighbor.effort, first.effort);
  assert.notEqual(neighbor.run, second.run);
  await assert.rejects(fs.access(path.join(fx.root, 'BUILD-3.json')), { code: 'ENOENT' });
});

test('замороженное наследование скорости переживает restart', speedTimeout, async (t) => {
  const fx = await speedStage(t);
  const live = await fx.start();

  live.approve();

  const finished = live.resume();
  const first = await fx.record('BUILD', 1);

  assert.equal(first.tier, stdTier);
  await fx.profile('fast');

  const liveView = await live.options();

  assert.equal(liveView.inherited?.speed, 'fast');

  const restart = speedPayload(liveView, 'speed-inherited');

  restart.mode = 'restart';
  restart.selection.speed = null;
  await acceptedSpeed(live, restart);

  const second = await fx.record('BUILD', 2);

  assert.equal(second.tier, fastTier);
  assert.notEqual(second.run, first.run);
  await fx.release(2);

  const result = await finished;

  assert.equal(result.code, 0, result.stderr);
});

test('старый pin движка отдаёт прежнюю форму и отказывает скорости до эффекта', speedTimeout, async (t) => {
  const fx = await speedStage(t, { legacy: true });
  const live = await fx.start();
  const capability = spawnSync(fx.runtime.engineBin, ['capabilities', '--format', 'json'], {
    encoding: 'utf8',
    timeout: 10_000,
  });

  assert.equal(capability.status, 0, capability.stderr);

  const features = JSON.parse(capability.stdout).features;

  assert.ok(features.includes('stage-runner-settings-v1'));
  assert.equal(features.includes('stage-runner-speed-v1'), false);

  const before = await live.options();

  assert.equal(Object.hasOwn(before.models[0]!, 'speedModes'), false);

  const payload = speedPayload(before, 'speed-legacy-rejected');

  payload.selection.speed = 'fast';

  const rejected = await live.post(payload, STAGE_RUNNER_SPEED_ACCEPT);

  assert.equal(rejected.statusCode, 503, rejected.body);
  assert.equal((await live.options()).revision, before.revision);

  delete payload.selection.speed;

  const saved = await acceptedSpeed(live, payload);
  const rawTrace = await fs.readFile(path.join(fx.root, 'settings-argv.jsonl'), 'utf8');
  const trace = rawTrace.trim().split('\n').map((line) => JSON.parse(line) as string[]);

  assert.equal(saved.revision, before.revision + 1);
  assert.equal(Object.hasOwn(saved.selection, 'speed'), false);
  assert.ok(trace.some((argv) => argv[4] === 'apply'));
  assert.ok(trace.every((argv) => !argv.includes('--speed-v1')));
});

test('speed-capable pin требует auth и точную identity для скорости', speedTimeout, async (t) => {
  const fx = await speedStage(t, { auth: { cliToken: 'offline-speed-token' } });
  const live = await fx.start();
  const before = await live.options();
  const payload = speedPayload(before, 'speed-auth');

  payload.selection.speed = 'standard';

  const unauthorized = await live.post(payload, STAGE_RUNNER_SPEED_ACCEPT, false);

  assert.equal(unauthorized.statusCode, 401, unauthorized.body);
  assert.equal((await live.options()).revision, before.revision);

  const wrong = structuredClone(payload);

  wrong.identity.node = 'verify';

  const foreign = await live.post(wrong, STAGE_RUNNER_SPEED_ACCEPT);

  assert.equal(foreign.statusCode, 409, foreign.body);
  assert.equal((await live.options()).revision, before.revision);

  const saved = await acceptedSpeed(live, payload, '');

  assert.equal(Object.hasOwn(saved.selection, 'speed'), false);
  assert.equal((await live.options()).selection.speed, 'standard');
});

test('неизвестная скорость профиля безопасна при запуске и перекрывается явно', speedTimeout, async (t) => {
  const fx = await speedStage(t, { inherited: 'priority' });
  const live = await fx.start();
  const before = await live.options();
  const legacy = await live.get();

  assert.equal(before.inherited?.speedIssue, 'invalid_profile');
  assert.equal(legacy.statusCode, 200, legacy.body);
  assert.equal(Object.hasOwn(legacy.json().inherited, 'speedIssue'), false);

  live.approve();

  const finished = live.resume();
  const first = await fx.record('BUILD', 1);
  const actual = await live.options();

  assert.equal(first.tier, stdTier);
  assert.equal(first.model, modelSol);
  assert.equal(actual.actual?.speed, 'standard');
  assert.equal(actual.actual?.speedWarning, 'profile_speed_unavailable');

  const standard = speedPayload(actual, 'speed-literal-standard');

  standard.selection.speed = 'standard';

  const saved = await acceptedSpeed(live, standard);
  const reset = speedPayload(saved, 'speed-literal-reset');

  reset.selection.speed = null;

  const rejected = await live.post(reset, STAGE_RUNNER_SPEED_ACCEPT);

  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.match(rejected.json().message, /speed_unavailable/u);
  assert.equal((await live.options()).selection.speed, 'standard');
  await fx.release(1);

  const result = await finished;

  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(fs.access(path.join(fx.root, 'BUILD-2.json')), { code: 'ENOENT' });
});

test('отзыв Fast останавливает явный узел и не принимает невалидный restart', speedTimeout, async (t) => {
  const fx = await speedStage(t);
  const live = await fx.start();
  const next = speedPayload(await live.options(), 'speed-revoked-next');

  next.selection.speed = 'fast';
  await acceptedSpeed(live, next);
  await fx.catalog(false);
  live.approve();

  const unavailable = await live.resume();

  assert.equal(unavailable.code, 75, unavailable.stderr);
  assert.match(unavailable.stderr, /speed_unavailable/u);
  await assert.rejects(fs.access(path.join(fx.root, 'BUILD-1.json')), { code: 'ENOENT' });
  await fx.catalog(true);

  const finished = live.resume();
  const exited = finished.then((result) =>
    assert.fail(`ранний выход resume: ${result.code} ${result.stderr}`));
  const first = await Promise.race([fx.record('BUILD', 1), exited]);
  const restart = speedPayload(await live.options(), 'speed-revoked-restart');

  assert.equal(first.tier, fastTier);
  restart.mode = 'restart';
  await fs.rename(fx.metadata, fx.metadata + '.parked');

  const missing = await live.post(restart, STAGE_RUNNER_SPEED_ACCEPT);

  assert.equal(missing.statusCode, 503, missing.body);
  await fs.rename(fx.metadata + '.parked', fx.metadata);
  assert.equal((await live.options()).actual?.run.id, first.run);

  await fx.mark('probe-mode', 'standard');
  await acceptedSpeed(live, restart);
  await Promise.race([waitSpeedFile(path.join(fx.root, 'probe-ready')), exited]);
  await fx.mark('probe-release');

  const failed = await finished;

  assert.equal(failed.code, 75, failed.stderr);
  assert.match(failed.stderr, /speed_unavailable/u);
  await assert.rejects(fs.access(path.join(fx.root, 'BUILD-2.json')), { code: 'ENOENT' });

  const view = await live.options();

  assert.equal(view.receipt?.state, 'failed');
  assert.match(view.receipt?.reason ?? '', /speed_unavailable/u);

  const recover = speedPayload(view, 'speed-revoked-restart-recovery');

  recover.selection.speed = 'standard';
  await acceptedSpeed(live, recover);
  await fx.release(2);

  const resumed = await live.resume();

  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal((await fx.record('BUILD', 2)).tier, stdTier);
});

for (const model of [modelSol, null]) {
  test(`унаследованный Fast после отзыва продолжает работу на обычной скорости (${model})`,
    speedTimeout, async (t) => {
      const fx = await speedStage(t, {
        model,
        inherited: 'fast',
      });
      const live = await fx.start();
      const next = speedPayload(await live.options(), 'speed-inherited-next');

      next.selection.speed = null;
      await acceptedSpeed(live, next);
      await fx.catalog(false);
      live.approve();

      const finished = live.resume();
      const first = await fx.record('BUILD', 1);
      const actual = await live.options();

      assert.equal(first.tier, stdTier);
      assert.equal(first.model, model ?? undefined);
      assert.equal(actual.actual?.speedWarning, 'profile_speed_unavailable');

      const restart = speedPayload(actual, 'speed-inherited-restart');

      restart.mode = 'restart';
      restart.selection.speed = null;
      await acceptedSpeed(live, restart);

      const second = await fx.record('BUILD', 2);

      assert.equal(second.tier, stdTier);
      assert.equal(second.model, model ?? undefined);
      assert.equal((await live.options()).actual?.speedWarning, 'profile_speed_unavailable');
      await fx.release(2);

      const result = await finished;

      assert.equal(result.code, 0, result.stderr);
    });
}

test('Claude допускает Fast точного ID и сохраняет alias при fallback', speedTimeout, async (t) => {
  const fx = await speedStage(t, {
    provider: 'claude',
    inherited: 'fast',
    model: 'opus',
  });
  const live = await fx.start();
  const alias = speedPayload(await live.options(), 'speed-alias-refused');

  alias.selection.speed = 'fast';

  const refused = await live.post(alias, STAGE_RUNNER_SPEED_ACCEPT);

  assert.equal(refused.statusCode, 409, refused.body);
  assert.match(refused.json().message, /speed_unavailable/u);
  live.approve();

  const finished = live.resume();
  const first = await fx.record('BUILD', 1);
  const actual = await live.options();

  assert.equal(first.model, 'opus');
  assert.equal(first.fastMode, false);
  assert.equal(first.effort, 'high');
  assert.equal(actual.actual?.speedWarning, 'profile_speed_unavailable');

  const exact = speedPayload(actual, 'speed-exact-claude');

  exact.mode = 'restart';
  exact.selection.model = 'claude-opus-fast';
  exact.selection.speed = 'fast';
  await acceptedSpeed(live, exact);

  const second = await fx.record('BUILD', 2);

  assert.equal(second.model, 'claude-opus-fast');
  assert.equal(second.fastMode, true);
  assert.equal(second.effort, 'high');

  await fx.release(2);

  const result = await finished;

  assert.equal(result.code, 0, result.stderr);
});

for (const probe of ['fast', 'standard']) {
  test(`CAS перепроверяет durable выбор после удержанного probe (${probe})`, speedTimeout, async (t) => {
    const fx = await speedStage(t);
    const live = await fx.start();
    const first = speedPayload(await live.options(), 'speed-before-probe');

    first.selection.speed = 'fast';
    await acceptedSpeed(live, first);
    await fx.mark('probe-mode', probe);
    live.approve();

    const finished = live.resume();

    await waitSpeedFile(path.join(fx.root, 'probe-ready'));

    const next = speedPayload(await live.options(), 'speed-racing-next');

    assert.equal(next.expectedRun, null);
    next.selection.speed = 'standard';
    await acceptedSpeed(live, next);
    await fx.mark('probe-release');

    const run = await fx.record('BUILD', 1);

    assert.equal(run.tier, stdTier);
    await fx.release(1);

    const result = await finished;

    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(fs.access(path.join(fx.root, 'BUILD-2.json')), { code: 'ENOENT' });
  });
}

test('сохранение отказывает, если resume заменил снимок CLI под task lock', speedTimeout, async (t) => {
  const fx = await speedStage(t);
  const live = await fx.start();
  const before = await live.options();
  const next = speedPayload(before, 'speed-scope-race');

  next.selection.speed = 'standard';
  await fx.mark('hold-apply');

  const pending = live.post(next, STAGE_RUNNER_SPEED_ACCEPT);

  await waitSpeedFile(path.join(fx.root, 'apply-ready'));

  const replacement = path.join(fx.root, 'bin/codex-copy');
  const original = await fs.readFile(fx.binary, 'utf8');

  await fs.writeFile(replacement, original + '\n// Новая сборка fixture.\n', { mode: 0o700 });
  fx.environment.GRIGDESK_CODEX_BIN = replacement;
  await live.resume();
  await fx.mark('apply-release');

  const refusal = await pending;

  assert.equal(refusal.statusCode, 409, refusal.body);
  assert.match(refusal.json().message, /catalog_stale/u);

  const after = await live.options();

  assert.equal(after.revision, before.revision);
  assert.equal(after.actual, null);
  assert.equal(after.receipt, null);
  assert.notEqual(after.catalogRevision, before.catalogRevision);
});

/**
 * Снимает PID только из проверяемой фикстуры и ждёт выхода её сессии.
 * Zombie уже не держит lease и допускается как завершённый процесс.
 */
async function closedMetadataProcess(file: string) {
  const pid = Number(await fs.readFile(file, 'utf8'));
  const deadline = Date.now() + 5000;

  assert.ok(Number.isSafeInteger(pid) && pid > 1);

  for (;;) {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      return '';
    });
    const state = stat.slice(stat.lastIndexOf(')') + 2).charAt(0);

    if (!stat || state === 'Z' || state === 'X') {
      return pid;
    }

    assert.ok(Date.now() < deadline, `metadata CLI ${pid} пережил пробу`);
    await delay(50);
  }
}

/**
 * Наблюдает reader во время блокирующего options из worker того же теста.
 * После возврата options основная проверка отдельно подтверждает освобождение.
 */
function observeMetadataReader(root: string, leaseDirectory: string) {
  const script = `
const { parentPort, workerData } = require('node:worker_threads');
const { readFile } = require('node:fs/promises');
const { setTimeout } = require('node:timers/promises');
async function observe() {
  const { inspectCliLeases } = await import(workerData.module);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pid = await readFile(workerData.ready, 'utf8').catch(() => '');
    if (pid) {
      const stat = await readFile('/proc/' + pid + '/stat', 'utf8');
      const sid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(/\\s+/)[3]);
      const readers = await inspectCliLeases({ directory: workerData.directory, providerId: 'codex' });
      return readers.some((reader) => reader.sessionId === sid);
    }
    await setTimeout(35);
  }
  return false;
}
observe().then((found) => parentPort.postMessage(found));
`;
  const worker = new Worker(script, {
    eval: true,
    workerData: {
      ready: path.join(root, 'app.ready'),
      directory: leaseDirectory,
      module: pathToFileURL(path.join(repo, 'server/src/lib/providerInstall/leases.ts')).href,
    },
  });

  return new Promise<boolean>((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

test('проба features list и metadata helper по тайм-ауту закрывают сессию и reader lease',
  speedTimeout, async (t) => {
    const fx = await speedStage(t, { packedHelpers: true });
    const models = await codexModelFixture(t);
    const [sol, terra] = structuredClone(models.native);

    sol.serviceTiers = [{ id: 'priority' }];
    await fs.writeFile(models.metadataFile, JSON.stringify({
      data: [sol, terra],
      nextCursor: null,
    }));
    await fs.copyFile(models.binary, path.join(fx.root, 'codex-app-server.js'));
    await fs.writeFile(fx.binary, `#!/bin/sh
case "$1:$2" in
  --version:*) echo "codex-cli 0.172.0"; exit 0 ;;
  features:list)
    if [ -f "$HOME/features.hang" ]; then
      printf '%s' "$$" >"$HOME/features.ready"
      exec sleep 300
    fi
    echo "fast_mode stable true"
    echo "ultrafast_mode stable true"
    exit 0 ;;
  app-server:*)
    if [ -f "$HOME/app.hang" ]; then
      printf '%s' "$$" >"$HOME/app.ready"
      exec sleep 300
    fi ;;
esac
[ "$1" = app-server ] || exit 4
exec node "$HOME/codex-app-server.js" "$@"
`, { mode: 0o700 });

    const paths = createRuntimePaths({
      mode: 'helper',
      helperUrl: pathToFileURL(fx.runtime.helper).href,
    });
    const catalog = readHelperCatalog(path.join(paths.helperDirectory, 'helpers.json'));
    const lease = helperCommandFor(paths, catalog, 'external-cli-lease', []);
    const metadata = helperCommandFor(paths, catalog, 'factory-runner-models', []);

    assert.equal(lease.command, fx.runtime.node);
    assert.equal(lease.args[0], fx.runtime.helpers['external-cli-lease']);
    assert.equal(metadata.args[0], fx.runtime.helpers['factory-runner-models']);

    const leaseDirectory = path.join(fx.root, 'lease');
    const resourceKey = 'c'.repeat(64);
    const identity = await executableIdentity(fx.binary);
    const descriptor = path.join(fx.root, 'external-cli.json');
    const leaseInput = {
      directory: leaseDirectory,
      providerId: 'codex',
    };

    await fs.writeFile(descriptor, JSON.stringify({
      schemaVersion: 1,
      providers: { codex: {
        bin: fx.binary,
        identity,
        providerId: 'codex',
        resourceKey,
        leaseDirectory,
        leaseCommand: [lease.command, ...lease.args],
        env: {},
      } },
    }), { mode: 0o600 });
    fx.environment.FACTORY_EXTERNAL_CLI_DESCRIPTOR = descriptor;
    delete fx.environment.GRIGDESK_CODEX_BIN;

    const live = await fx.start();
    const options = () => live.invoke('options', '--provider', 'codex', '--speed-v1', '1');

    /**
     * Проверяет освобождение reader после завершения options.
     * Тот же ресурс сразу допускает штатное обслуживание.
     */
    const exclusive = async () => {
      assert.deepEqual(await inspectCliLeases(leaseInput), []);

      const started = Date.now();
      const lease = await acquireCliLease({
        ...leaseInput,
        resourceKey,
        mode: 'exclusive',
      });

      await lease.release();
      assert.ok(Date.now() - started < 3000);
    };

    await fx.mark('features.hang');
    assert.equal(await executableIdentity(fx.binary), identity);

    const featuresStarted = Date.now();
    const withoutFeatures = options();
    const featuresMs = Date.now() - featuresStarted;

    assert.equal(withoutFeatures.status, 0, withoutFeatures.stderr);
    assert.ok(featuresMs >= 5000 && featuresMs < 40_000);
    assert.deepEqual(decodeStageRunnerOptions(JSON.parse(withoutFeatures.stdout)).models[0]?.speedModes,
      ['standard']);

    const featuresPid = await closedMetadataProcess(path.join(fx.root, 'features.ready'));

    await exclusive();
    await fs.unlink(path.join(fx.root, 'features.hang'));

    await fx.mark('app.hang');
    assert.equal(await executableIdentity(fx.binary), identity);

    const observing = observeMetadataReader(fx.root, leaseDirectory);
    const metadataStarted = Date.now();
    const withoutMetadata = options();
    const metadataMs = Date.now() - metadataStarted;

    assert.equal(withoutMetadata.status, 69, withoutMetadata.stderr);
    assert.ok(await observing, 'во время IPC должен быть reader той же сессии');

    const metadataPid = await closedMetadataProcess(path.join(fx.root, 'app.ready'));

    await exclusive();
    await fs.unlink(path.join(fx.root, 'app.hang'));
    assert.equal(await executableIdentity(fx.binary), identity);

    const healthy = await live.options();

    assert.deepEqual(healthy.models.find((model) => model.id === sol.id)?.speedModes, ['standard', 'fast']);
    assert.deepEqual(healthy.models.find((model) => model.id === terra.id)?.speedModes, ['standard']);
    assert.ok((await models.methods()).includes('model/list'));
    assert.deepEqual(await inspectCliLeases(leaseInput), []);

    const version = spawnSync(fx.binary, ['--version'], {
      encoding: 'utf8',
      env: fx.environment,
      timeout: 1000,
    });

    assert.equal(version.stdout.trim(), 'codex-cli 0.172.0');
    t.diagnostic(version.stdout.trim());
    t.diagnostic(`features: ${featuresMs} мс, pid ${featuresPid}, options 0, reader []`);
    t.diagnostic(`model/list: ${metadataMs} мс, pid ${metadataPid}, options 69, reader []`);
  });
