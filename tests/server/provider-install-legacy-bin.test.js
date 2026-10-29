import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  backupLegacyLink,
  completeMigration,
  createMigrationJournal,
  inspectBinTarget,
  inspectReplacement,
  restoreLegacyLink,
} from '../../server/src/lib/providerInstall/legacyBinMigration.ts';

/**
 * Пакет доказывается package.json и расположением внутри выбранного корня.
 * D-копия и внешний prefix — два разных провайдера, как в настоящем случае.
 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join('/tmp', 'provider-legacy-bin-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const prefix = path.join(home, '.local');

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(prefix, 'bin'), { recursive: true });
  await fs.mkdir(path.join(data, 'state', 'npm-global', 'bin'), { recursive: true });

  /**
   * Пакет-фикстура доказывает имя через package.json и расположение в своём корне.
   * Версия и содержимое bin не участвуют в классификации цели.
   */
  const pack = async (base, packageId, binName) => {
    const packageRoot = path.join(base, 'lib', 'node_modules', ...packageId.split('/'));

    await fs.mkdir(path.join(packageRoot, 'bin'), { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: packageId, version: '1.0.0' }));
    await fs.writeFile(path.join(packageRoot, 'bin', 'cli.js'), '#!/usr/bin/env node\n');

    return path.join(packageRoot, 'bin', 'cli.js');
  };
  const externalBin = await pack(prefix, '@scope/cli', 'cli');
  const legacyBin = await pack(path.join(data, 'state', 'npm-global'), '@scope/cli', 'cli');
  const foreignBin = await pack(prefix, '@scope/other', 'other');

  return {
    root,
    home,
    data,
    prefix,
    externalBin,
    legacyBin,
    foreignBin,
    roots: {
      dataHome: data,
      installationRoot: path.join(root, 'installation'),
      runtimeRoot: path.join(root, 'runtime'),
    },
  };
}

const inspection = (stand, overrides = {}) => inspectBinTarget({
  target: path.join(stand.prefix, 'bin', 'cli'),
  prefix: stand.prefix,
  roots: stand.roots,
  packageId: '@scope/cli',
  binName: 'cli',
  oldBin: null,
  ...overrides,
});

test('цель установки классифицируется по пакету, а не по имени пути', async (t) => {
  const stand = await fixture(t);
  const target = path.join(stand.prefix, 'bin', 'cli');

  assert.equal((await inspection(stand)).status, 'free');

  await fs.symlink(stand.externalBin, target);
  assert.equal((await inspection(stand)).status, 'mine');

  await fs.rm(target);
  await fs.symlink(stand.legacyBin, target);

  const legacy = await inspection(stand);

  assert.equal(legacy.status, 'legacy');
  assert.equal(legacy.realpath, stand.legacyBin);
  assert.equal(legacy.packageName, '@scope/cli');

  await fs.rm(target);
  await fs.symlink(stand.foreignBin, target);
  assert.equal((await inspection(stand)).status, 'conflict');

  await fs.rm(target);
  await fs.writeFile(target, '#!/bin/sh\n');
  assert.equal((await inspection(stand)).status, 'conflict');

  await fs.rm(target);
  await fs.symlink(path.join(stand.root, 'missing'), target);
  assert.equal((await inspection(stand)).status, 'conflict');
});

test('журнал создаётся только для доказанной legacy-ссылки', async (t) => {
  const stand = await fixture(t);
  const target = path.join(stand.prefix, 'bin', 'cli');

  await fs.symlink(stand.legacyBin, target);

  const plan = createMigrationJournal({
    jobId: 'job-1',
    target,
    inspection: await inspection(stand),
    packageId: '@scope/cli',
    binName: 'cli',
    configKey: 'cliBin',
    oldBin: stand.legacyBin,
  });

  assert.ok(plan);
  assert.equal(plan.phase, 'planned');
  assert.equal(path.dirname(plan.backup), path.dirname(target));
  assert.equal(plan.backup.startsWith(path.join(stand.prefix, 'bin', '.cli.grigdesk-backup-')), true);

  assert.equal(createMigrationJournal({
    jobId: 'job-2',
    target,
    inspection: await inspection(stand, { packageId: '@scope/other' }),
    packageId: '@scope/other',
    binName: 'cli',
    configKey: 'cliBin',
    oldBin: '',
  }), null);
});

test('резервная копия и восстановление сохраняют прежнюю ссылку', async (t) => {
  const stand = await fixture(t);
  const target = path.join(stand.prefix, 'bin', 'cli');

  await fs.symlink(stand.legacyBin, target);

  const planned = createMigrationJournal({
    jobId: 'job-1',
    target,
    inspection: await inspection(stand),
    packageId: '@scope/cli',
    binName: 'cli',
    configKey: 'cliBin',
    oldBin: stand.legacyBin,
  });
  const backed = await backupLegacyLink(planned);

  assert.equal(backed.phase, 'backed-up');
  await assert.rejects(fs.access(target), { code: 'ENOENT' });
  assert.equal(await fs.readlink(backed.backup), stand.legacyBin);

  assert.equal(await restoreLegacyLink(backed), 'restored');
  assert.equal(await fs.readlink(target), stand.legacyBin);
  await assert.rejects(fs.access(backed.backup), { code: 'ENOENT' });
});

test('неизвестный объект на месте цели блокирует восстановление', async (t) => {
  const stand = await fixture(t);
  const target = path.join(stand.prefix, 'bin', 'cli');

  await fs.symlink(stand.legacyBin, target);

  const planned = createMigrationJournal({
    jobId: 'job-1',
    target,
    inspection: await inspection(stand),
    packageId: '@scope/cli',
    binName: 'cli',
    configKey: 'cliBin',
    oldBin: stand.legacyBin,
  });
  const backed = await backupLegacyLink(planned);

  await fs.writeFile(target, 'чужое\n');

  assert.equal(await restoreLegacyLink(backed), 'blocked');
  assert.equal(await fs.readFile(target, 'utf8'), 'чужое\n');
  assert.equal(await fs.readlink(backed.backup), stand.legacyBin);
});

test('замена, созданная этой операцией, распознаётся и не блокирует восстановление', async (t) => {
  const stand = await fixture(t);
  const target = path.join(stand.prefix, 'bin', 'cli');

  await fs.symlink(stand.legacyBin, target);

  const planned = createMigrationJournal({
    jobId: 'job-1',
    target,
    inspection: await inspection(stand),
    packageId: '@scope/cli',
    binName: 'cli',
    configKey: 'cliBin',
    oldBin: stand.legacyBin,
  });
  const backed = await backupLegacyLink(planned);

  await fs.symlink(stand.externalBin, target);

  const replaced = await inspectReplacement(backed);

  assert.equal(replaced.phase, 'replaced');
  assert.equal(replaced.replacement?.realpath, stand.externalBin);
  assert.equal(await restoreLegacyLink(replaced), 'restored');
  assert.equal(await fs.readlink(target), stand.legacyBin);
});

test('исходная ссылка, изменившаяся после подготовки, не переносится', async (t) => {
  const stand = await fixture(t);
  const target = path.join(stand.prefix, 'bin', 'cli');

  await fs.symlink(stand.legacyBin, target);

  const planned = createMigrationJournal({
    jobId: 'job-1',
    target,
    inspection: await inspection(stand),
    packageId: '@scope/cli',
    binName: 'cli',
    configKey: 'cliBin',
    oldBin: stand.legacyBin,
  });

  await fs.rm(target);
  await fs.symlink(stand.foreignBin, target);

  await assert.rejects(backupLegacyLink(planned), { code: 'migration_recovery_required' });
  assert.equal(await fs.readlink(target), stand.foreignBin);
});

test('после commit резервная копия удаляется', async (t) => {
  const stand = await fixture(t);
  const target = path.join(stand.prefix, 'bin', 'cli');

  await fs.symlink(stand.legacyBin, target);

  const planned = createMigrationJournal({
    jobId: 'job-1',
    target,
    inspection: await inspection(stand),
    packageId: '@scope/cli',
    binName: 'cli',
    configKey: 'cliBin',
    oldBin: stand.legacyBin,
  });
  const backed = await backupLegacyLink(planned);

  await fs.symlink(stand.externalBin, target);
  await completeMigration(backed);

  await assert.rejects(fs.access(backed.backup), { code: 'ENOENT' });
  assert.equal(await fs.readlink(target), stand.externalBin);
});

/**
 * Служебный путь `HOME/.local` проверяется целиком через публичные prepare/start:
 * доказанная legacy-ссылка резервируется, npm ставит новую копию, .env её подключает.
 */
async function migrationServiceFixture(t, options = {}) {
  const { installNpmFixture, prepare, startWithToken, completed } = await import(
    './helpers/providerInstallFixture.js');
  const fixture = await installNpmFixture(t, {
    installed: true,
    before: '2.0.0',
    prefixInHome: true,
    linkBin: true,
    ...options,
  });
  const dataPackage = path.join(fixture.root, '.grigdesk', 'state', 'npm-global', 'lib',
    'node_modules', '@fixture', 'cli');
  const oldBin = path.join(dataPackage, 'bin', 'cli.js');
  const target = path.join(fixture.root, '.local', 'bin', 'fixture-cli');

  await fs.mkdir(path.dirname(oldBin), { recursive: true });
  await fs.writeFile(path.join(dataPackage, 'package.json'),
    JSON.stringify({ name: '@fixture/cli', version: '2.0.0' }));
  await fs.writeFile(oldBin, `#!${process.execPath}\nconsole.log('2.0.0');\n`, { mode: 0o755 });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.symlink(oldBin, target);
  fixture.config.claudeBin = oldBin;
  fixture.env.GRIGDESK_CLAUDE_BIN = oldBin;

  return {
    ...fixture,
    oldBin,
    target,
    prepare,
    startWithToken,
    completed,
    newEntry: path.join(fixture.prefix, 'lib', 'node_modules', '@fixture', 'cli', 'bin', 'cli.js'),
    startTokenless: (id, operation) => fixture.app.inject({
      method: 'POST',
      url: `/api/providers/${id}/${operation}/start`,
      payload: {},
    }),
  };
}

test('legacy-ссылка при P=HOME/.local переносится и подключает новую копию', async (t) => {
  const stand = await migrationServiceFixture(t);
  const preparation = (await stand.prepare(stand.app, 'claude', 'update')).json();

  assert.equal(preparation.prefix, path.join(stand.root, '.local'));

  const started = await stand.startWithToken(stand.app, preparation.token, 'claude', 'update');

  assert.equal(started.statusCode, 202, started.body);
  stand.gate.resolve();

  const job = (await stand.completed(stand.app)).recent.claude;

  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  assert.equal(job.outcome, 'current');
  assert.deepEqual(job.migration, { from: stand.oldBin, to: stand.npmBinary });
  assert.equal(await fs.readlink(stand.target), stand.newEntry);
  assert.equal(stand.config.claudeBin, stand.npmBinary);
  assert.equal((await fs.stat(stand.oldBin)).isFile(), true, 'старая D-копия удалена');

  const backups = (await fs.readdir(path.dirname(stand.target)))
    .filter((name) => name.includes('grigdesk-backup'));

  assert.deepEqual(backups, []);
});

test('отказ npm до commit возвращает прежнюю ссылку и привязку', async (t) => {
  const stand = await migrationServiceFixture(t, {
    runner: async (bin, args, options) => {
      await options.ownership?.started?.({
        commandId: 'fixture-worker',
        supervisorPid: process.pid,
        supervisorStartTime: '1',
        pid: process.pid,
        pgid: process.pid,
        startTime: '1',
      });
      await options.ownership?.finished?.('fixture-worker').catch(() => {});
      stand.gate.resolve();

      return {
        code: 1,
        signal: null,
        timedOut: false,
        aborted: false,
        stdout: '',
        stderr: 'npm сломался',
        stdoutTruncated: false,
        stderrTruncated: false,
        workspaceLimitExceeded: false,
      };
    },
  });
  const preparation = (await stand.prepare(stand.app, 'claude', 'update')).json();

  stand.gate.resolve();

  const started = await stand.startWithToken(stand.app, preparation.token, 'claude', 'update');

  assert.equal(started.statusCode, 202, started.body);

  const job = (await stand.completed(stand.app)).recent.claude;

  assert.equal(job.status, 'failed');
  assert.equal(await fs.readlink(stand.target), stand.oldBin, 'прежняя ссылка не восстановлена');
  assert.equal(stand.config.claudeBin, stand.oldBin);
});

test('неизвестный объект вместо ссылки блокирует новые установки', async (t) => {
  const stand = await migrationServiceFixture(t, {
    runner: async () => {
      await fs.writeFile(stand.target, 'чужой файл\n');
      stand.gate.resolve();

      return {
        code: 1,
        signal: null,
        timedOut: false,
        aborted: false,
        stdout: '',
        stderr: 'npm сломался',
        stdoutTruncated: false,
        stderrTruncated: false,
        workspaceLimitExceeded: false,
      };
    },
  });
  const preparation = (await stand.prepare(stand.app, 'claude', 'update')).json();

  stand.gate.resolve();

  await stand.startWithToken(stand.app, preparation.token, 'claude', 'update');

  const snapshot = await stand.completed(stand.app);

  assert.equal(snapshot.recent.claude.status, 'failed');
  assert.equal(snapshot.blockedReason?.code, 'migration_recovery_required');
  assert.equal(await fs.readFile(stand.target, 'utf8'), 'чужой файл\n');

  const second = await stand.startTokenless('claude', 'update');

  assert.equal(second.statusCode, 409, second.body);
  assert.equal(second.json().error, 'migration_recovery_required');
});

/**
 * Журнал переживает перезапуск: фактический `.env` решает, возвращать ли ссылку.
 * Неизвестный объект на месте цели оставляет копию и блокирует новые установки.
 */
async function crashState(stand, phase = 'backed-up') {
  const backup = path.join(path.dirname(stand.target), '.fixture-cli.grigdesk-backup-crash');
  const held = await fs.lstat(backup).catch(() => null);

  if (!held) {
    await fs.rename(stand.target, backup);
  }

  const stat = await fs.lstat(backup);
  const state = {
    revision: 1,
    active: null,
    recent: {},
    blockedReason: null,
    worker: null,
    migration: {
      jobId: 'job-crash',
      target: stand.target,
      backup,
      packageId: '@fixture/cli',
      binName: 'fixture-cli',
      configKey: 'claudeBin',
      oldBin: stand.oldBin,
      originalLink: stand.oldBin,
      originalRealpath: await fs.realpath(backup),
      identity: { dev: stat.dev, ino: stat.ino },
      phase,
      replacement: null,
    },
  };

  await fs.mkdir(path.dirname(stand.config.providerInstallStatePath), { recursive: true });
  await fs.writeFile(stand.config.providerInstallStatePath, JSON.stringify(state));

  return { backup, state };
}

test('перезапуск до commit восстанавливает прежнюю ссылку', async (t) => {
  const stand = await migrationServiceFixture(t);
  const { state } = await crashState(stand);

  await fs.rm(stand.target, { force: true });

  const snapshot = await stand.app.inject('/api/providers/installations/current').then(
    (response) => response.json());

  assert.equal(snapshot.blockedReason, null);
  assert.equal(await fs.readlink(stand.target), stand.oldBin);
  assert.equal(JSON.parse(await fs.readFile(stand.config.providerInstallStatePath, 'utf8'))
    .migration, null);
  assert.ok(state);
});

test('перезапуск после commit не возвращает старую ссылку', async (t) => {
  const stand = await migrationServiceFixture(t);
  const { backup } = await crashState(stand, 'replaced');

  stand.config.claudeBin = stand.npmBinary;

  const snapshot = await stand.app.inject('/api/providers/installations/current').then(
    (response) => response.json());

  assert.equal(snapshot.blockedReason, null);
  await assert.rejects(fs.access(backup), { code: 'ENOENT' });
  await assert.rejects(fs.access(stand.target), { code: 'ENOENT' });
  assert.equal(JSON.parse(await fs.readFile(stand.config.providerInstallStatePath, 'utf8'))
    .migration, null);
});

test('неоднозначное восстановление блокирует новые установки', async (t) => {
  const stand = await migrationServiceFixture(t);
  const { backup } = await crashState(stand);

  await fs.writeFile(stand.target, 'чужой файл\n');

  const snapshot = await stand.app.inject('/api/providers/installations/current').then(
    (response) => response.json());

  assert.equal(snapshot.blockedReason.code, 'migration_recovery_required');
  assert.equal(await fs.readFile(stand.target, 'utf8'), 'чужой файл\n');
  assert.equal((await fs.lstat(backup)).isSymbolicLink(), true);
});
