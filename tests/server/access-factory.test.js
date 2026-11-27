import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  OLD_KEY, activate, addProfile, apiAdapters, profileFixture, profiles,
  serverWorker, syntheticAdapter, vendorServer,
} from '../helpers/accessProfiles.js';
import { prepareCliFixture } from '../helpers/accessCliFixture.js';
import { testFactoryBinary } from '../helpers/factoryBinary.mjs';
import { codexModelFixture } from '../helpers/factoryStageModelMetadata.mjs';
import { cliJson, sourceRoot, writeStageMetadataScope } from '../helpers/stageRunnerSettingsFixture.mjs';
import codex from '../../server/src/lib/executors/codex.ts';
import { executableIdentity } from '../../server/src/lib/providerInstall/executableIdentity.ts';
import {
  expectAttempt, prepareCommandServer, prepareIsolatedCommandWorkspace,
} from './helpers/factoryGoRuntime.mts';
import { factoryDecisionFixture } from './helpers/factoryDecisionFixture.js';

/**
 * Stub заменяет только процессы движка/systemd, ledger остаётся production-формата.
 * Первый запуск проходит HTTP preflight, продолжение использует production spawn-границу.
 */
async function executable(root, name, fixture) {
  const template = new URL(`../fixtures/access-profiles/${fixture}`, import.meta.url);
  const source = await fs.readFile(template, 'utf8');

  await fs.writeFile(path.join(root, 'bin', name), `#!${process.execPath}\n${source}`, { mode: 0o700 });
}

test('AP20_pipeline_pin: systemd и detached сохраняют выбранный доступ через паузу и рестарт', async (t) => {
  for (const systemd of [true, false]) {
    await t.test(systemd ? 'systemd' : 'detached', async (t) => {
      const cleanups = [];
      let ledger;
      let f;

      t.after(async () => {
        await f?.app.close();
        await ledger?.app.close();

        for (const cleanup of cleanups) {
          await cleanup();
        }
      });
      ledger = await factoryDecisionFixture({ after: (cleanup) => cleanups.push(cleanup) }, {
        after: { state: 'stopped', sequence: 9 },
      });

      const root = path.dirname(ledger.adapter.stateDir);
      const vendor = await vendorServer(t);
      const env = { DEEPSEEK_API_KEY: OLD_KEY };

      await fs.writeFile(path.join(root, '.env'), `DEEPSEEK_API_KEY=${OLD_KEY}\n`, { mode: 0o600 });
      await fs.rename(path.join(root, 'state/t7.pipeline'), path.join(root, 'seed.pipeline'));
      await fs.mkdir(path.join(root, 'lib/runners'), { recursive: true });
      await fs.writeFile(path.join(root, 'lib/runners/deepseek.sh'), '# Исполнитель фикстуры\n');
      await fs.writeFile(path.join(root, 'profiles/demo/graph.json'), JSON.stringify({
        capabilities: [],
        default_route: 'feature',
        routes: { feature: { pos: { build: [0, 0] }, edges: [] } },
      }));
      await fs.writeFile(path.join(root, 'profiles/demo/profile.sh'), [
        'PROFILE_TRIAGE_REPOS=""',
        `profile_repositories() { printf 'demo\\t${root}/worktree\\t${root}/worktree\\n'; }`,
        '',
      ].join('\n'));
      await fs.writeFile(path.join(root, 'bin/systemctl'), '#!/bin/sh\n'
        + `if test -f '${root}/factory-capture.json'; then echo active; else echo inactive; exit 3; fi\n`,
      { mode: 0o700 });

      f = await profileFixture(t, {
        root,
        env,
        vendor,
        adapters: [...apiAdapters(env, vendor), syntheticAdapter()],
        config: {
          stateDir: ledger.adapter.stateDir,
          factoryBin: path.join(root, 'bin/factory'),
          factoryControlDir: path.join(root, 'control'),
          factoryConfigRoot: path.join(root, 'config'),
          routesDir: path.join(root, 'routes'),
          installationBin: path.join(root, 'bin'),
          profilesDir: path.join(root, 'profiles'),
          ticketsDir: path.join(root, 'tickets'),
          accessFactoryFixture: true,
        },
      });

      await executable(root, 'factory', 'factory-engine.mjs');
      await executable(root, 'systemd-run', 'factory-systemd.mjs');
      await fs.writeFile(path.join(root, 'bin/systemd.json'), JSON.stringify(systemd));

      const worker = await serverWorker(t, f);
      const boot = await worker('boot', { provider: 'deepseek' });

      assert.equal(boot.ready, true, JSON.stringify(boot));

      const launch = await worker('factory-http-launch');

      assert.equal(launch.result.status, 200, JSON.stringify(launch));
      assert.equal(launch.result.body.outcome, 'launched');
      assert.ok(launch.capture.argv.includes('start'));

      const before = await profiles(f, 'deepseek');
      const second = await addProfile(f, 'deepseek');
      const neighbor = await addProfile(f);

      assert.equal(launch.capture.env.DEEPSEEK_API_KEY, OLD_KEY);
      await activate(f, neighbor);
      await worker('factory-pause');
      assert.equal((await profiles(f, 'deepseek')).switchAllowed, false);
      await activate(f, second, 'deepseek', {}, 409);
      await worker('restart');
      await f.restart();
      await activate(f, second, 'deepseek', {}, 409);

      const resumed = await worker('factory-launch', {
        args: ['7', 'resume', '--profile', 'demo', '--attempt', 'a_0123456789abcdef0123456789abcdef'],
      });

      assert.equal(resumed.capture.env.DEEPSEEK_API_KEY, OLD_KEY);
      assert.equal((await profiles(f, 'deepseek')).activeProfileId, before.activeProfileId);
      await worker('factory-pause');

      const runtime = path.join(root, 'control/protocol-v2/tasks/t7/attempts',
        'a_0123456789abcdef0123456789abcdef/stage-results/runtime.json');

      await fs.chmod(runtime, 0o600);
      await fs.copyFile(path.join(root, 'after.json'), runtime);
      await fs.chmod(runtime, 0o400);
      assert.equal((await profiles(f, 'deepseek')).switchAllowed, true);
      await activate(f, second, 'deepseek');
      assert.equal((await profiles(f, 'deepseek')).activeProfileId, second.id);
    });
  }
});

test('закреплённый доступ выбирает свою копию CLI для каталога скорости', { timeout: 120_000 }, async (t) => {
  const fx = await codexModelFixture(t);
  const root = path.join(fx.root, 'pinned');
  const engine = testFactoryBinary();
  const fixture = await prepareCommandServer(t, root, engine, true);

  await prepareIsolatedCommandWorkspace(fixture);

  const cli = await prepareCliFixture(root, 'codex');
  const vendor = await vendorServer(t);
  const access = await profileFixture(t, {
    root,
    vendor,
    env: { CODEX_HOME: cli.home },
    adapters: [{
      ...codex,
      externalCli: undefined,
      catalog: undefined,
    }],
    config: fixture.config,
  });

  const accessEnv = await access.app.accessProfiles.pinPipeline('codex', '71', null);
  const pinFile = path.join(access.app.accessProfiles.store.directory('codex'), 'pipelines/71.json');
  const pin = await fs.readFile(pinFile);
  const selected = path.join(root, 'selected-codex');
  const trace = path.join(root, 'native.jsonl');
  const selectedMetadata = path.join(root, 'native-models.json');
  const selectedMethods = path.join(root, 'native-methods.jsonl');
  const featureOff = path.join(root, 'features-off');
  const descriptor = path.join(root, 'external-cli.json');
  const leaseDirectory = path.join(root, 'lease');
  const leaseKey = createHash('sha256').update('codex').digest('hex');
  const records = path.join(leaseDirectory, leaseKey, 'records.json');
  const native = structuredClone(fx.native.slice(0, 2));

  native[0].serviceTiers = [{ id: 'priority' }];
  await fs.writeFile(selectedMetadata, JSON.stringify({ data: native, nextCursor: null }));

  const original = await fs.readFile(fx.binary, 'utf8');

  await fs.writeFile(fx.binary, original.replace('fast_mode stable true', 'fast_mode stable false'));
  await fs.writeFile(selected, original
    .replaceAll(JSON.stringify(fx.metadataFile), JSON.stringify(selectedMetadata))
    .replaceAll(JSON.stringify(fx.trace), JSON.stringify(selectedMethods))
    .replace('const fs = require("node:fs");', [
      'const fs = require("node:fs");',
      'const cp = require("node:child_process");',
      'const env = process.env;',
      'const argv = process.argv.slice(2);',
      `const leases = JSON.parse(fs.readFileSync(${JSON.stringify(records)}, "utf8"));`,
      'const reader = leases.some((entry) => entry.mode === "reader");',
      `fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ argv, cwd: process.cwd(),`,
      '  home: env.CODEX_HOME, leaked: !!env.OPENAI_API_KEY, reader }) + "\\n");',
      'if (argv[0] === "exec") {',
      '  cp.execFileSync(env.FACTORY_STATUS_BIN, ["stage-result", "--task", "71",',
      '    "--stage", env.FACTORY_RUN_STAGE, "--run-id", env.FACTORY_RUN_ID,',
      '    "--epoch", env.FACTORY_RUN_EPOCH, "done", "fixture"]);',
      '  process.exit(0);',
      '}',
    ].join('\n'))
    .replace('console.log("fast_mode stable true");', [
      `const ready = ${JSON.stringify([path.join(fx.root, 'state'), fixture.checkout])};`,
      `const enabled = ready.includes(process.cwd()) && !fs.existsSync(${JSON.stringify(featureOff)});`,
      'console.log("fast_mode stable " + enabled);',
    ].join('\n')), { mode: 0o700 });

  const leaseCommand = [process.execPath, path.join(sourceRoot, 'server/scripts/externalCliLease.mts')];
  const selectedIdentity = await executableIdentity(selected);
  const resourceKey = 'b'.repeat(64);
  const entry = {
    executable: selected,
    identity: selectedIdentity,
    leaseDirectory,
    leaseCommand,
    resourceKey,
  };
  const metadataEnv = {
    PATH: fx.env.PATH,
    HOME: root,
    CODEX_HOME: accessEnv.CODEX_HOME,
    GRIGDESK_HOME: fx.env.GRIGDESK_HOME,
  };
  const providers = { codex: entry };
  const scopeFile = await writeStageMetadataScope(fx, providers, metadataEnv, fixture.checkout);
  const speed = ['--speed-v1', '1'];
  const options = ['--provider', 'codex', ...speed];

  await fs.writeFile(descriptor, JSON.stringify({
    schemaVersion: 1,
    providers: { codex: {
      bin: selected,
      identity: selectedIdentity,
      providerId: 'codex',
      resourceKey,
      leaseDirectory,
      leaseCommand,
      env: { CODEX_HOME: accessEnv.CODEX_HOME, OPENAI_API_KEY: 'fixture-secret' },
    } },
  }), { mode: 0o600 });

  const exact = cliJson(fx.cli('options', options));
  const show = cliJson(fx.cli('show', speed));
  const build = cliJson(fx.cli('options', options, 'ship', 'SHIP'));

  assert.deepEqual(exact.models[0].speedModes, ['standard', 'fast']);
  assert.deepEqual(build.models[0].speedModes, exact.models[0].speedModes);
  assert.equal(show.catalogRevision, exact.catalogRevision);

  const saved = cliJson(fx.cli('apply', ['--payload', JSON.stringify({
    identity: exact.identity,
    expectedRevision: exact.revision,
    expectedRun: null,
    catalogRevision: exact.catalogRevision,
    requestId: 'access-scope',
    mode: 'next',
    selection: exact.selection,
  })]));

  assert.equal(saved.selection.primary, null);
  assert.equal(saved.catalogRevision, exact.catalogRevision);
  assert.deepEqual(await fx.methods(), []);

  await writeStageMetadataScope(fx, providers, metadataEnv);

  const noCheckout = cliJson(fx.cli('options', options, 'ship', 'SHIP'));

  assert.deepEqual(noCheckout.models[0].speedModes, ['standard']);
  await fs.writeFile(featureOff, '');

  const noFlags = cliJson(fx.cli('options', options));

  assert.deepEqual(noFlags.models[0].speedModes, ['standard']);
  await fs.unlink(featureOff);

  const scope = JSON.parse(await fs.readFile(scopeFile, 'utf8'));

  scope.attempt = 'a_11111111111111111111111111111111';
  await fs.writeFile(scopeFile, JSON.stringify(scope));

  const foreign = cliJson(fx.cli('options', options));

  assert.deepEqual(foreign.models[0].speedModes, ['standard']);
  assert.deepEqual(foreign.models[0].efforts, exact.models[0].efforts);

  const profile = path.join(fixture.config.profilesDir, 'demo-profile', 'runners.env');
  const ticket = path.join(root, 'ticket.json');

  await fs.writeFile(profile, await fs.readFile(fx.config));
  await fs.writeFile(path.join(root, 'release-command'), '');
  await fs.writeFile(ticket, JSON.stringify({
    schema: 1,
    taskId: '71',
    title: 'Закреплённый доступ',
    description: 'Проверка копии исполняемого файла',
    acceptanceCriteria: ['Офлайн CLI'],
    sourceUrl: 'https://example.test/tasks/71',
  }));

  const paths = [
    '--profile', 'demo-profile', '--routes-dir', fixture.config.routesDir,
    '--control-dir', fixture.config.factoryControlDir, '--state-dir', fixture.config.stateDir,
  ];
  const launchEnv = {
    ...metadataEnv,
    FACTORY_PROFILES_DIR: fixture.config.profilesDir,
    FACTORY_HOME: path.join(sourceRoot, 'engine'),
    FACTORY_EXTERNAL_CLI_DESCRIPTOR: descriptor,
    NODE_BIN: process.execPath,
  };
  const invoke = (...args) => spawnSync(engine, ['71', ...args, ...paths], {
    cwd: root,
    env: launchEnv,
    encoding: 'utf8',
    timeout: 30_000,
  });

  cliJsonResult(invoke('start', '--route', 'command', '--ticket-json', ticket));

  const state = await expectAttempt(fixture.adapter, (value) => value.cursor?.node === 'gate_accept');

  cliJsonResult(invoke('gate', '--attempt', state.attempt, '--node', 'gate_accept', '--decision', 'approved',
    '--commit-only'));
  cliJsonResult(invoke('resume', '--attempt', state.attempt));

  const rows = (await fs.readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const probes = rows.filter((row) => row.argv[0] === 'features');
  const discovery = rows.filter((row) => row.argv[0] === 'app-server');
  const runs = rows.filter((row) => row.argv[0] === 'exec');

  assert.ok(probes.some((row) => row.cwd === path.join(fx.root, 'state')));
  assert.ok(probes.some((row) => row.cwd === fixture.checkout));
  assert.ok(discovery.some((row) => row.cwd === fixture.checkout));
  assert.ok([...probes, ...discovery].every((row) =>
    row.reader && !row.leaked && row.home === accessEnv.CODEX_HOME));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].cwd, fixture.config.stateDir);
  assert.deepEqual(await fs.readFile(pinFile), pin);
});

/**
 * Движок запускается напрямую с временным профилем и фиксированным дескриптором.
 * Сбой сохраняется с исходной диагностикой, включая тайм-аут дочернего процесса.
 */
function cliJsonResult(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
