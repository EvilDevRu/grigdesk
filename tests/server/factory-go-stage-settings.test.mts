import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { buildHelper } from '../../server/scripts/sea/helpers.mts';
import { stageFactoryCandidate } from '../../server/scripts/binary/factoryCandidate.mts';
import { reserveFactoryRuntime } from '../../server/src/lib/factoryRuntimePins.ts';
import { decodeStageRunnerOptions } from '../../shared/pipeline/stageRunnerSettings.ts';
import { expectAttempt, prepareCommandServer } from './helpers/factoryGoRuntime.mts';

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
async function stageSettingsRuntime(root: string, candidate: string) {
  const cacheDir = path.join(root, 'cache');
  const packageId = 'a'.repeat(64);
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

  const helper = await buildHelper({
    root: repo,
    manifestPath: path.join(repo, 'server/build/helpers.json'),
    id: 'factory-runtime-pin',
    outDir: helperDir,
    workDir: path.join(root, 'helper-build'),
  });

  await fs.writeFile(path.join(helperDir, 'helpers.json'), JSON.stringify({
    schema: 1,
    helpers: [{ id: 'factory-runtime-pin', entry: 'factoryRuntimePin.mts' }],
  }));

  return {
    cacheDir,
    packageId,
    runtimeRoot,
    engineHome,
    engineBin,
    node,
    helper: helper.file,
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
