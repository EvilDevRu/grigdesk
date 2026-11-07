import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { bashPathBlock } from '../../server/src/lib/providerInstall/bashPath.ts';
import { discoverExternalCli } from '../../server/src/lib/providerInstall/inventory.ts';
import {
  executeMigration, prepareMigrationPlan, revalidateMigration,
} from '../../server/src/lib/providerInstall/migration.ts';

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
 * Fixture содержит только изолированные HOME/prefix/legacy-каталоги.
 * Настоящие Bash и npm-границы не покидают тему артефактов.
 */
async function fixture(t) {
  const base = path.join(artifactsPath({ env: process.env, home: os.homedir() }),
    'external-cli-lifecycle/migration-tests');

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
  await fs.mkdir(legacyRoot, { recursive: true });
  await fs.mkdir(path.join(legacy, 'bin'), { recursive: true });
  await fs.writeFile(path.join(legacyRoot, 'package.json'), JSON.stringify({
    name: '@fixture/cli',
    version: '1.0.0',
    bin: { 'fixture-cli': 'cli.js' },
  }));
  await fs.writeFile(path.join(legacyRoot, 'cli.js'), '#!/bin/sh\necho fixture\n', { mode: 0o755 });
  await fs.symlink('../lib/node_modules/@fixture/cli/cli.js', legacyAlias);
  await fs.writeFile(path.join(home, '.fixture-data'), 'keep-me');
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(path.join(data, 'auth.json'), 'canary');
  await fs.writeFile(envPath, `FIXTURE_BIN=${legacyAlias}\n`, { mode: 0o600 });

  const rc = [
    'export USER_LINE=kept',
    `export PATH="${prefix}/bin:${runtimeBin}:/usr/bin:/bin"`,
    `export FIXTURE_PREFIX="${prefix}"`,
    bashPathBlock([path.join(legacy, 'bin')]).trimEnd(),
    '',
  ].join('\n');

  await fs.writeFile(path.join(home, '.bashrc'), rc);
  await fs.writeFile(path.join(home, '.bash_profile'), 'source "$HOME/.bashrc"\n');

  const config = { envPath, fixtureBin: legacyAlias };
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

  /**
   * Materialize кладёт только fixture-пакет в выбранный prefix.
   * Никаких файлов вне temporary HOME не создаётся.
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

  const input = {
    adapters: new Map([['fixture', adapter]]),
    config,
    env: {
      HOME: home,
      SHELL: '/bin/bash',
      PATH: '/usr/bin:/bin',
    },
    envPath,
    home,
    roots: {
      dataHome: data,
      installationRoot: path.join(home, 'I'),
      runtimeRoot: path.join(home, 'R'),
    },
    scratch: path.join(data, 'artifacts/provider-install-probes'),
    cleanupOwnedShell: true,
    scope: 'owner',
    ttl: 60_000,
    /**
     * Транспорт имитирует npm только внутри temporary prefix.
     * Probe и integrity не выходят к настоящему registry.
     */
    async run(_file, args) {
      if (args[0] === '--version') {
        return success('fixture 1.0.0');
      }
      if (args[1] === 'view') {
        return success(JSON.stringify('sha512-Zml4dHVyZQ=='));
      }

      const target = args.includes('--prefix') ? args[args.indexOf('--prefix') + 1] : '';

      if (target) {
        await materialize(target);
      }

      return success();
    },
  };

  return {
    input,
    home,
    data,
    prefix,
    legacy,
    legacyRoot,
    legacyAlias,
    envPath,
    adapter,
    rc,
  };
}

const entryFor = (installationId) => ({
  providerId: 'fixture',
  sourceIds: [installationId],
  targetMethod: 'npm',
  removeIds: [installationId],
});

/**
 * Inventory нужен тесту только для identity старой копии.
 * Повторного обхода HOME нет: используется тот же discovery, что и сервис.
 */
async function inventoryOf(stand) {
  const inventory = await discoverExternalCli({
    providerId: 'fixture',
    definition: stand.adapter.externalCli({}, stand.home),
    configuredBin: stand.legacyAlias,
    env: {
      HOME: stand.home,
      PATH: `${stand.prefix}/bin:${stand.legacy}/bin:/usr/bin:/bin`,
    },
    home: stand.home,
    legacyRoots: [stand.legacy],
  });

  return inventory.installations[0];
}

test('preview показывает legacy-копию, rc-блок и ничего не меняет', async (t) => {
  const stand = await fixture(t);
  const inventory = await inventoryOf(stand);
  const plan = await prepareMigrationPlan({
    ...stand.input,
    entries: [entryFor(inventory.installationId)],
  });

  assert.equal(plan.preview.operation, 'migrate');
  assert.deepEqual(plan.preview.affectedProviderIds, ['fixture']);
  assert.equal(plan.preview.targets[0].targetVersion, '1.0.0');
  assert.equal(plan.preview.targets[0].footprint.some((item) =>
    item.path === stand.legacyRoot), true);
  assert.equal(plan.preview.shellChanges.length, 1);
  assert.equal(plan.preview.shellChanges[0].file, path.join(stand.home, '.bashrc'));
  assert.equal(await fs.readFile(path.join(stand.legacyRoot, 'cli.js'), 'utf8'),
    '#!/bin/sh\necho fixture\n');
  assert.equal(await fs.readFile(stand.envPath, 'utf8'), `FIXTURE_BIN=${stand.legacyAlias}\n`);
});

test('старт переносит копию, снимает rc-блок и сохраняет canary', async (t) => {
  const stand = await fixture(t);
  const inventory = await inventoryOf(stand);
  const plan = await prepareMigrationPlan({
    ...stand.input,
    entries: [entryFor(inventory.installationId)],
  });

  await revalidateMigration(plan);

  const result = await executeMigration(plan, { phase: async () => {} });
  const rc = await fs.readFile(path.join(stand.home, '.bashrc'), 'utf8');

  assert.equal(result.outcome, 'migrated');
  assert.equal(await fs.readFile(path.join(stand.prefix, 'lib/node_modules/@fixture/cli/package.json'))
    .then((text) => JSON.parse(text).version), '1.0.0');
  assert.equal(await fs.stat(stand.legacyRoot).then(() => true, () => false), false);
  assert.equal(await fs.stat(stand.legacyAlias).then(() => true, () => false), false);
  assert.equal(rc.includes('GrigDesk external CLI PATH'), false);
  assert.equal(rc.includes('USER_LINE=kept'), true);
  assert.equal(await fs.readFile(stand.envPath, 'utf8'),
    `FIXTURE_BIN=${stand.prefix}/bin/fixture-cli\n`);
  assert.equal(await fs.readFile(path.join(stand.home, '.fixture-data'), 'utf8'), 'keep-me');
  assert.equal(await fs.readFile(path.join(stand.data, 'auth.json'), 'utf8'), 'canary');
});

test('второй CLI в общем блоке требует включения в тот же перенос', async (t) => {
  const stand = await fixture(t);
  const inventory = await inventoryOf(stand);
  const extra = {
    id: 'other',
    name: 'Other',
    bin: () => '',
    externalCli: () => ({
      packageId: '@fixture/other',
      binName: 'other-cli',
      configKey: 'otherBin',
      envKey: 'OTHER_BIN',
    }),
  };

  await fs.writeFile(path.join(stand.legacy, 'bin/other-cli'),
    '#!/bin/sh\necho other\n', { mode: 0o755 });
  stand.input.adapters.set('other', extra);

  await assert.rejects(prepareMigrationPlan({
    ...stand.input,
    entries: [entryFor(inventory.installationId)],
  }), { code: 'migration_block_dependency' });
});

test('сбой терминала откатывает rc и не удаляет старую копию', async (t) => {
  const stand = await fixture(t);

  await fs.writeFile(path.join(stand.home, '.bashrc'), [
    'export USER_LINE=kept',
    `export PATH="${stand.home}/runtime/bin:/usr/bin:/bin"`,
    `export FIXTURE_PREFIX="${stand.prefix}"`,
    bashPathBlock([path.join(stand.legacy, 'bin')]).trimEnd(),
    '',
  ].join('\n'));

  const inventory = await inventoryOf(stand);
  const plan = await prepareMigrationPlan({
    ...stand.input,
    entries: [entryFor(inventory.installationId)],
  });
  const before = await fs.readFile(path.join(stand.home, '.bashrc'), 'utf8');

  await revalidateMigration(plan);
  await assert.rejects(executeMigration(plan, { phase: async () => {} }),
    { code: 'terminal_conflict' });

  assert.equal(await fs.readFile(path.join(stand.home, '.bashrc'), 'utf8'), before);
  assert.equal(await fs.stat(stand.legacyRoot).then(() => true, () => false), true);
  assert.equal(await fs.readFile(stand.envPath, 'utf8'), `FIXTURE_BIN=${stand.legacyAlias}\n`);
});

test('уборка не удаляет чужой пакет, появившийся после preview', async (t) => {
  const stand = await fixture(t);
  const inventory = await inventoryOf(stand);
  const plan = await prepareMigrationPlan({
    ...stand.input,
    entries: [entryFor(inventory.installationId)],
  });

  await revalidateMigration(plan);

  const result = await executeMigration(plan, {
    phase: async (phase) => {
      if (phase === 'cleanup') {
        await fs.writeFile(path.join(stand.legacyRoot, 'package.json'), JSON.stringify({
          name: '@fixture/other',
          version: '9.9.9',
        }));
      }
    },
  });

  assert.equal(result.outcome, 'activated_with_cleanup_pending');
  assert.equal(await fs.stat(stand.legacyRoot).then(() => true, () => false), true);
  assert.equal(await fs.readFile(path.join(stand.legacyRoot, 'package.json'), 'utf8')
    .then((text) => JSON.parse(text).name), '@fixture/other');
  assert.equal(await fs.readFile(stand.envPath, 'utf8'),
    `FIXTURE_BIN=${stand.prefix}/bin/fixture-cli\n`);
});
