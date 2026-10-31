import assert from 'node:assert/strict';

import { execFile } from 'node:child_process';

import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';

import os from 'node:os';

import path from 'node:path';

import test from 'node:test';

import { promisify } from 'node:util';

import { pluginBootFixture } from './helpers/pluginBootFixture.js';

import { createPluginRepo } from './helpers/pluginRepo.js';

import { writeEngine, adapterSource } from './helpers/dbEngineFixture.js';

import { PluginInstallService } from '../../server/src/lib/packageInstall/service.ts';

import { createDbSessionManager } from '../../server/src/lib/db/sessionManager.ts';

import { createEngineRegistry } from '../../server/src/lib/db/engineRegistry.ts';

import * as configuration from '../../server/src/lib/packageInstall/configuration.ts';

const exec = promisify(execFile);

const BASE = '/api/db/engine-installs';

/**
 * Перезапуск относится только к собственным children, созданным этой фикстурой.
 * Общий временный home удаляется после остановки всех её экземпляров сервера.
 */
async function bootHome(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-driver-boot-'));

  const children = [];

  const services = [];

  t.after(async () => {
    for (const fixture of children) {
      if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
        fixture.child.kill('SIGKILL');

        await fixture.exited;
      }
    }

    for (const service of services) {
      await service.close();
    }

    await rm(root, { recursive: true, force: true });
  });

  const start = async (before, options = {}) => {
    const fixture = await pluginBootFixture(t, {
      root,
      ...options,
      env: {
        GRIGDESK_DB_ENGINES_DIR: path.join(root, 'db-engines'),
        GRIGDESK_DB_ENGINE_INSTALLS_STATE_PATH: path.join(root, 'state/db-engine-installs.json'),
      },
      before: async (input) => {
        await mkdir(path.join(root, 'state'), { recursive: true });

        await writeFile(input.env.GRIGDESK_PREFS_PATH, JSON.stringify({ plugins: { db: true } }));

        await before?.(input);
      },
    });

    children.push(fixture);

    return fixture;
  };

  return {
    root,
    start,
    keep: (service) => services.push(service)
  };
}

/**
 * Poll использует исходный job id и session API своего child.
 * Терминальный отказ возвращается сразу, чтобы не маскировать его таймаутом.
 */
async function readyJob(fixture, jobId) {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const response = await fixture.get(`${BASE}/jobs/${jobId}`, fixture.session);

    assert.equal(response.status, 200);

    const { job } = await response.json();

    if (job && !['running', 'applying'].includes(job.status)) {
      assert.equal(job.status, 'ready', JSON.stringify(job.error));

      return job;
    }

    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  assert.fail('Подготовка собственного driver repo не завершилась');
}

/**
 * Завершение сервера ждёт настоящий onClose без переключения стенда пользователя.
 * После SIGTERM тот же root разрешено открыть новому собственному child.
 */
async function stop(fixture) {
  fixture.child.kill('SIGTERM');

  const [, signal] = await fixture.exited;

  assert.equal(signal, null, 'сервер должен завершить onClose без SIGKILL');
}

test('DCFG-01: config берёт default/env драйверов из того же data home', async (t) => {
  const { root } = await bootHome(t);

  const configUrl = new URL('../../server/src/config.ts', import.meta.url).href;

  const read = async (env = {}) => {
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `
      import { config } from ${JSON.stringify(configUrl)};
      console.log(JSON.stringify({ home: config.dataHome, dir: config.dbEnginesDir,
        state: config.dbEngineInstallsStatePath }));
    `], {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: root,
        GRIGDESK_HOME: root,
        ...env
      }, timeout: 10_000
    });

    return JSON.parse(stdout);
  };

  const defaults = await read();

  assert.equal(defaults.dir, path.join(defaults.home, 'db-engines'));

  assert.equal(defaults.state, path.join(defaults.home, 'state/db-engine-installs.json'));

  const dir = path.join(root, 'custom-engines');

  const state = path.join(root, 'state/custom-installs.json');

  const selected = await read({
    GRIGDESK_DB_ENGINES_DIR: dir, GRIGDESK_DB_ENGINE_INSTALLS_STATE_PATH: state,
  });

  assert.equal(selected.dir, dir);

  assert.equal(selected.state, state);

  assert.equal(await lstat(dir).catch(() => null), null);
});

test('DCFG-01: overlap/state/symlink запрещены до mkdir/owner effects', async (t) => {
  const { root } = await bootHome(t);

  const selected = {
    rootDir: root,
    userPluginsDir: path.join(root, 'plugins'),
    userPluginsDataDir: path.join(root, 'plugin-data'),
    pluginInstallsStatePath: path.join(root, 'state/plugin-installs.json'),
    dbEnginesDir: path.join(root, 'db-engines'),
    dbEngineInstallsStatePath: path.join(root, 'state/db-engine-installs.json'),
  };

  await writeFile(path.join(root, 'VERSION'), '1.0.0\n');

  await symlink('db-engines', path.join(root, 'link'));

  const validate = configuration.readDbEngineInstallConfiguration
    ?? configuration.readPluginInstallConfiguration;

  for (const patch of [
    { dbEnginesDir: selected.userPluginsDir },
    { dbEnginesDir: path.join(selected.userPluginsDir, 'nested') },
    { dbEnginesDir: selected.userPluginsDataDir },
    { dbEngineInstallsStatePath: selected.pluginInstallsStatePath },
    { dbEngineInstallsStatePath: path.join(selected.dbEnginesDir, 'state.json') },
    { dbEnginesDir: path.join(root, 'link') },
  ]) {
    await assert.rejects(validate({ ...selected, ...patch }), 'конфигурация должна быть отклонена');

    assert.equal(await lstat(selected.dbEnginesDir).catch(() => null), null);

    assert.equal(await lstat(selected.pluginInstallsStatePath).catch(() => null), null);
  }
});

test('DBOOT-01: startup объединяет встроенные и внешний, GET не импортирует повторно', async (t) => {
  const home = await bootHome(t);

  const marker = path.join(home.root, 'imported');

  const fixture = await home.start(async ({ env }) => {
    await writeEngine(env.GRIGDESK_DB_ENGINES_DIR, 'fixture-db', {}, adapterSource('fixture-db',
      `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'x');`));
  });

  const response = await fixture.get('/api/db/engines', fixture.session);

  assert.equal(response.status, 200);

  assert.deepEqual((await response.json()).engines.map((item) => item.id).sort(),
    ['clickhouse', 'fixture-db', 'mysql', 'redis']);

  await fixture.get('/api/db/engines', fixture.session);

  assert.equal(await readFile(marker, 'utf8'), 'x');
});

test('DBOOT-01: install/update/rollback активируются только новым server child', async (t) => {
  const home = await bootHome(t);

  const repo = await createPluginRepo(t, { id: 'fixture-db', packageKind: 'db-engine' });

  const marker = path.join(home.root, 'versions-loaded');

  const source = (version) => adapterSource('fixture-db', `
    import { appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(version)});
  `);

  await repo.release('1.0.0', { files: { 'entry.mjs': source('1') } });

  let fixture = await home.start();

  const install = await fixture.post(`${BASE}/jobs`, { url: repo.url, version: '1.0.0' });

  assert.equal(install.status, 202);

  const ready = await readyJob(fixture, (await install.json()).job.id);

  assert.equal(await lstat(marker).catch(() => null), null);

  assert.equal((await fixture.post(`${BASE}/jobs/${ready.id}/apply`, {
    reviewToken: ready.reviewToken,
  })).status, 200);

  assert.equal(await lstat(marker).catch(() => null), null);

  assert.equal((await (await fixture.get('/api/db/engines', fixture.session)).json())
    .engines.some((item) => item.id === 'fixture-db'), false);

  await stop(fixture);

  fixture = await home.start();

  assert.equal(await readFile(marker, 'utf8'), '1');

  await repo.release('2.0.0', { files: { 'entry.mjs': source('2') } });

  const update = await fixture.post(`${BASE}/engines/fixture-db/update`, { version: '2.0.0' });

  assert.equal(update.status, 202);

  const updateReady = await readyJob(fixture, (await update.json()).job.id);

  await fixture.post(`${BASE}/jobs/${updateReady.id}/apply`, { reviewToken: updateReady.reviewToken });

  assert.equal(await readFile(marker, 'utf8'), '1');

  await stop(fixture);

  fixture = await home.start();

  assert.equal(await readFile(marker, 'utf8'), '12');

  const state = JSON.parse(await readFile(fixture.env.GRIGDESK_DB_ENGINE_INSTALLS_STATE_PATH));

  const record = state.plugins['fixture-db'];

  const rolled = await fixture.post(`${BASE}/engines/fixture-db/rollback`, {
    requestId: '00000000-0000-4000-8000-000000000001',
    expectedRevision: record.revision,
    expectedPreviousDigest: record.previous.payloadDigest,
  });

  assert.equal(rolled.status, 200);

  assert.equal(await readFile(marker, 'utf8'), '12');

  await stop(fixture);

  fixture = await home.start();

  assert.equal(await readFile(marker, 'utf8'), '121');

  await stop(fixture);
});

for (const problem of ['damaged-state', 'second-owner']) {
  test(`DBOOT-02: ${problem} блокирует external до import, builtin и diagnostics живы`, async (t) => {
    const home = await bootHome(t);

    const marker = path.join(home.root, 'imported');

    let owner;

    const fixture = await home.start(async ({ env }) => {
      await writeEngine(env.GRIGDESK_DB_ENGINES_DIR, 'fixture-db', {}, adapterSource('fixture-db',
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad');`));

      if (problem === 'damaged-state') {
        await writeFile(env.GRIGDESK_DB_ENGINE_INSTALLS_STATE_PATH, '{broken');
      } else {
        owner = new PluginInstallService({
          packageKind: 'db-engine',
          pluginsDir: env.GRIGDESK_DB_ENGINES_DIR,
          statePath: env.GRIGDESK_DB_ENGINE_INSTALLS_STATE_PATH,
          grigDeskVersion: '1.0.0',
          reservedIds: [],
        });

        await owner.recover();

        home.keep(owner);
      }
    }, { badDbEngineState: problem === 'damaged-state' });

    const response = await fixture.get('/api/db/engines', fixture.session);

    assert.equal(response.status, 200);

    const body = await response.json();

    assert.deepEqual(body.engines.map((item) => item.id).sort(), ['clickhouse', 'mysql', 'redis']);

    assert.ok(body.installHealth || body.errors?.length, 'ошибка должна быть видна человеку');

    assert.equal(await lstat(marker).catch(() => null), null);
  });
}

/**
 * Начальная установка проходит общий service, затем реестр строится как после restart.
 * Проверка ready предшествует импорту нового binding: отсутствие файла не считается RED.
 */
async function runtimeFixture(t, rollback = false) {
  const { serviceFixture } = await import('./helpers/pluginServiceFixture.js');

  const repo = await createPluginRepo(t, { id: 'fixture-db', packageKind: 'db-engine' });

  await repo.release('1.0.0', { files: { 'entry.mjs': adapterSource() } });

  const fixture = await serviceFixture(t, { packageKind: 'db-engine' });

  await fixture.service.startInstall({ url: repo.url, version: '1.0.0' });

  await fixture.service.whenIdle();

  const initial = await fixture.service.currentJob();

  assert.equal(initial.status, 'ready', JSON.stringify(initial.error));

  await fixture.service.apply(initial.id, initial.reviewToken);

  if (rollback) {
    await repo.release('2.0.0', { files: { 'entry.mjs': adapterSource(), 'version.txt': 'two' } });

    await fixture.service.startUpdate('fixture-db', { version: '2.0.0' });

    await fixture.service.whenIdle();

    const update = await fixture.service.currentJob();

    assert.equal(update.status, 'ready', JSON.stringify(update.error));

    await fixture.service.apply(update.id, update.reviewToken);
  }


  const registry = await createEngineRegistry({
    externalDir: fixture.pluginsDir, grigDeskVersion: '1.0.0',
  });

  const adapter = registry.get('fixture-db');

  assert.ok(adapter, 'после ручной сборки нового registry драйвер должен быть доступен');

  const sessions = createDbSessionManager({ engines: registry });

  t.after(() => sessions.dispose());

  const module = await import('../../server/src/lib/db/installRuntime.ts');

  const create = module.createDbEngineInstallRuntime ?? module.default;

  const runtime = create({ sessions, engines: registry });

  fixture.service.bindRuntime(runtime);

  if (rollback) {
    return {
      ...fixture,
      registry,
      sessions,
      runtime,
      adapter
    };
  }


  await repo.release('2.0.0', { files: { 'entry.mjs': adapterSource(), 'version.txt': 'two' } });

  await fixture.service.startUpdate('fixture-db', { version: '2.0.0' });

  await fixture.service.whenIdle();

  const ready = await fixture.service.currentJob();

  assert.equal(ready.status, 'ready', JSON.stringify(ready.error));

  return {
    ...fixture,
    registry,
    sessions,
    runtime,
    adapter,
    ready
  };
}

/**
 * Произвольный движок использует тот же профиль и SPI без имени конкретной СУБД.
 * Пароль — только Buffer локальной фикстуры, он не попадает в durable installer state.
 */
function openFixture(sessions, engine = 'fixture-db') {
  return sessions.open({
    profile: {
      id: 'profile',
      projectId: 'fixture',
      label: 'Фикстура',
      role: 'read',
      engine,
      host: 'fixture.invalid',
      port: 9999,
      user: 'reader',
      database: '',
      prod: false,
      via: 'direct',
    },
    password: Buffer.from('PRIVATE_PASSWORD'),
  });
}

for (const phase of ['opening', 'alive', 'closing']) {
  test(`DBOOT-03: ${phase} запрещает apply без close/cancel/rename и сохраняет ready/token`, async (t) => {
    const fixture = await runtimeFixture(t);

    const entered = Promise.withResolvers();

    const held = Promise.withResolvers();

    let closes = 0;

    let cancels = 0;

    fixture.adapter.open = async () => {
      if (phase === 'opening') {
        entered.resolve();

        await held.promise;
      }

      return {};
    };

    fixture.adapter.close = async () => {
      closes += 1;

      if (phase === 'closing') {
        entered.resolve();

        await held.promise;
      }
    };

    fixture.adapter.cancel = async () => {
      cancels += 1;
    };

    const opening = openFixture(fixture.sessions);

    let session;

    let closing;

    if (phase === 'opening') {
      await entered.promise;
    } else {
      session = await opening;

      if (phase === 'closing') {
        closing = fixture.sessions.close(session.id);

        await entered.promise;
      }
    }

    const bytes = await readFile(path.join(fixture.pluginsDir, 'fixture-db/engine.json'), 'utf8');

    try {
      await assert.rejects(fixture.service.apply(fixture.ready.id, fixture.ready.reviewToken), {
        code: 'engine_busy',
      });

      const ready = await fixture.service.currentJob();

      assert.equal(ready.status, 'ready');

      assert.equal(ready.reviewToken, fixture.ready.reviewToken);

      assert.equal(await readFile(path.join(fixture.pluginsDir, 'fixture-db/engine.json'), 'utf8'), bytes);

      assert.equal(cancels, 0);

      assert.equal(closes, phase === 'closing' ? 1 : 0);
    } finally {
      held.resolve();

      session ??= await opening;

      await closing;

      await fixture.sessions.close(session.id);
    }

    const done = await fixture.service.apply(fixture.ready.id, fixture.ready.reviewToken);

    assert.equal(done.status, 'done');

    await assert.rejects(openFixture(fixture.sessions), { code: 'engine_restart_required' });

    assert.doesNotMatch(await readFile(fixture.statePath, 'utf8'), /PRIVATE_PASSWORD/u);
  });
}

for (const outcome of ['reverted', 'installed', 'blocked']) {
  test(`DBOOT-03: lease ${outcome} атомарно закрывает admission и finish идемпотентен`, async (t) => {
    const fixture = await runtimeFixture(t);

    let opens = 0;

    fixture.adapter.open = async () => {
      opens += 1;

      return {};
    };

    const lease = await fixture.runtime.prepareReplace('fixture-db');

    await assert.rejects(openFixture(fixture.sessions), { code: 'engine_replacing' });

    assert.equal(opens, 0, 'racing open не должен достигать адаптера');

    await lease.finish(outcome);

    await lease.finish(outcome);

    if (outcome === 'reverted') {
      const session = await openFixture(fixture.sessions);

      assert.equal(opens, 1);

      await fixture.sessions.close(session.id);
    } else {
      await assert.rejects(openFixture(fixture.sessions), {
        code: outcome === 'installed' ? 'engine_restart_required' : 'engine_recovery_required',
      });

      assert.equal(opens, 0);
    }

    const builtin = fixture.registry.get('redis');

    builtin.open = async () => ({});

    builtin.close = async () => { };

    const other = await openFixture(fixture.sessions, 'redis');

    assert.equal(other.engine, 'redis');

    await fixture.sessions.close(other.id);
  });
}

for (const outcome of ['completed', 'blocked']) {
  test(`DBOOT-02: partial transaction ${outcome} разрешается до external import`, async (t) => {
    const { createApplyFixture } = await import('./helpers/pluginApplyFixture.js');

    const home = await bootHome(t);

    const fixture = await home.start(async ({ root, env }) => {
      const native = await createApplyFixture(t, {
        root,
        kind: 'update',
        packageKind: 'db-engine',
        workInside: true,
        importMarker: true,
      });

      const state = await native.store.read();

      await native.fs.ensureDir(native.transaction);

      if (outcome === 'completed') {
        await native.fs.rename(native.current, path.join(native.transaction, 'parked'));

        await native.fs.rename(native.candidate, native.current);
      } else {
        await writeFile(path.join(native.current, 'marker.txt'), 'unknown current bytes');
      }

      state.job.status = 'applying';

      state.apply = native.intent;

      await writeFile(env.GRIGDESK_DB_ENGINE_INSTALLS_STATE_PATH, JSON.stringify(state));
    });

    const response = await fixture.get('/api/db/engines', fixture.session);

    assert.equal(response.status, 200);

    const body = await response.json();

    const current = await fixture.get(BASE + '/jobs/current', fixture.session);

    assert.equal(current.status, 200);

    const { job } = await current.json();

    if (outcome === 'completed') {
      assert.equal(job.status, 'done');

      assert.ok(body.engines.some((engine) => engine.id === 'demo'));

      assert.equal(await readFile(path.join(home.root, 'import-marker'), 'utf8'), '1.1.0');
    } else {
      assert.equal(job.status, 'recovery_required');

      assert.equal(body.engines.some((engine) => engine.id === 'demo'), false);

      assert.equal(await lstat(path.join(home.root, 'import-marker')).catch(() => null), null);

      assert.ok(body.installHealth || body.errors?.length);

      assert.equal(await readFile(path.join(home.root, 'db-engines/demo/marker.txt'), 'utf8'),
        'unknown current bytes');
    }
  });
}

test('DBOOT-03: rollback занятого движка сохраняет обе копии, после close требует restart', async (t) => {
  const fixture = await runtimeFixture(t, true);

  const session = await openFixture(fixture.sessions);

  const record = (await fixture.service.store.read()).plugins['fixture-db'];

  const request = {
    requestId: '00000000-0000-4000-8000-000000000002',
    expectedRevision: record.revision,
    expectedPreviousDigest: record.previous.payloadDigest,
  };

  const current = path.join(fixture.pluginsDir, 'fixture-db/engine.json');

  const previous = path.join(fixture.service.workDir, 'previous/fixture-db/engine.json');

  const before = await Promise.all([readFile(current, 'utf8'), readFile(previous, 'utf8')]);

  await assert.rejects(fixture.service.rollback('fixture-db', request), { code: 'engine_busy' });

  assert.deepEqual(await Promise.all([readFile(current, 'utf8'), readFile(previous, 'utf8')]), before);

  assert.equal(fixture.sessions.get(session.id).id, session.id);

  await fixture.sessions.close(session.id);

  const rolled = await fixture.service.rollback('fixture-db', request);

  assert.equal(rolled.status, 'done');

  await assert.rejects(openFixture(fixture.sessions), { code: 'engine_restart_required' });
});
