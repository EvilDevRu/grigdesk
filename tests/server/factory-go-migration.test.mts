import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildHelper } from '../../server/scripts/sea/helpers.mts';
import { stageFactoryCandidate } from '../../server/scripts/binary/factoryCandidate.mts';
import {
  readExistingFactoryRuntimePin, reserveFactoryRuntime,
} from '../../server/src/lib/factoryRuntimePins.ts';
import { prepareFactoryRouteLaunch } from '../../server/src/lib/factoryLaunch.ts';
import {
  routeGateArgs, routeResumeArgs, routeStartArgs, runRouteEngine,
} from '../../server/src/lib/factoryRouteCli.ts';

import { expectAttempt, prepareCommandServer } from './helpers/factoryGoRuntime.mts';

const repo = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Две установки получают одинаковый ticket и профиль.
 * Все данные маршрута и попытки лежат в их собственных физических каталогах.
 */
async function makeInstall(t: Parameters<typeof prepareCommandServer>[0], root: string, binary: string) {
  const fx = await prepareCommandServer(t, root, binary);
  const ticket = path.join(root, 'ticket.json');
  const runners = path.join(root, 'runners');
  const profile = path.join(fx.config.profilesDir, 'demo-profile', 'runners.env');

  await fs.mkdir(runners);
  await fs.copyFile(path.join(repo, 'tests/engine/fakes/runners/alpha.sh'), path.join(runners, 'alpha.sh'));
  await fs.writeFile(profile, [
    'RUNNERS_SCHEMA=1', 'CONFIG_REVISION=1', 'RUNNERS_COVERAGE=required',
    'PROJECT_RUNNER_PRIMARY=alpha', 'PROJECT_RUNNER_FAILOVER=',
    'MODEL_DEFAULT_ALPHA_FAMILY=fixture', 'MODEL_DEFAULT_ALPHA_VERSION=latest', '',
  ].join('\n'));
  await fs.writeFile(ticket, JSON.stringify({
    schema: 1,
    taskId: '71',
    title: 'Локальная проверка',
    description: 'Одна команда',
    acceptanceCriteria: ['Ворота'],
    sourceUrl: 'https://example.test/tasks/71',
  }));
  await fs.writeFile(path.join(root, 'release-command'), '');

  const env = {
    HOME: root,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    LC_ALL: 'C',
    FACTORY_HOME: path.join(repo, 'engine'),
    NODE_BIN: process.execPath,
    FACTORY_STATE: fx.config.stateDir,
    STATE_DIR: fx.config.stateDir,
    FACTORY_CONTROL_ROOT: fx.config.factoryControlDir,
    FACTORY_CONFIG_ROOT: fx.config.factoryConfigRoot,
    FACTORY_PROFILES_DIR: fx.config.profilesDir,
    FACTORY_FORBID_LIVE: '0',
    FACTORY_TESTING: '1',
    FACTORY_RUNNERS_DIR: runners,
    FACTORY_TESTS_HOME: path.join(repo, 'tests/engine'),
    PYTHONDONTWRITEBYTECODE: '1',
  };
  const scope = ['--profile', 'demo-profile', '--routes-dir', fx.config.routesDir];

  const call = (bin: string, action: string, args: string[], host = {}) => {
    return spawnSync(bin, ['71', action, ...scope, ...args], {
      cwd: root,
      env: { ...env, ...host },
      encoding: 'utf8',
      timeout: 45_000,
    });
  };

  return {
    fx,
    call,
    ticket,
    root,
  };
}

test('Старый пин требует перепривязки, а Go продолжает тот же маршрут', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-go-migrate-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const candidate = path.join(root, 'factory');
  const build = spawnSync('go', ['build', '-trimpath', '-o', candidate, './utilities/factory/cmd/factory'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 20_000,
  });

  assert.equal(build.status, 0, build.stderr);

  const a = await makeInstall(t, path.join(root, 'archive'), candidate);
  const b = await makeInstall(t, path.join(root, 'current'), candidate);

  const cacheDir = path.join(a.root, 'server-runtime-cache');

  await fs.mkdir(cacheDir, { mode: 0o700 });

  const old = path.join(cacheDir, 'packages', 'a'.repeat(64), 'engine/bin/factory');
  const next = path.join(cacheDir, 'packages', 'b'.repeat(64), 'engine/bin/factory');
  const amb = await runtimePackage(cacheDir, 'a'.repeat(64), old);
  const gop = await runtimePackage(cacheDir, 'b'.repeat(64), next);

  await fs.mkdir(path.dirname(old), { recursive: true });
  await fs.writeFile(old, '#!/bin/sh\nexit 99\n', { mode: 0o555 });
  await stageFactoryCandidate({
    root: gop.runtimeRoot,
    binary: candidate,
    profileAbi: path.join(repo, 'engine/lib/delivery_contract.py'),
    os: process.platform,
    arch: process.arch,
  });

  const manifestPath = path.join(repo, 'server/build/helpers.json');
  const helpers = path.join(gop.runtimeRoot, 'server/runtime/helpers');

  await buildHelper({
    root: repo,
    manifestPath,
    id: 'factory-runtime-pin',
    outDir: helpers,
    workDir: path.join(root, 'helper-build'),
  });

  // Маршрут не допускает браузер. Фикстура объявляет только подключённый helper.
  const helperCatalog = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

  helperCatalog.helpers = helperCatalog.helpers.filter(
    (entry: { id: string }) => entry.id === 'factory-runtime-pin',
  );
  await fs.writeFile(path.join(helpers, 'helpers.json'), JSON.stringify(helperCatalog));

  const roots = {
    controlRoot: a.fx.config.factoryControlDir,
    stateRoot: a.fx.config.stateDir,
    profileRoot: a.fx.config.profilesDir,
    cacheDir,
  };
  const lease = await reserveFactoryRuntime({
    ...roots,
    ...amb,
    task: '71',
  });
  const context = {
    GRIGDESK_SERVER_RUNTIME_RESERVATION: lease.reservation,
    GRIGDESK_SERVER_RUNTIME_NODE: process.execPath,
    GRIGDESK_SERVER_RUNTIME_PIN_HELPER: path.join(repo, 'server/scripts/factoryRuntimePin.mts'),
  };
  const startedA = a.call(candidate, 'start', ['--route', 'command', '--ticket-json', a.ticket], context);

  assert.equal(startedA.status, 0, startedA.stderr);

  const startedB = b.call(candidate, 'start', ['--route', 'command', '--ticket-json', b.ticket]);

  assert.equal(startedB.status, 0, startedB.stderr);

  await fs.chmod(path.join(a.fx.config.stateDir, 't71.pipeline'), 0o664);

  const beforeA = await a.fx.adapter.readTrustedAttempt('71');
  const beforeB = await b.fx.adapter.readTrustedAttempt('71');

  assert.equal(beforeA.cursor?.node, 'gate_accept');
  assert.deepEqual(beforeA.cursor, beforeB.cursor);
  assert.equal(beforeA.routeHash, beforeB.routeHash);
  assert.notEqual(beforeA.attempt, beforeB.attempt);

  const identity = {
    task: '71',
    attempt: beforeA.attempt,
    profile: 'demo-profile',
  };
  const pin = () => readExistingFactoryRuntimePin({ ...roots, ...identity });
  const config = { ...a.fx.config, runtime: { ...gop, cacheDir } };
  const pinned = await pin();

  assert.equal(pinned?.packageId, amb.packageId);

  const app = await a.fx.open({ runtime: config.runtime });
  const gateArgs = routeGateArgs(config, {
    ...identity,
    node: 'gate_accept',
    decision: 'approved',
    comment: '',
  });
  const blocked = await runRouteEngine(config, gateArgs);

  assert.equal(blocked.code, 78, blocked.stderr);
  assert.equal(blocked.failure?.error, 'factory_runtime_engine_retired');
  assert.equal((await pin())?.packageId, amb.packageId);

  const rebinding = await app.inject({ method: 'POST', url: '/api/tasks/71/runtime-rebind' });

  assert.equal(rebinding.statusCode, 200, rebinding.body);
  assert.equal(rebinding.json().unpinned, true, rebinding.body);
  assert.equal(rebinding.json().packageId, amb.packageId);
  assert.equal(await pin(), null);

  const selected = await prepareFactoryRouteLaunch(config, gateArgs);

  assert.ok(selected.args.includes(gop.packageId));
  assert.ok(selected.args.includes(gop.engineBin));

  const transferred = await runRouteEngine(config, gateArgs);

  assert.equal(transferred.code, 0, transferred.stderr);
  assert.equal((await pin())?.packageId, gop.packageId);

  const resumedA = await runRouteEngine(config, routeResumeArgs(config, identity));

  assert.equal(resumedA.code, 0, resumedA.stderr);

  const gate = b.call(candidate, 'gate', [
    '--attempt', beforeB.attempt, '--node', 'gate_accept', '--decision', 'approved', '--commit-only',
  ]);

  assert.equal(gate.status, 0, gate.stderr);

  const resumedB = b.call(candidate, 'resume', ['--attempt', beforeB.attempt]);

  assert.equal(resumedB.status, 0, resumedB.stderr);

  for (const install of [a, b]) {
    assert.equal(await fs.readFile(path.join(install.root, 'command.count'), 'utf8'), '1\n');
  }

  const afterA = await a.fx.adapter.readTrustedAttempt('71');
  const afterB = await b.fx.adapter.readTrustedAttempt('71');

  assert.equal(afterA.attempt, beforeA.attempt);
  assert.equal(afterA.terminal, 'completed');
  assert.deepEqual(afterA.cursor, afterB.cursor);
  assert.equal(afterA.routeHash, afterB.routeHash);
  assert.equal(afterA.stageIdentity?.sequence, afterB.stageIdentity?.sequence);

  const history = spawnSync(candidate, [
    '71', 'lifecycle-read', '--attempt', afterB.attempt, '--control-dir', b.fx.config.factoryControlDir,
  ], { encoding: 'utf8', timeout: 10000 });

  assert.equal(history.status, 0, history.stderr);

  const rows = history.stdout.trim().split('\n').map((line) => JSON.parse(line));

  assert.ok(rows.some((row) => row.kind === 'node_visit_started'
    && row.nodeId === 'verify' && row.attemptId === afterB.attempt));
  t.diagnostic(`A=${afterA.attempt} B=${afterB.attempt} route=${afterA.routeHash}, count=1/1`);
});

/**
 * Приватный кэш для API pin с физическим Node данного поколения.
 * Рабочие корни попыток остаются в своих отдельных установках.
 */
async function runtimePackage(cacheDir: string, packageId: string, engineBin: string) {
  const runtimeRoot = path.join(cacheDir, 'packages', packageId);
  const node = path.join(runtimeRoot, 'runtime/node/bin/node');

  await fs.mkdir(path.dirname(node), { recursive: true, mode: 0o700 });
  await fs.copyFile(process.execPath, node);
  await fs.chmod(node, 0o700);

  return {
    packageId,
    runtimeRoot,
    node,
    engineBin,
    engineHome: path.dirname(path.dirname(engineBin)),
  };
}

/**
 * Подменяется только CLI-граница провайдера. Pin helper и Go движок собраны по
 * штатному рецепту, metadata и число этапов записываются в приватную фикстуру.
 */
async function goInstall(cacheDir: string, packageId: string, binary: string, fixture: {
  marker: string;
  readyFlag?: string;
  probeLog: string;
  runLog: string;
  helper: string;
  manifest: string;
}) {
  const engine = path.join(cacheDir, 'packages', packageId, 'engine/bin/factory');
  const installed = await runtimePackage(cacheDir, packageId, engine);

  await stageFactoryCandidate({
    root: installed.runtimeRoot,
    binary,
    profileAbi: path.join(repo, 'engine/lib/delivery_contract.py'),
    os: process.platform,
    arch: process.arch,
  });

  const helpers = path.join(installed.runtimeRoot, 'server/runtime/helpers');

  await fs.mkdir(helpers, { recursive: true, mode: 0o700 });
  await fs.copyFile(fixture.helper, path.join(helpers, 'factory-runtime-pin.mjs'));
  await fs.writeFile(path.join(helpers, 'helpers.json'), fixture.manifest);
  await fs.writeFile(path.join(helpers, 'glm-runtime-info.mjs'), [
    "import { appendFileSync, existsSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(fixture.probeLog)}, ${JSON.stringify(packageId[0] + '\n')});`,
    `const ready = ${fixture.readyFlag ? `existsSync(${JSON.stringify(fixture.readyFlag)})` : 'false'};`,
    `const code = ${JSON.stringify(fixture.marker)};`,
    'if (ready || !code) {',
    "  console.log('0.1.5.fixture');",
    '} else {',
    "  console.error(JSON.stringify({ code, error: 'fixture' }));",
    '  process.exitCode = 1;',
    '}',
  ].join('\n'));
  await fs.writeFile(path.join(helpers, 'glm-runner.mjs'), [
    "import { appendFileSync } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    `appendFileSync(${JSON.stringify(fixture.runLog)}, ${JSON.stringify(packageId[0] + '\n')});`,
    'const e = process.env;',
    "const args = ['stage-result', '--task', e.FACTORY_RUN_TASK, '--stage', e.FACTORY_RUN_STAGE,",
    "  '--run-id', e.FACTORY_RUN_ID, '--epoch', e.FACTORY_RUN_EPOCH, 'done'];",
    'const result = spawnSync(e.FACTORY_STATUS_BIN, args, { stdio: \'inherit\' });',
    'process.exitCode = result.status ?? 97;',
    // Подтверждение запуска остаётся наблюдаемым для transient-сервера.
    'await new Promise((resolve) => setTimeout(resolve, 800));',
  ].join('\n'));

  return { ...installed, cacheDir };
}

test('Go resume перепривязывает runtime ровно один раз по доказанной несовместимости', {
  skip: process.platform !== 'linux',
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-go-auto-rebind-'));

  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const candidate = path.join(root, 'factory');
  const build = spawnSync('go', ['build', '-trimpath', '-o', candidate, './utilities/factory/cmd/factory'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 20_000,
  });

  assert.equal(build.status, 0, build.stderr);

  const manifestPath = path.join(repo, 'server/build/helpers.json');
  const compiled = await buildHelper({
    root: repo,
    manifestPath,
    id: 'factory-runtime-pin',
    outDir: path.join(root, 'compiled'),
    workDir: path.join(root, 'helper-build'),
  });
  const meta = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const manifest = JSON.stringify({
    ...meta,
    helpers: meta.helpers.filter((entry: { id: string }) => entry.id === 'factory-runtime-pin'),
  });
  const incompatible = 'glm_runtime_incompatible';

  const scenarios = [
    {
      name: 'ready',
      markerB: '',
      failover: '',
      probes: 'a\nb\n',
      status: 200,
      pin: 'b',
    },
    {
      name: 'second',
      markerB: incompatible,
      failover: '',
      probes: 'a\nb\n',
      status: 500,
      pin: 'b',
    },
    {
      name: 'mixed',
      markerB: '',
      failover: 'claude',
      probes: 'a\n',
      status: 500,
      pin: 'a',
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (child) => {
      const dir = path.join(root, scenario.name);
      const fx = await prepareCommandServer(child, dir, candidate, true);
      const probeLog = path.join(dir, 'probe.log');
      const runLog = path.join(dir, 'run.log');
      const readyFlag = path.join(dir, 'A-ready');
      const elf = path.join(dir, 'deepseek');
      const cacheDir = path.join(dir, 'runtime-cache');
      const fixture = {
        probeLog,
        runLog,
        manifest,
        helper: compiled.file,
      };

      await fs.mkdir(cacheDir, { mode: 0o700 });

      const a = await goInstall(cacheDir, 'a'.repeat(64), candidate, {
        ...fixture,
        marker: incompatible,
        readyFlag,
      });
      const b = await goInstall(cacheDir, 'b'.repeat(64), candidate, {
        ...fixture,
        marker: scenario.markerB,
      });

      await fs.writeFile(elf, '#!/bin/sh\nexit 97\n', { mode: 0o700 });
      await fs.writeFile(path.join(dir, 'unit-bin/claude'), '#!/bin/sh\nexit 4\n', { mode: 0o700 });
      await fs.writeFile(readyFlag, '');
      await fs.writeFile(runLog, '');
      await fs.writeFile(path.join(dir, 'release-command'), '');
      await exerciseAutoRebind(fx, {
        a,
        b,
        scenario,
        probeLog,
        runLog,
        readyFlag,
        elf,
        dir,
      });
    });
  }
});

type RebindPackage = Awaited<ReturnType<typeof goInstall>>;
type AutoRebindFixture = Awaited<ReturnType<typeof prepareCommandServer>>;

/**
 * Начальный pin ставится штатным start, ворота фиксируются короткой командой.
 * Только HTTP resume имеет право снять pin при доказанном отказе.
 */
async function exerciseAutoRebind(fx: AutoRebindFixture, input: {
  a: RebindPackage;
  b: RebindPackage;
  scenario: {
    failover: string;
    probes: string;
    status: number;
    pin: string;
  };
  probeLog: string;
  runLog: string;
  readyFlag: string;
  elf: string;
  dir: string;
}) {
  const { a, b, scenario, probeLog, runLog, readyFlag, elf, dir } = input;
  const previousMode = process.env.GRIGDESK_GLM_API_MODE;
  const ticketFile = path.join(dir, 'ticket.json');
  const profile = 'demo-profile';
  const settings = path.join(fx.config.profilesDir, profile, 'runners.env');
  const initial = {
    ...fx.config,
    runtime: a,
    deepseekBin: elf,
  };
  const current = { ...initial, runtime: b };
  const roots = {
    controlRoot: fx.config.factoryControlDir,
    stateRoot: fx.config.stateDir,
    profileRoot: fx.config.profilesDir,
    cacheDir: a.cacheDir,
    task: '71',
    profile,
  };

  process.env.GRIGDESK_GLM_API_MODE = 'api';

  try {
    await fs.writeFile(settings, [
      'RUNNERS_SCHEMA=1', 'CONFIG_REVISION=1', 'RUNNERS_COVERAGE=required',
      'PROJECT_RUNNER_PRIMARY=glm', 'PROJECT_RUNNER_FAILOVER=', '',
    ].join('\n'));
    await fs.writeFile(ticketFile, JSON.stringify({
      schema: 1,
      taskId: '71',
      title: 'Перепривязка',
      description: 'Проверка одного продолжения',
      acceptanceCriteria: ['Один результат'],
      sourceUrl: 'https://example.test/tasks/71',
    }));

    const started = await runRouteEngine(initial, routeStartArgs(initial, {
      task: '71',
      profile,
      route: 'command',
      ticketFile,
    }));

    assert.equal(started.code, 0, started.stderr);

    const waiting = await fx.adapter.readTrustedAttempt('71');
    const identity = {
      task: '71',
      profile,
      attempt: waiting.attempt,
    };
    const startedPin = await readExistingFactoryRuntimePin({ ...roots, attempt: waiting.attempt });

    assert.equal(startedPin?.packageId, a.packageId);
    assert.equal(waiting.cursor?.node, 'gate_accept');

    const gate = await runRouteEngine(initial, routeGateArgs(initial, {
      ...identity,
      node: 'gate_accept',
      decision: 'approved',
    }));

    assert.equal(gate.code, 0, gate.stderr);

    const before = await fx.adapter.readTrustedAttempt('71');

    assert.equal(before.cursor?.node, 'build');
    await fs.unlink(readyFlag);
    await fs.writeFile(settings, [
      'RUNNERS_SCHEMA=1', 'CONFIG_REVISION=2', 'RUNNERS_COVERAGE=required',
      'PROJECT_RUNNER_PRIMARY=glm', `PROJECT_RUNNER_FAILOVER=${scenario.failover}`, '',
    ].join('\n'));
    await fs.writeFile(probeLog, '');

    const server = await fx.open(current);
    const response = await server.inject({
      method: 'POST',
      url: '/api/tasks/71/resume',
      payload: identity,
    });

    assert.equal(response.statusCode, scenario.status, response.body);
    assert.equal(await fs.readFile(probeLog, 'utf8'), scenario.probes);

    const rebound = await readExistingFactoryRuntimePin({ ...roots, attempt: waiting.attempt });

    assert.equal(rebound?.packageId, scenario.pin.repeat(64));

    if (scenario.status === 200) {
      const completed = await expectAttempt(fx.adapter, (value) => value.terminal === 'completed');

      assert.equal(completed.attempt, before.attempt);
      assert.equal(completed.routeHash, before.routeHash);
      assert.equal(await fs.readFile(runLog, 'utf8'), 'b\n');
    } else {
      const after = await fx.adapter.readTrustedAttempt('71');
      const error = scenario.failover ? 'runner_preflight_unavailable' : 'runner_preflight_incompatible';

      assert.equal(response.json().error, error, response.body);
      assert.deepEqual(after.stageIdentity, before.stageIdentity);
      assert.equal(after.attempt, before.attempt);
      assert.equal(await fs.readFile(runLog, 'utf8'), '');
    }

    assert.equal(await fs.readFile(path.join(dir, 'command.count'), 'utf8'), '1\n');
  } finally {
    if (previousMode === undefined) {
      delete process.env.GRIGDESK_GLM_API_MODE;
    } else {
      process.env.GRIGDESK_GLM_API_MODE = previousMode;
    }
  }
}
