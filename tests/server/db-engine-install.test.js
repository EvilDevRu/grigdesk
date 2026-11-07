import assert from 'node:assert/strict';

import { randomUUID } from 'node:crypto';

import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import os from 'node:os';

import path from 'node:path';

import test from 'node:test';

import { PluginInstallService } from '../../server/src/lib/packageInstall/service.ts';

import { computePayloadDigest } from '../../server/src/lib/packageInstall/payloadDigest.ts';

import { createPluginRepo, git } from './helpers/pluginRepo.js';

import { adapterSource } from './helpers/dbEngineFixture.js';

import { commandSuccess } from './helpers/pluginServiceFixture.js';

/**
 * Оба рода сервиса используют общий временный home с разными roots/state/owner.
 * Подменяется только npm boundary, Git/validator/apply/resolver остаются настоящими.
 */
async function installers(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-driver-install-'));

  const services = [];

  t.after(async () => {
    for (const service of services) {
      await service.close();
    }

    await rm(root, { recursive: true, force: true });
  });

  /**
   * Один policy preset получает отдельные state и owner внутри общего home.
   * Одинаковый внешний id не связывает два установщика.
   */
  const make = async (packageKind) => {
    const pluginsDir = path.join(root, packageKind === 'db-engine' ? 'db-engines' : 'plugins');

    const statePath = path.join(root, 'state', `${packageKind}-installs.json`);

    await mkdir(pluginsDir, { recursive: true });

    const service = new PluginInstallService({
      packageKind,
      pluginsDir,
      statePath,
      grigDeskVersion: '1.0.0',
      reservedIds: ['mysql'],
      runNpm: async (cwd) => {
        await mkdir(path.join(cwd, 'node_modules'), { recursive: true });

        await writeFile(path.join(cwd, 'node_modules/fixture.txt'), 'offline dependencies');

        return commandSuccess;
      },
      ...options,
    });

    services.push(service);

    service.bindRuntime({
      isLoaded: () => false,
      prepareReplace: async () => ({ finish: async () => { } }),
      refresh: async () => { },
    });

    await service.recover();

    return {
      service,
      pluginsDir,
      statePath
    };
  };

  return {
    root,
    driver: await make('db-engine'),
    plugin: await make('plugin'),
    services
  };
}

/**
 * Ready должен получиться через настоящий Git и production package policy.
 * Утверждение на status делает отсутствие поддержки рода поведенческим RED.
 */
async function prepare(service, url, version = '1.0.0') {
  await service.startInstall({ url, version });

  await service.whenIdle();

  const job = await service.currentJob();

  assert.equal(job.status, 'ready', JSON.stringify(job.error));

  return job;
}

/**
 * Fixture marker должен отсутствовать на всех этапах installer до ручного boot.
 * Сам entry имеет восемь методов, но установщик не вправе исполнять его для проверки.
 */
async function driverRepo(t, marker, id = 'fixture-db', files = {}) {
  const repo = await createPluginRepo(t, {
    id,
    packageKind: 'db-engine',
    name: 'Драйвер'
  });

  const prefix = `import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(marker)}, 'imported');`;

  const source = adapterSource(id, prefix);

  await repo.release('1.0.0', {
    files: {
      'entry.mjs': source,
      'payload.txt': 'one',
      ...files
    }
  });

  return { ...repo, source };
}

test('DPI-01: ready/token/apply/replay не исполняют код и требуют ручной restart', async (t) => {
  const { root, driver } = await installers(t);

  const marker = path.join(root, 'imported');

  const repo = await driverRepo(t, marker);

  const target = path.join(driver.pluginsDir, 'fixture-db');

  const ready = await prepare(driver.service, repo.url);

  assert.equal(await lstat(target).catch(() => null), null);

  assert.equal(await lstat(marker).catch(() => null), null);

  assert.equal(ready.preview.name, 'Драйвер');

  assert.equal(ready.preview.source.kind, 'git');

  assert.match(ready.preview.target.sha, /^[a-f0-9]{40}$/u);

  assert.match(ready.preview.warnings.join(' '), /парол|SSH|сеть|network/iu);

  assert.match(ready.preview.warnings.join(' '), /неизвест|непровер|unknown/iu);

  await assert.rejects(driver.service.apply(ready.id, 'f'.repeat(64)), { code: 'preview_stale' });

  assert.equal(await lstat(target).catch(() => null), null);

  const done = await driver.service.apply(ready.id, ready.reviewToken);

  const bytes = await readFile(driver.statePath, 'utf8');

  assert.equal(done.status, 'done');

  assert.equal(driver.service.restartRequired('fixture-db'), true);

  assert.equal(JSON.parse(await readFile(path.join(target, 'engine.json'))).kind, 'db-engine');

  assert.equal(await lstat(path.join(target, 'plugin.json')).catch(() => null), null);

  assert.equal(await lstat(marker).catch(() => null), null);

  assert.deepEqual(await driver.service.apply(ready.id, ready.reviewToken), done);

  assert.equal(await readFile(driver.statePath, 'utf8'), bytes);
});

test('DPI-01-stale: изменение candidate после ready запрещает публикацию', async (t) => {
  const { root, driver } = await installers(t);

  const repo = await driverRepo(t, path.join(root, 'imported'));

  const ready = await prepare(driver.service, repo.url);

  const candidate = path.join(driver.service.workDir, 'jobs', ready.id, 'package');

  await writeFile(path.join(candidate, 'entry.mjs'), '// изменён после review\n');

  await assert.rejects(driver.service.apply(ready.id, ready.reviewToken), { code: 'preview_stale' });

  assert.equal(await lstat(path.join(driver.pluginsDir, 'fixture-db')).catch(() => null), null);
});

test('DPI-02: v1/v2/rollback возвращают source/SHA/deps и durable receipt без повтора', async (t) => {
  const { root, driver } = await installers(t);

  const repo = await driverRepo(t, path.join(root, 'imported'), 'fixture-db', {
    'package.json': '{"name":"fixture-deps","version":"1.0.0"}',
    'package-lock.json': '{"lockfileVersion":3,"packages":{"":{}}}',
  });

  const first = await prepare(driver.service, repo.url);

  await driver.service.apply(first.id, first.reviewToken);

  const v1 = (await driver.service.store.read()).plugins['fixture-db'];

  await repo.release('2.0.0', { files: {
    'entry.mjs': repo.source + '\n// Версия 2\n',
    'payload.txt': 'two',
  } });

  await driver.service.startUpdate('fixture-db', { version: '2.0.0' });

  await driver.service.whenIdle();

  const update = await driver.service.currentJob();

  assert.equal(update.status, 'ready', JSON.stringify(update.error));

  assert.ok(update.preview.changes.sensitive.includes('engine.json'));

  assert.ok(update.preview.changes.sensitive.includes('entry.mjs'));

  assert.deepEqual(v1.npmDirs, ['.']);

  assert.equal(await readFile(path.join(driver.pluginsDir, 'fixture-db/payload.txt'), 'utf8'), 'one');

  await driver.service.apply(update.id, update.reviewToken);

  const current = (await driver.service.store.read()).plugins['fixture-db'];

  const input = {
    requestId: randomUUID(),
    expectedRevision: current.revision,
    expectedPreviousDigest: current.previous.payloadDigest,
  };

  const rolled = await driver.service.rollback('fixture-db', input);

  const restored = (await driver.service.store.read()).plugins['fixture-db'];

  assert.equal(rolled.status, 'done');

  for (const key of ['source', 'sha', 'version', 'tag', 'npmDirs', 'payloadDigest']) {
    assert.deepEqual(restored[key], v1[key], key);
  }

  const bytes = await readFile(driver.statePath, 'utf8');

  assert.deepEqual(await driver.service.rollback('fixture-db', input), rolled);

  assert.equal(await readFile(driver.statePath, 'utf8'), bytes);

  const restoredDigest = await computePayloadDigest(path.join(driver.pluginsDir, 'fixture-db'), v1.npmDirs);

  assert.equal(restoredDigest, v1.payloadDigest);
});

test('DPI-03: одинаковый id plugin/driver изолирует state/job/lock и reload describe', async (t) => {
  const { root, driver, plugin, services } = await installers(t);

  const repo = await driverRepo(t, path.join(root, 'imported'));

  const pluginRepo = await createPluginRepo(t, { id: 'fixture-db' });

  await pluginRepo.release('1.0.0');

  const pluginReady = await prepare(plugin.service, pluginRepo.url);

  await plugin.service.apply(pluginReady.id, pluginReady.reviewToken);

  const pluginState = await readFile(plugin.statePath, 'utf8');

  const ready = await prepare(driver.service, repo.url);

  assert.notEqual(ready.id, pluginReady.id);

  assert.notEqual(driver.service.workDir, plugin.service.workDir);

  await driver.service.apply(ready.id, ready.reviewToken);

  assert.equal(await readFile(plugin.statePath, 'utf8'), pluginState);

  await driver.service.close();

  const reloaded = new PluginInstallService({
    packageKind: 'db-engine',
    pluginsDir: driver.pluginsDir,
    statePath: driver.statePath,
    grigDeskVersion: '1.0.0',
    reservedIds: ['mysql'],
  });

  services.push(reloaded);

  await reloaded.recover();

  assert.equal((await reloaded.describe('fixture-db')).version, '1.0.0');

  assert.equal((await plugin.service.describe('fixture-db')).version, '1.0.0');
});

for (const failure of ['moved-sha', 'npm-reject', 'npm-offline', 'cancel', 'reserved']) {
  test(`DPI-04: ${failure} не публикует target`, async (t) => {
    const { root, driver } = await installers(t, {
      runNpm: async () => ({
        ...commandSuccess,
        code: 1,
        stderr: 'offline fixture'
      }),
    });

    const id = failure === 'reserved' ? 'mysql' : 'fixture-db';

    const repo = await driverRepo(t, path.join(root, 'imported'), id);

    if (failure.startsWith('npm-')) {
      await repo.release('2.0.0', {
        files: {
          'package.json': JSON.stringify({
            name: 'fixture-db',
            version: '2.0.0',
            ...(failure === 'npm-reject' ? { dependencies: { bad: 'file:../outside' } } : {}),
          }),
          'package-lock.json': '{"lockfileVersion":3,"packages":{"":{}}}',
        }
      });
    }

    const source = driver.service.sources.get('git');

    const original = source.fetch.bind(source);

    const entered = Promise.withResolvers();

    const release = Promise.withResolvers();

    source.fetch = async (request) => {
      if (failure === 'moved-sha') {
        await git(repo.work, 'commit', '--allow-empty', '-qm', 'moved');

        await git(repo.work, 'tag', '-f', 'v1.0.0');

        await git(repo.work, 'push', '-qf', 'origin', 'refs/tags/v1.0.0');
      }

      if (failure === 'cancel') {
        entered.resolve();

        await release.promise;
      }

      return original(request);
    };

    const running = await driver.service.startInstall({ url: repo.url });

    if (failure === 'cancel') {
      await entered.promise;

      const cancelling = driver.service.cancel(running.id);

      release.resolve();

      await cancelling;
    }

    await driver.service.whenIdle();

    const job = await driver.service.currentJob();

    const codes = {
      'moved-sha': 'checkout_mismatch',
      'npm-reject': 'package_unsupported',
      'npm-offline': 'dependencies_failed',
      reserved: 'id_reserved',
    };

    assert.equal(job.status, failure === 'cancel' ? 'cancelled' : 'failed');

    if (failure !== 'cancel') {
      assert.equal(job.error.code, codes[failure]);
    }

    assert.equal(await lstat(path.join(driver.pluginsDir, id)).catch(() => null), null);

    assert.equal(await lstat(path.join(root, 'imported')).catch(() => null), null);
  });
}
