import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { bashPathBlock } from '../../server/src/lib/providerInstall/bashPath.ts';
import { ProviderInstallService } from '../../server/src/lib/providerInstall/service.ts';
import { isProviderLifecycleSnapshot } from '../../shared/chat/providerLifecycleContracts.ts';

const success = (stdout = '') => ({
  code: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  stdout,
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
  workspaceLimitExceeded: false,
});

/**
 * Сервис работает с тем же изолированным HOME/prefix, что и planner.
 * Настоящие пакеты и настоящий HOME владельца не участвуют.
 */
async function fixture(t) {
  const base = path.join(artifactsPath({ env: process.env, home: os.homedir() }),
    'external-cli-lifecycle/migration-service-tests');

  await fs.mkdir(base, { recursive: true });

  const home = await fs.mkdtemp(path.join(base, 'case-'));
  const data = path.join(home, 'data');
  const prefix = path.join(home, 'user-prefix');
  const runtimeBin = path.join(home, 'runtime/bin');
  const legacy = path.join(data, 'state/npm-global');
  const legacyRoot = path.join(legacy, 'lib/node_modules/@fixture/cli');
  const legacyAlias = path.join(legacy, 'bin/fixture-cli');
  const envPath = path.join(data, '.env');

  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(runtimeBin, { recursive: true });
  await fs.mkdir(path.join(prefix, 'bin'), { recursive: true });
  await fs.mkdir(path.join(prefix, 'lib/node_modules'), { recursive: true });
  await fs.symlink(process.execPath, path.join(runtimeBin, 'node'));
  await fs.writeFile(path.join(runtimeBin, 'npm'), [
    '#!/bin/sh',
    'if [ "$1" = prefix ] && [ "$2" = -g ]; then printf "%s\\n" "$FIXTURE_PREFIX"; exit 0; fi',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  await fs.mkdir(path.join(legacyRoot, '..'), { recursive: true });
  await fs.mkdir(legacyRoot, { recursive: true });
  await fs.mkdir(path.join(legacy, 'bin'), { recursive: true });
  await fs.writeFile(path.join(legacyRoot, 'package.json'), JSON.stringify({
    name: '@fixture/cli',
    version: '1.0.0',
    bin: { 'fixture-cli': 'cli.js' },
  }));
  await fs.writeFile(path.join(legacyRoot, 'cli.js'), '#!/bin/sh\necho fixture\n', { mode: 0o755 });
  await fs.symlink('../lib/node_modules/@fixture/cli/cli.js', legacyAlias);
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(envPath, `FIXTURE_BIN=${legacyAlias}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(home, '.bashrc'), [
    'export KEEP_ME=yes',
    `export PATH="${prefix}/bin:${runtimeBin}:/usr/bin:/bin"`,
    `export FIXTURE_PREFIX="${prefix}"`,
    bashPathBlock([path.join(legacy, 'bin')]).trimEnd(),
    '',
  ].join('\n'));
  await fs.writeFile(path.join(home, '.bash_profile'), 'source "$HOME/.bashrc"\n');

  const config = {
    dataHome: data,
    envPath,
    fixtureBin: legacyAlias,
  };
  const adapter = {
    id: 'fixture',
    name: 'Fixture',
    bin: (value) => value.fixtureBin,
    externalCli: () => ({
      packageId: '@fixture/cli',
      binName: 'fixture-cli',
      configKey: 'fixtureBin',
      envKey: 'FIXTURE_BIN',
    }),
  };
  const events = [];
  const invalidations = [];
  let gate = null;
  let held = 0;

  /**
   * Materialize кладёт fixture-пакет только в изолированный prefix.
   * Сеть и настоящий registry не участвуют.
   */
  async function materialize(target) {
    const root = path.join(target, 'lib/node_modules/@fixture/cli');

    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(path.join(target, 'bin'), { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: '@fixture/cli',
      version: '1.0.0',
      bin: { 'fixture-cli': 'cli.js' },
    }));
    await fs.writeFile(path.join(root, 'cli.js'), '#!/bin/sh\necho fixture\n', { mode: 0o755 });
    await fs.writeFile(path.join(root, 'dependency.js'), 'intact');
    await fs.symlink('../lib/node_modules/@fixture/cli/cli.js', path.join(target, 'bin/fixture-cli'))
      .catch((error) => {
        if (error.code !== 'EEXIST') {
          throw error;
        }
      });
  }

  const service = new ProviderInstallService({
    statePath: path.join(data, 'state.json'),
    config,
    roots: {
      dataHome: data,
      installationRoot: path.join(home, 'I'),
      runtimeRoot: path.join(home, 'R'),
    },
    artifactsDir: path.join(data, 'artifacts'),
    env: {
      HOME: home,
      SHELL: '/bin/bash',
      PATH: '/usr/bin:/bin',
    },
    adaptersOf: async () => new Map([['fixture', adapter]]),
    latestOf: () => '1.0.0',
    refreshModels: async () => {},
    invalidate: async () => {},
    invalidateRuntime: async (...args) => {
      invalidations.push(args);
    },
    broadcast: (snapshot) => {
      events.push(snapshot);
    },
    /**
     * Npm-транспорт пишет только в изолированный prefix и умеет задержать старт.
     * Integrity/probe отвечают fixture-значениями без registry.
     */
    async runCommand(file, args) {
      if (file === path.join(prefix, 'bin/fixture-cli')) {
        return success('fixture 1.0.0');
      }
      if (args[1] === 'view') {
        return success(JSON.stringify('sha512-Zml4dHVyZQ=='));
      }

      const target = args[args.indexOf('--prefix') + 1];

      if (target === prefix) {
        held += 1;
        await gate;
      }
      if (target) {
        await materialize(target);
      }

      return success();
    },
  });
  const inventory = await import('../../server/src/lib/providerInstall/inventory.ts').then((module) =>
    module.discoverExternalCli({
      providerId: 'fixture',
      definition: adapter.externalCli({}, home),
      configuredBin: legacyAlias,
      env: { HOME: home, PATH: `${prefix}/bin:${legacy}/bin:${runtimeBin}:/usr/bin:/bin` },
      home,
      legacyRoots: [legacy],
    }));

  return {
    service,
    adapter,
    home,
    data,
    prefix,
    legacy,
    legacyRoot,
    legacyAlias,
    envPath,
    inventory,
    events,
    invalidations,
    hold: (value) => {
      gate = value;
    },
    held: () => held,
  };
}

test('сервис готовит и выполняет миграцию под общим admission', async (t) => {
  const stand = await fixture(t);
  const prepared = await stand.service.prepareMigration([{
    providerId: 'fixture',
    sourceIds: [stand.inventory.installations[0].installationId],
    targetMethod: 'npm',
    removeIds: [stand.inventory.installations[0].installationId],
  }], true, 'owner');

  assert.equal(prepared.operation, 'migrate');

  let release;

  stand.hold(new Promise((resolve) => {
    release = resolve;
  }));

  const started = await stand.service.startMigration(prepared.token, 'owner');

  assert.equal(isProviderLifecycleSnapshot(started.snapshot), true);
  await assert.rejects(stand.service.start('other', 'install'), { code: 'busy' });

  const v1 = await stand.service.current();

  assert.equal(v1.active, null);
  assert.equal(v1.blockedReason.code, 'maintenance');
  release();

  const result = await started.completion;

  assert.equal(result.ok, true);

  const lifecycle = await stand.service.currentLifecycle();

  assert.equal(lifecycle.recent.fixture.outcome, 'migrated');
  assert.equal(lifecycle.recent.fixture.operation, 'migrate');
  assert.equal((await stand.service.current()).recent.fixture, undefined);
  assert.deepEqual(stand.invalidations, [['fixture', { removed: false }]]);
  assert.equal(await fs.readFile(stand.envPath, 'utf8'),
    `FIXTURE_BIN=${stand.prefix}/bin/fixture-cli\n`);
  assert.equal(await fs.readFile(path.join(stand.home, '.bashrc'), 'utf8').then((text) =>
    text.includes('GrigDesk external CLI PATH')), false);
  assert.equal(await fs.stat(stand.legacyRoot).then(() => true, () => false), false);
});

test('изменение старой копии после preview запрещает старт до mutation', async (t) => {
  const stand = await fixture(t);
  const prepared = await stand.service.prepareMigration([{
    providerId: 'fixture',
    sourceIds: [stand.inventory.installations[0].installationId],
    targetMethod: 'npm',
    removeIds: [stand.inventory.installations[0].installationId],
  }], true, 'owner');
  const heldBefore = stand.held();

  await fs.writeFile(path.join(stand.legacyRoot, 'dependency.js'), 'changed');
  await assert.rejects(stand.service.startMigration(prepared.token, 'owner'),
    { code: 'preparation_changed' });
  assert.equal(stand.held(), heldBefore);
  assert.equal(await fs.readFile(stand.envPath, 'utf8'),
    `FIXTURE_BIN=${stand.legacyAlias}\n`);
});
