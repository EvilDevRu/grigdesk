import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, lstat, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readPluginInstallConfiguration } from '../../server/src/lib/pluginInstall/configuration.ts';

const exec = promisify(execFile);

/**
 * Config читается в отдельном процессе с закрытым fixture env.
 * Системные GRIGDESK overrides и private state машины в проверку не попадают.
 */
async function readFixtureConfig(root, overrides = {}) {
  const configUrl = new URL('../../server/src/config.ts', import.meta.url).href;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `
    import { config } from ${JSON.stringify(configUrl)};
    process.stdout.write(JSON.stringify({
      rootDir: config.rootDir,
      dataHome: config.dataHome,
      userPluginsDir: config.userPluginsDir,
      userPluginsDataDir: config.userPluginsDataDir,
      pluginInstallsStatePath: config.pluginInstallsStatePath,
    }));
  `], {
    env: {
      PATH: '/usr/bin:/bin',
      HOME: root,
      NODE_ENV: 'production',
      ...overrides,
    },
    timeout: 10_000,
  });

  return JSON.parse(stdout);
}

test('CFG1: config defaults/overrides, safe paths и VERSION проверяются до создания сервиса', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-install-config-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const defaults = await readFixtureConfig(root);

  assert.equal(typeof defaults.userPluginsDataDir, 'string');
  assert.equal(defaults.userPluginsDataDir, path.join(defaults.dataHome, 'state/plugins'));
  assert.equal(defaults.pluginInstallsStatePath,
    path.join(defaults.dataHome, 'state/plugin-installs.json'));

  const selected = {
    rootDir: root,
    userPluginsDir: path.join(root, 'plugins'),
    userPluginsDataDir: path.join(root, 'data'),
    pluginInstallsStatePath: path.join(root, 'state/install.json'),
  };
  const config = await readFixtureConfig(root, {
    GRIGDESK_PLUGINS_DIR: selected.userPluginsDir,
    GRIGDESK_PLUGINS_DATA_DIR: selected.userPluginsDataDir,
    GRIGDESK_PLUGIN_INSTALLS_STATE_PATH: selected.pluginInstallsStatePath,
  });

  assert.equal(config.userPluginsDir, selected.userPluginsDir);
  assert.equal(config.userPluginsDataDir, selected.userPluginsDataDir);
  assert.equal(config.pluginInstallsStatePath, selected.pluginInstallsStatePath);
  await writeFile(path.join(root, 'VERSION'), '1.2.3\n');
  assert.deepEqual(await readPluginInstallConfiguration(selected), {
    pluginsDir: selected.userPluginsDir,
    statePath: selected.pluginInstallsStatePath,
    grigDeskVersion: '1.2.3',
  });

  for (const patch of [
    { userPluginsDataDir: path.join(selected.userPluginsDir, 'data') },
    { pluginInstallsStatePath: path.join(selected.userPluginsDir, '.grigdesk-install/state.json') },
    { userPluginsDir: 'relative/plugins' },
    { userPluginsDataDir: 'relative/data' },
    { pluginInstallsStatePath: 'relative/state.json' },
  ]) {
    await assert.rejects(readPluginInstallConfiguration({ ...selected, ...patch }));
  }

  await mkdir(path.join(root, 'target'));
  await symlink(path.join(root, 'target'), path.join(root, 'link'));
  await assert.rejects(readPluginInstallConfiguration({ ...selected,
    userPluginsDataDir: path.join(root, 'link/data') }));
  await assert.rejects(readPluginInstallConfiguration({ ...selected,
    pluginInstallsStatePath: path.join(root, 'link/install.json') }));
  await writeFile(path.join(root, 'VERSION'), 'invalid');
  await assert.rejects(readPluginInstallConfiguration(selected));
  assert.equal(await lstat(selected.userPluginsDir).catch(() => null), null, 'не создан owner/work root');
  assert.equal(await lstat(selected.userPluginsDataDir).catch(() => null), null);
  assert.equal(await lstat(selected.pluginInstallsStatePath).catch(() => null), null);
});

test('CFG2: настоящий boot recover до scan, полный SYSTEM reservedIds, installer API и close', async (t) => {
  const { pluginBootFixture, waitBootJob } = await import('./helpers/pluginBootFixture.js');
  const { createApplyFixture } = await import('./helpers/pluginApplyFixture.js');
  const { createPluginRepo } = await import('./helpers/pluginRepo.js');
  const repo = await createPluginRepo(t, { id: 'studio3d' });

  await repo.release('1.0.0');

  const fixture = await pluginBootFixture(t, {
    before: async ({ root, env }) => {
      const native = await createApplyFixture(t, {
        root,
        kind: 'update',
        workInside: true,
        importMarker: true,
      });
      const state = await native.store.read();

      await native.fs.ensureDir(native.transaction);
      await native.fs.rename(native.current, path.join(native.transaction, 'parked'));
      state.apply = native.intent;
      state.job.status = 'applying';
      await writeFile(env.GRIGDESK_PLUGIN_INSTALLS_STATE_PATH, JSON.stringify(state));
      await writeFile(env.GRIGDESK_PREFS_PATH, JSON.stringify({ plugins: { demo: true } }));
    },
  });
  const current = await fixture.get('/api/plugin-installs/jobs/current');

  assert.equal(current.status, 200, 'installer зарегистрирован настоящим app.ts');
  assert.equal((await current.json()).job.status, 'failed');
  assert.equal((await lstat(path.join(fixture.root, 'import-marker'))).isFile(), true);

  const catalog = await fixture.get('/api/plugins');
  const demo = (await catalog.json()).plugins.find((plugin) => plugin.id === 'demo');

  assert.equal(demo?.version, '1.0.0', 'recover создал current перед scan/import');
  assert.equal((await fixture.post('/api/plugin-installs/jobs', { url: repo.url })).status, 202);

  const result = await waitBootJob(fixture, (job) => job?.status === 'failed');

  assert.equal(result.job.error.code, 'id_reserved', 'SYSTEM включает последний studio3d id');
  fixture.child.kill('SIGTERM');
  assert.equal((await fixture.exited)[1], null, 'onClose заканчивается без SIGKILL');

  const { PluginInstallService } = await import('../../server/src/lib/pluginInstall/service.ts');
  const next = new PluginInstallService({
    pluginsDir: fixture.env.GRIGDESK_PLUGINS_DIR,
    statePath: fixture.env.GRIGDESK_PLUGIN_INSTALLS_STATE_PATH,
    grigDeskVersion: '0.1.0',
    reservedIds: ['studio3d'],
  });

  try {
    assert.deepEqual((await next.recover()).blockedIds, []);
    assert.equal((await next.currentJob()).error.code, 'id_reserved');
  } finally {
    await next.close();
  }
});

test('CFG3: второй owner и blocked state сохраняют встроенный API без import user marker', async (t) => {
  const { pluginBootFixture } = await import('./helpers/pluginBootFixture.js');
  const { writeHttpPlugin } = await import('./helpers/pluginInstallHttpFixture.js');
  const { PluginInstallService } = await import('../../server/src/lib/pluginInstall/service.ts');

  for (const ownerHeld of [true, false]) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-blocked-install-boot-'));
    const pluginsDir = path.join(root, 'plugins');
    const statePath = path.join(root, 'state/plugin-installs.json');
    const marker = path.join(root, 'user-marker');
    const holder = ownerHeld ? new PluginInstallService({
      pluginsDir,
      statePath,
      grigDeskVersion: '0.1.0',
      reservedIds: ['code'],
    }) : null;

    await mkdir(path.join(root, 'state'), { recursive: true });
    await writeHttpPlugin(pluginsDir, 'demo', {}, { 'server.js': `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(marker)}, 'imported');
      export default async function plugin() {}
    ` });
    await writeFile(path.join(root, 'state/prefs.json'), '{"plugins":{"demo":true}}');

    if (holder) {
      await holder.recover();
    } else {
      await writeFile(statePath, '{broken');
    }

    const fixture = await pluginBootFixture(t, { root, badState: !ownerHeld });

    t.after(async () => {
      if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
        fixture.child.kill('SIGKILL');
        await fixture.exited;
      }

      await holder?.close();
      await rm(root, { recursive: true, force: true });
    });

    const catalog = await fixture.get('/api/plugins');

    assert.equal(catalog.status, 200);
    assert.equal((await catalog.json()).plugins.some((plugin) => plugin.id === 'code'), true);
    assert.equal(await lstat(marker).catch(() => null), null, 'blocked tree не исполняет user server');

    const current = await fixture.get('/api/plugin-installs/jobs/current');

    assert.equal(current.status, 200);
    assert.equal((await current.json()).recoveryError.code,
      ownerHeld ? 'recovery_required' : 'state_invalid');
    assert.equal((await fixture.get('/api/health')).status, 200);
    fixture.child.kill('SIGTERM');
    await fixture.exited;
  }
});

test('CFG4: boot/close с native Git сливает workers, повторный boot узнаёт outcome', async (t) => {
  const { pluginBootFixture } = await import('./helpers/pluginBootFixture.js');
  const { createPluginRepo, fixtureGitEnv } = await import('./helpers/pluginRepo.js');
  const { runCommand } = await import('../../server/src/lib/pluginInstall/runCommand.ts');
  const { liveGroupMembers, terminateOwnedWorker } =
    await import('../../server/src/lib/pluginInstall/workerIdentity.ts');
  const { readFile, unlink } = await import('node:fs/promises');
  const repo = await createPluginRepo(t);

  await repo.release('1.0.0');
  await unlink(path.join(repo.origin, 'HEAD'));
  await exec('/usr/bin/mkfifo', [path.join(repo.origin, 'HEAD')], { env: fixtureGitEnv() });

  const probe = await runCommand('/usr/bin/git', ['ls-remote', repo.url], {
    cwd: repo.root,
    env: {
      ...fixtureGitEnv(),
      HOME: repo.root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      LC_ALL: 'C',
    },
    timeoutMs: 150,
  });

  assert.equal(probe.timedOut, true, 'fixture HEAD действительно удерживает настоящий Git');

  const fixture = await pluginBootFixture(t);
  const started = await fixture.post('/api/plugin-installs/jobs', { url: repo.url });

  assert.equal(started.status, 202);

  const deadline = Date.now() + 10_000;
  let workers = [];
  let executing = false;

  while (Date.now() < deadline) {
    const disk = JSON.parse(await readFile(fixture.env.GRIGDESK_PLUGIN_INSTALLS_STATE_PATH, 'utf8'));

    workers = Object.values(disk.workers);

    for (const worker of workers) {
      for (const member of await liveGroupMembers(worker.pgid)) {
        const command = await readFile(`/proc/${member.pid}/cmdline`, 'utf8').catch(() => '');

        executing ||= command.includes('\0ls-remote\0');
      }
    }

    if (executing) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(executing, true, 'durable ACK уже разрешил executable, проверяется настоящий worker');
  fixture.child.kill('SIGTERM');
  assert.equal((await fixture.exited)[1], null);

  for (const worker of workers) {
    assert.equal(await terminateOwnedWorker(worker), true);
    assert.deepEqual(await liveGroupMembers(worker.pgid), []);
  }

  const stable = JSON.parse(await readFile(fixture.env.GRIGDESK_PLUGIN_INSTALLS_STATE_PATH, 'utf8'));

  assert.deepEqual(stable.workers, {}, 'onClose записал finished до выхода app');
  assert.equal(stable.job.status, 'cancelled');
  assert.equal(stable.apply, null);

  const next = await pluginBootFixture(t, { root: fixture.root });

  try {
    const current = await next.get('/api/plugin-installs/jobs/current');
    const outcome = await current.json();

    assert.equal(outcome.job.id, stable.job.id);
    assert.equal(outcome.job.status, 'cancelled');
    assert.equal(outcome.recoveryError, null);
  } finally {
    if (next.child.exitCode === null && next.child.signalCode === null) {
      next.child.kill('SIGTERM');
    }

    await next.exited;
  }
});
