import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { ProviderInstallService } from '../../server/src/lib/providerInstall/service.ts';
import { isProviderInstallSnapshot } from '../../shared/chat/providerInstallContracts.ts';
import { isProviderLifecycleSnapshot } from '../../shared/chat/providerLifecycleContracts.ts';
import { acquireCliLease } from '../../server/src/lib/providerInstall/leases.ts';
import { readEnvFile } from '../../server/src/lib/envFile.ts';
import { discoverExternalCli } from '../../server/src/lib/providerInstall/inventory.ts';
import { readInstallState } from '../../server/src/lib/providerInstall/stateStore.ts';
import { InstallEnvironmentError } from '../../server/src/lib/providerInstall/npmEnvironment.ts';
import { registerProviderInstallations } from '../../server/src/modules/providers/installations.ts';

const require = createRequire(new URL('../../server/package.json', import.meta.url));
const Fastify = require('fastify');

test('HTTP prepare отдаёт переводимые коды отказа настоящей проверки npm до старта', async (t) => {
  for (const code of ['installer_strategy_unverified', 'npm_graph_invalid']) {
    await t.test(code, async (scenario) => {
      const stand = await fixture(scenario);
      const app = Fastify({ logger: false });

      scenario.after(() => app.close());
      registerProviderInstallations(app, stand.service);

      if (code === 'installer_strategy_unverified') {
        const manifestPath = path.join(stand.root, 'package.json');
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

        manifest.scripts = { postinstall: 'node unreviewed.js' };
        await fs.writeFile(manifestPath, JSON.stringify(manifest));
      } else {
        const modules = path.join(stand.root, 'node_modules');

        await fs.mkdir(modules);
        await fs.symlink(stand.home, path.join(modules, 'outside'));
      }

      const response = await app.inject({
        method: 'POST',
        url: '/api/providers/installations/v2/fixture/uninstall/prepare',
        payload: {},
      });

      assert.equal(response.statusCode, 409, response.body);
      assert.deepEqual(response.json(), { error: code, message: '' });
      assert.equal((await stand.service.currentLifecycle()).active, null);
      assert.equal(stand.mutations.length, 0);
      assert.equal(await fs.readFile(path.join(stand.root, 'cli.js'), 'utf8'),
        '#!/bin/sh\necho 1.0.0\n');
    });
  }
});

test('HTTP prepare сохраняет собственную подробную причину и скрывает сторонний текст', async (t) => {
  const cases = [
    {
      error: new InstallEnvironmentError('npm_graph_invalid', 'Получен другой npm-пакет'),
      code: 'npm_graph_invalid',
      message: 'Получен другой npm-пакет',
    },
    {
      error: Object.assign(new Error('private registry credentials'), { code: 'third_party_failure' }),
      code: 'third_party_failure',
      message: 'Подготовка операции не удалась',
    },
  ];

  for (const entry of cases) {
    await t.test(entry.code, async (scenario) => {
      const stand = await fixture(scenario);
      const app = Fastify({ logger: false });

      scenario.after(() => app.close());
      registerProviderInstallations(app, stand.service);
      stand.adapter.externalCli = () => {
        throw entry.error;
      };

      const response = await app.inject({
        method: 'POST',
        url: '/api/providers/installations/v2/fixture/update/prepare',
        payload: {},
      });

      assert.equal(response.statusCode, 409, response.body);
      assert.deepEqual(response.json(), { error: entry.code, message: entry.message });
      assert.equal(stand.mutations.length, 0);
    });
  }
});

/**
 * Реальные Bash discovery, prefix/CAS и сервис работают с искусственным npm transport.
 * Fixture не читает rc владельца и не может устанавливать пакеты за пределами своего HOME.
 */
async function fixture(t, options = {}) {
  const base = path.join(artifactsPath({ env: process.env, home: os.homedir() }),
    'external-cli-lifecycle/service-tests');

  await fs.mkdir(base, { recursive: true });

  const home = await fs.mkdtemp(path.join(base, 'case-'));
  const bin = path.join(home, 'runtime/bin');
  const prefix = path.join(home, 'prefix');
  const data = path.join(home, 'data');
  const installedPrefix = options.legacy ? path.join(data, 'state/npm-global') : prefix;
  const root = options.native ? path.join(home, '.kimi-code/bin')
    : path.join(installedPrefix, 'lib/node_modules/@fixture/cli');
  const alias = options.externalAlias ? path.join(home, '.local/bin/fixture')
    : options.native ? path.join(root, 'fixture') : path.join(installedPrefix, 'bin/fixture');
  const events = [];
  const mutations = [];
  const invalidations = [];
  const refreshes = [];
  let gate = null;
  let nativeVersion = '1.0.0';
  let service;

  t.after(async () => {
    await service?.dispose();
    await fs.rm(home, { recursive: true, force: true });
  });
  await fs.mkdir(bin, { recursive: true });
  await fs.symlink(process.execPath, path.join(bin, 'node'));
  await fs.writeFile(path.join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_PREFIX"\n', { mode: 0o755 });
  await fs.writeFile(path.join(home, '.bashrc'),
    `export PATH="${path.dirname(alias)}:${bin}:/usr/bin:/bin"\nexport FIXTURE_PREFIX="${prefix}"\n`);
  await fs.writeFile(path.join(home, '.bash_profile'), 'source "$HOME/.bashrc"\n');

  /**
   * Materialize кладёт fixture-пакет в выбранный prefix без сети.
   * Повреждение и восстановление проверяются файлами этого дерева.
   */
  async function materialize(target) {
    const packageRoot = path.join(target, 'lib/node_modules/@fixture/cli');

    await fs.mkdir(packageRoot, { recursive: true });
    await fs.mkdir(path.join(target, 'bin'), { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: '@fixture/cli',
      version: '1.0.0',
      bin: { fixture: 'cli.js' },
    }));
    await fs.writeFile(path.join(packageRoot, 'cli.js'), '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });
    await fs.symlink('../lib/node_modules/@fixture/cli/cli.js', path.join(target, 'bin/fixture'))
      .catch((error) => {
        if (error.code !== 'EEXIST') {
          throw error;
        }
      });
  }

  if (options.native) {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });

    const entry = options.externalAlias ? path.join(root, 'program') : alias;

    await fs.writeFile(entry, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 });

    if (options.externalAlias) {
      await fs.mkdir(path.dirname(alias), { recursive: true, mode: 0o700 });
      await fs.symlink(entry, alias);
    }
  } else {
    await materialize(installedPrefix);
  }

  const adapter = {
    id: 'fixture',
    name: 'Fixture',
    bin: (config) => config.fixtureBin,
    externalCli: () => ({
      packageId: '@fixture/cli',
      binName: 'fixture',
      configKey: 'fixtureBin',
      envKey: 'FIXTURE_BIN',
      ...(options.native ? { native: [{ root, entry: alias }] } : {}),
    }),
    installation: () => ({
      install: {
        executable: '/bin/bash',
        args: ['-c', 'fixture-official-installer'],
        command: 'fixture-official-installer',
        fallbackCommand: 'fixture-official-installer',
      },
      update: null,
      loginCommand: 'fixture login',
    }),
  };
  const config = {
    dataHome: data,
    fixtureBin: options.pinned ? alias : 'fixture',
    envPath: path.join(home, '.env'),
  };
  const env = {
    HOME: home,
    SHELL: '/bin/bash',
    PATH: '/usr/bin:/bin',
    ...options.pinned ? { FIXTURE_BIN: alias } : {},
  };

  await fs.writeFile(config.envPath, `KEEP=value\n${options.pinned ? `FIXTURE_BIN=${alias}\n` : ''}`);

  service = new ProviderInstallService({
    statePath: path.join(data, 'state.json'),
    config,
    roots: {
      dataHome: data,
      runtimeRoot: path.join(home, 'R'),
      installationRoot: path.join(home, 'I'),
    },
    artifactsDir: path.join(home, 'artifacts'),
    env,
    adaptersOf: async () => new Map([['fixture', adapter]]),
    latestOf: () => options.native ? '2.0.0' : '1.0.0',
    refreshModels: async () => {
      refreshes.push('models');
    },
    invalidate: async () => {
      refreshes.push('registry');
    },
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
    async runCommand(file, args, runOptions) {
      let stdout = '';

      if (file === alias) {
        stdout = options.native ? options.unverifiedVersion ? '' : nativeVersion : '1.0.0';
      } else if (options.native && file === '/bin/bash') {
        mutations.push(args);
        await gate;
        nativeVersion = options.stale ? '1.0.0' : '2.0.0';
        await fs.writeFile(alias, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2]), { mode: 0o755 });
        runOptions.onStdout?.('fixture installer progress\n');
      } else if (args[1] === 'view') {
        stdout = JSON.stringify('sha512-Zml4dHVyZQ==');
      } else {
        const target = args[args.indexOf('--prefix') + 1];

        if (target === installedPrefix) {
          mutations.push(args);
          await gate;
        }
        if (args[1] === 'uninstall') {
          await fs.rm(root, { recursive: true });
          await fs.unlink(alias);
        } else {
          await materialize(target);
        }
      }

      return {
        code: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        stdout,
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        workspaceLimitExceeded: false,
      };
    },
  });

  return {
    service,
    home,
    prefix,
    installedPrefix,
    root,
    alias,
    data,
    events,
    mutations,
    invalidations,
    config,
    env,
    adapter,
    materialize,
    refreshes,
    hold: (value) => {
      gate = value;
    },
  };
}

/**
 * Официальная установка допускает групповую запись своей основной группы.
 * Проверяем предков, root, вложенный каталог и файлы без зависимости от umask стенда.
 */
async function allowNativeGroupWrite(stand) {
  const directory = path.join(stand.root, 'resources');
  const file = path.join(directory, 'data');

  await fs.mkdir(directory);
  await fs.writeFile(file, 'fixture data');

  for (const target of [stand.home, path.dirname(stand.root), stand.root, directory, file, stand.alias]) {
    await fs.chown(target, process.getuid(), process.getgid());
    await fs.chmod(target, 0o775);
    assert.equal((await fs.lstat(target)).gid, process.getgid());
  }
}

test('native update и reinstall запускают официальный installer без npm и проверяют версию', async (t) => {
  for (const operation of ['update', 'reinstall']) {
    await t.test(operation, async (scenario) => {
      const stand = await fixture(scenario, { native: true, pinned: true });

      await allowNativeGroupWrite(stand);
      await fs.unlink(path.join(stand.home, 'runtime/bin/npm'));
      await fs.unlink(path.join(stand.home, 'runtime/bin/node'));
      await fs.writeFile(path.join(stand.home, '.bashrc'),
        `export PATH="${path.dirname(stand.alias)}"\n`);

      const preview = await stand.service.prepareLifecycle('fixture', operation, 'owner');

      assert.equal(preview.method, 'native');
      assert.equal(preview.prefix, null);
      assert.equal(preview.command, 'fixture-official-installer');
      assert.equal(preview.fromVersion, '1.0.0');
      assert.equal(stand.mutations.length, 0, 'prepare запустил installer');

      const started = await stand.service.startLifecycle('fixture', operation, preview.token, 'owner');

      assert.equal((await started.completion).ok, true);

      const job = (await stand.service.currentLifecycle()).recent.fixture;

      assert.equal(job.after, '2.0.0');
      assert.equal(job.outcome, operation === 'update' ? 'updated' : 'reinstalled');
      assert.match(job.outputTail, /installer progress/u);
      assert.equal(stand.mutations.length, 1);
      assert.equal(stand.config.fixtureBin, stand.alias);
    });
  }
});

test('native uninstall подтверждает root, сохраняет auth/settings/history и снимает привязку', async (t) => {
  const stand = await fixture(t, { native: true, pinned: true });
  const files = ['credentials.json', 'config.toml', 'sessions/history.json'];

  await allowNativeGroupWrite(stand);

  for (const file of files) {
    const target = path.join(stand.home, '.kimi-code', file);

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `fixture ${file}`);
  }

  const preview = await stand.service.prepareLifecycle('fixture', 'uninstall', 'owner');

  assert.equal(preview.method, 'native');
  assert.equal(preview.fromVersion, '1.0.0');
  assert.ok(preview.footprint.some((item) => item.path === stand.root && item.action === 'remove'));
  assert.ok(!preview.footprint.some((item) => files.some((file) => item.path.endsWith(file))));
  assert.equal(await fs.readFile(stand.alias).then(() => true), true);

  const started = await stand.service.startLifecycle('fixture', 'uninstall', preview.token, 'owner');

  assert.equal((await started.completion).ok, true);
  assert.equal(await fs.lstat(stand.root).then(() => true, () => false), false);
  assert.equal(stand.config.fixtureBin, 'fixture');
  assert.equal(stand.env.FIXTURE_BIN, undefined);
  assert.deepEqual(await readEnvFile(stand.config.envPath), { KEEP: 'value' });
  assert.equal(stand.mutations.length, 0, 'uninstall запустил installer');

  for (const file of files) {
    assert.equal(await fs.readFile(path.join(stand.home, '.kimi-code', file), 'utf8'), `fixture ${file}`);
  }

  const saved = await readInstallState(path.join(stand.data, 'state.json'));

  assert.equal(saved.lifecycleRecovery, null);
  assert.equal(saved.lifecycle.recent.fixture.outcome, 'uninstalled');
  assert.deepEqual(stand.refreshes, ['registry', 'models']);
});

test('native start отказывает при чужой привязке, замене entry и root-ссылке', async (t) => {
  for (const change of ['config', 'env-file', 'env-path', 'entry', 'root-link', 'installer']) {
    await t.test(change, async (scenario) => {
      const stand = await fixture(scenario, { native: true, pinned: true });
      const preview = await stand.service.prepareLifecycle('fixture', 'uninstall', 'owner');
      const other = path.join(stand.home, 'other');

      await fs.mkdir(other);
      await fs.writeFile(path.join(other, 'keep'), 'other program');

      if (change === 'config') {
        stand.config.fixtureBin = path.join(other, 'fixture');
      } else if (change === 'env-file') {
        await fs.writeFile(stand.config.envPath, `FIXTURE_BIN=${other}/fixture\n`);
      } else if (change === 'entry') {
        await fs.writeFile(stand.alias, 'other program');
      } else if (change === 'env-path') {
        await fs.copyFile(stand.config.envPath, path.join(other, '.env'));
        stand.config.envPath = path.join(other, '.env');
      } else if (change === 'installer') {
        const definition = stand.adapter.installation();

        stand.adapter.installation = () => definition;
        definition.install.args = ['-c', 'other command'];
      } else {
        await fs.rename(stand.root, `${stand.root}-old`);
        await fs.symlink(other, stand.root);
      }

      await assert.rejects(stand.service.startLifecycle('fixture', 'uninstall', preview.token, 'owner'),
        (error) => ['preparation_changed', 'installation_conflict'].includes(error.code));
      assert.equal(await fs.readFile(path.join(other, 'keep'), 'utf8'), 'other program');
      assert.equal(stand.mutations.length, 0);
    });
  }
});

test('native uninstall не принимает identity другой копии под ручной привязкой', async (t) => {
  const stand = await fixture(t, { native: true, pinned: true });
  const inventory = await discoverExternalCli({
    providerId: 'fixture',
    definition: stand.adapter.externalCli(),
    configuredBin: stand.config.fixtureBin,
    home: stand.home,
    env: { PATH: path.dirname(stand.alias) },
  });

  stand.config.fixtureBin = path.join(stand.home, 'manual/fixture');

  await assert.rejects(stand.service.prepareLifecycle('fixture', 'uninstall', 'owner',
    inventory.selectedId), (error) => error.code === 'cli_selection_conflict');
  assert.equal(await fs.lstat(stand.root).then(() => true), true);
});

test('native preview отказывает при чужой сохранённой привязке и чужой записи в root', async (t) => {
  for (const change of ['env-file', 'permissions']) {
    await t.test(change, async (scenario) => {
      const stand = await fixture(scenario, { native: true, pinned: true });

      if (change === 'env-file') {
        await fs.writeFile(stand.config.envPath, 'FIXTURE_BIN=/other/fixture\n');
      } else {
        await fs.chmod(stand.root, 0o777);
      }

      await assert.rejects(stand.service.prepareLifecycle('fixture', 'uninstall', 'owner'),
        (error) => error.code === (change === 'env-file'
          ? 'cli_selection_conflict' : 'native_ownership_unverified'));
      assert.equal(await fs.lstat(stand.alias).then(() => true), true);
    });
  }
});

test('native uninstall/update отклоняют чужой uid и чужую запись на prepare и start', async (t) => {
  for (const phase of ['prepare', 'start']) {
    for (const location of ['parent', 'root', 'directory', 'file', 'entry']) {
      const operation = location === 'file' || location === 'entry' ? 'update' : 'uninstall';

      for (const change of ['world-write', 'foreign-group', 'foreign-uid']) {
        await t.test(`${operation}: ${phase}: ${location}: ${change}`, async (scenario) => {
          const stand = await fixture(scenario, { native: true, pinned: true });
          const directory = path.join(stand.root, 'resources');
          const file = path.join(directory, 'data');

          await fs.mkdir(directory);
          await fs.writeFile(file, 'fixture data');

          const targets = {
            parent: path.dirname(stand.root),
            root: stand.root,
            directory,
            file,
            entry: stand.alias,
          };
          const target = targets[location];
          const preview = phase === 'start'
            ? await stand.service.prepareLifecycle('fixture', operation, 'owner') : null;

          await fs.chmod(target, change === 'world-write' ? 0o777
            : change === 'foreign-group' ? 0o775 : 0o755);

          if (change !== 'world-write') {
            const lstat = fs.lstat.bind(fs);

            // Чужие uid/gid моделируются только в метаданных выбранного пути:
            // тест не требует root и не меняет владельцев реальных файлов машины.
            scenario.mock.method(fs, 'lstat', async (...args) => {
              const stat = await lstat(...args);

              if (args[0] === target) {
                if (change === 'foreign-group') {
                  stat.gid = process.getgid() + 1;
                } else {
                  stat.uid = process.getuid() + 1;
                }
              }

              return stat;
            });
          }

          await assert.rejects(preview
            ? stand.service.startLifecycle('fixture', operation, preview.token, 'owner')
            : stand.service.prepareLifecycle('fixture', operation, 'owner'), (error) => {
            assert.equal(error.statusCode, 409);
            assert.equal(error.code, 'native_ownership_unverified');
            assert.ok(error.message.includes(target));

            return true;
          });
          assert.equal(await fs.lstat(stand.alias).then(() => true), true);
          assert.equal(stand.mutations.length, 0);
          assert.equal((await stand.service.currentLifecycle()).active, null);
        });
      }
    }
  }
});

test('native допускает чужую группу без права записи', async (t) => {
  const stand = await fixture(t, { native: true, pinned: true });
  const lstat = fs.lstat.bind(fs);

  await fs.chmod(stand.root, 0o755);
  t.mock.method(fs, 'lstat', async (...args) => {
    const stat = await lstat(...args);

    if (args[0] === stand.root || args[0] === stand.alias) {
      stat.gid = process.getgid() + 1;
    }

    return stat;
  });

  const preview = await stand.service.prepareLifecycle('fixture', 'uninstall', 'owner');
  const started = await stand.service.startLifecycle('fixture', 'uninstall', preview.token, 'owner');

  assert.equal((await started.completion).ok, true);
});

test('native uninstall сохраняет внешние цели ссылок и удаляет повреждённый CLI без версии', async (t) => {
  const stand = await fixture(t, { native: true, unverifiedVersion: true });
  const external = path.join(stand.home, 'credentials.json');

  await fs.writeFile(external, 'fixture auth');
  await fs.symlink(external, path.join(stand.root, 'foreign-link'));

  const preview = await stand.service.prepareLifecycle('fixture', 'uninstall', 'owner');

  assert.equal(preview.fromVersion, null);

  const started = await stand.service.startLifecycle('fixture', 'uninstall', preview.token, 'owner');

  assert.equal((await started.completion).ok, true);
  assert.equal(await fs.readFile(external, 'utf8'), 'fixture auth');
});

test('native uninstall удаляет объявленный внешний launcher, сохраняя соседние программы', async (t) => {
  const stand = await fixture(t, { native: true, externalAlias: true });
  const neighbor = path.join(path.dirname(stand.alias), 'other-program');

  await fs.writeFile(neighbor, 'fixture other program');

  const preview = await stand.service.prepareLifecycle('fixture', 'uninstall', 'owner');
  const started = await stand.service.startLifecycle('fixture', 'uninstall', preview.token, 'owner');

  assert.equal((await started.completion).ok, true);
  assert.equal(await fs.lstat(stand.alias).then(() => true, () => false), false);
  assert.equal(await fs.lstat(stand.root).then(() => true, () => false), false);
  assert.equal(await fs.readFile(neighbor, 'utf8'), 'fixture other program');
});

test('native update не объявляет успех, если installer оставил прежнюю версию', async (t) => {
  const stand = await fixture(t, {
    native: true,
    pinned: true,
    stale: true,
  });
  const preview = await stand.service.prepareLifecycle('fixture', 'update', 'owner');
  const started = await stand.service.startLifecycle('fixture', 'update', preview.token, 'owner');

  assert.equal((await started.completion).ok, false);
  assert.equal((await stand.service.currentLifecycle()).recent.fixture.error.code, 'version_unverified');
});

test('удаление снимает сохранённую привязку и сохраняет другие копии и данные пользователя', async (t) => {
  const stand = await fixture(t, { pinned: true });
  const remaining = path.join(stand.home, 'remaining');
  const credentials = path.join(stand.home, '.claude/credentials.json');

  await stand.materialize(remaining);
  await fs.mkdir(path.dirname(credentials));
  await fs.writeFile(credentials, 'fixture-data');
  await fs.appendFile(path.join(stand.home, '.bashrc'), `export PATH="$PATH:${remaining}/bin"\n`);
  stand.adapter.probe = async (config) => ({
    ok: config.fixtureBin === 'fixture'
      && await fs.stat(path.join(remaining, 'bin/fixture')).then((stat) => stat.isFile()),
    version: '1.0.0',
  });

  const prepared = await stand.service.prepareLifecycle('fixture', 'uninstall', 'owner');

  assert.ok(prepared.footprint.some((item) =>
    item.path === stand.config.envPath && item.action === 'replace'));

  const started = await stand.service.startLifecycle('fixture', 'uninstall', prepared.token, 'owner');

  assert.equal((await started.completion).ok, true);
  assert.equal(stand.config.fixtureBin, 'fixture');
  assert.equal(stand.env.FIXTURE_BIN, undefined);
  assert.deepEqual(await readEnvFile(stand.config.envPath), { KEEP: 'value' });
  assert.deepEqual(stand.refreshes, ['registry', 'models']);
  assert.deepEqual(stand.invalidations, [['fixture', { removed: false }]]);
  assert.equal(await fs.readFile(credentials, 'utf8'), 'fixture-data');

  const inventory = await discoverExternalCli({
    providerId: 'fixture',
    definition: stand.adapter.externalCli(),
    configuredBin: stand.config.fixtureBin,
    home: stand.home,
    env: { PATH: `${stand.prefix}/bin:${remaining}/bin` },
  });

  assert.equal(inventory.installations.length, 1);
  assert.equal(inventory.installations[0].prefix, remaining);
  assert.equal(inventory.selectedId, inventory.terminalId);
  assert.equal(inventory.conflict, false);
});

test('установка после удаления прежнего пути использует оставшуюся npm-копию', async (t) => {
  const stand = await fixture(t, { pinned: true, legacy: true });
  const missing = path.join(stand.home, 'removed/bin/fixture');

  stand.config.fixtureBin = missing;
  stand.env.FIXTURE_BIN = missing;
  await fs.writeFile(stand.config.envPath, `KEEP=value\nFIXTURE_BIN=${missing}\n`);

  const prepared = await stand.service.prepareLifecycle('fixture', 'install', 'owner');

  assert.equal(prepared.prefix, stand.installedPrefix);
  assert.notEqual(prepared.prefix, stand.prefix, 'пакет остаётся в своём prefix, без массового переноса');
  assert.equal(prepared.fromVersion, '1.0.0');
  assert.ok(prepared.footprint.some((item) => item.path === stand.root && item.action === 'replace'));
  assert.ok(prepared.footprint.some((item) => item.path === stand.config.envPath));
  assert.equal(stand.config.fixtureBin, missing, 'prepare не меняет настройки');

  const started = await stand.service.startLifecycle('fixture', 'install', prepared.token, 'owner');

  assert.equal((await started.completion).ok, true);
  assert.equal(stand.config.fixtureBin, 'fixture');
  assert.equal(stand.env.FIXTURE_BIN, undefined);
  assert.deepEqual(await readEnvFile(stand.config.envPath), { KEEP: 'value' });
  assert.equal((await stand.service.currentLifecycle()).recent.fixture.outcome, 'installed');
  assert.equal(stand.mutations.length, 1);
});

test('две существующие копии дают точную причину конфликта без изменения файлов', async (t) => {
  const stand = await fixture(t, { pinned: true });
  const other = path.join(stand.home, 'other');

  await stand.materialize(other);
  await fs.appendFile(path.join(stand.home, '.bashrc'), `export PATH="${other}/bin:$PATH"\n`);
  await assert.rejects(stand.service.prepareLifecycle('fixture', 'install', 'owner'),
    { code: 'cli_selection_conflict' });
  assert.equal(stand.mutations.length, 0);
  assert.equal(stand.config.fixtureBin, stand.alias);
});

test('установка после удаления последней копии восстанавливает обычный npm-prefix', async (t) => {
  const stand = await fixture(t, { pinned: true });

  await fs.rm(stand.root, { recursive: true });
  await fs.unlink(stand.alias);

  const prepared = await stand.service.prepareLifecycle('fixture', 'install', 'owner');

  assert.equal(prepared.fromVersion, null);
  assert.equal(prepared.prefix, stand.prefix);

  const started = await stand.service.startLifecycle('fixture', 'install', prepared.token, 'owner');

  assert.equal((await started.completion).ok, true);
  assert.equal(stand.config.fixtureBin, 'fixture');
  assert.equal(await fs.readFile(path.join(stand.root, 'cli.js'), 'utf8'), '#!/bin/sh\necho 1.0.0\n');
  assert.deepEqual(await readEnvFile(stand.config.envPath), { KEEP: 'value' });
});

test('возвращённый после preview прежний файл запрещает установку до npm', async (t) => {
  const stand = await fixture(t, { pinned: true });
  const missing = path.join(stand.home, 'removed-fixture');

  stand.config.fixtureBin = missing;
  stand.env.FIXTURE_BIN = missing;
  await fs.writeFile(stand.config.envPath, `FIXTURE_BIN=${missing}\n`);

  const prepared = await stand.service.prepareLifecycle('fixture', 'install', 'owner');

  await fs.writeFile(missing, 'new-user-file');
  await assert.rejects(stand.service.startLifecycle('fixture', 'install', prepared.token, 'owner'),
    { code: 'preparation_changed' });
  assert.equal(stand.mutations.length, 0);
  assert.equal(await fs.readFile(missing, 'utf8'), 'new-user-file');
});

test('новая привязка во время удаления не стирается', async (t) => {
  const stand = await fixture(t, { pinned: true });
  const prepared = await stand.service.prepareLifecycle('fixture', 'uninstall', 'owner');
  const replacement = path.join(stand.home, 'chosen/bin/fixture');
  let release;

  stand.hold(new Promise((resolve) => {
    release = resolve;
  }));
  t.after(() => release());

  const started = await stand.service.startLifecycle('fixture', 'uninstall', prepared.token, 'owner');

  stand.config.fixtureBin = replacement;
  stand.env.FIXTURE_BIN = replacement;
  await fs.writeFile(stand.config.envPath, `FIXTURE_BIN=${replacement}\n`);

  release();

  assert.equal((await started.completion).ok, true);
  assert.equal(stand.config.fixtureBin, replacement);
  assert.equal(stand.env.FIXTURE_BIN, replacement);
  assert.equal((await readEnvFile(stand.config.envPath)).FIXTURE_BIN, replacement);
});

test('конфликт файла привязки сохраняется и разрешается без повторного удаления', async (t) => {
  const stand = await fixture(t, { pinned: true });
  const prepared = await stand.service.prepareLifecycle('fixture', 'uninstall', 'owner');

  await fs.writeFile(stand.config.envPath, 'FIXTURE_BIN=/new/fixture\n');

  const started = await stand.service.startLifecycle('fixture', 'uninstall', prepared.token, 'owner');

  assert.equal((await started.completion).ok, false);
  assert.equal((await stand.service.currentLifecycle()).recent.fixture.error.code, 'npm_binding_failed');

  const state = await readInstallState(path.join(stand.data, 'state.json'));

  assert.equal(state.lifecycleRecovery.removedBinding.value, stand.alias);
  assert.equal((await readEnvFile(stand.config.envPath)).FIXTURE_BIN, '/new/fixture');
  await fs.writeFile(stand.config.envPath, `FIXTURE_BIN=${stand.alias}\n`);
  await stand.service.resolveLifecycleRecovery();
  assert.equal(stand.config.fixtureBin, 'fixture');
  assert.equal((await readEnvFile(stand.config.envPath)).FIXTURE_BIN, undefined);
  assert.equal(stand.mutations.length, 1);
});

test('переустановка проходит, когда два Bash выбирают разные ссылки на один CLI', async (t) => {
  const stand = await fixture(t);
  const aliases = path.join(stand.home, 'login-bin');

  await fs.mkdir(aliases);
  await fs.symlink(stand.alias, path.join(aliases, 'fixture'));
  await fs.appendFile(path.join(stand.home, '.bash_profile'), `export PATH="${aliases}:$PATH"\n`);

  const prepared = await stand.service.prepareLifecycle('fixture', 'reinstall', 'owner');

  assert.equal(prepared.operation, 'reinstall');
  assert.equal(prepared.targetVersion, '1.0.0');
  assert.equal(stand.mutations.length, 0);

  const started = await stand.service.startLifecycle('fixture', 'reinstall', prepared.token, 'owner');
  const result = await started.completion;

  assert.equal(result.ok, true);
  assert.equal((await stand.service.currentLifecycle()).recent.fixture.outcome, 'reinstalled');
  assert.equal(stand.mutations.length, 1);
  assert.equal(await fs.realpath(path.join(aliases, 'fixture')), await fs.realpath(stand.alias));
});

test('v2 scope, shared lease и одноразовый token запрещают запись до admission', async (t) => {
  const { service, data, mutations } = await fixture(t);
  const prepared = await service.prepareLifecycle('fixture', 'uninstall', 'owner');

  await assert.rejects(service.startLifecycle('fixture', 'uninstall', prepared.token, 'stranger'),
    { code: 'preparation_invalid' });

  const record = service.lifecyclePreparations.get(prepared.token);
  const reader = await acquireCliLease({
    directory: path.join(data, 'provider-cli-leases'),
    providerId: 'fixture',
    resourceKey: record.prepared.resourceKey,
    mode: 'reader',
  });

  await assert.rejects(service.startLifecycle('fixture', 'uninstall', prepared.token, 'owner'),
    { code: 'provider_in_use' });
  assert.equal(mutations.length, 0);
  await reader.release();
  await assert.rejects(service.startLifecycle('fixture', 'uninstall', prepared.token, 'owner'),
    { code: 'preparation_invalid' });
});

test('удаление имеет общий lock, v1 maintenance, v2 итог и invalidation после release', async (t) => {
  const stand = await fixture(t);
  const prepared = await stand.service.prepareLifecycle('fixture', 'uninstall', 'owner');
  let release;

  stand.hold(new Promise((resolve) => {
    release = resolve;
  }));

  const started = await stand.service.startLifecycle('fixture', 'uninstall', prepared.token, 'owner');

  assert.equal(isProviderLifecycleSnapshot(started.snapshot), true);
  assert.equal(isProviderInstallSnapshot(await stand.service.current()), true);
  assert.equal((await stand.service.current()).blockedReason.code, 'maintenance');
  await assert.rejects(stand.service.start('other', 'install'), { code: 'busy' });
  release();

  const result = await started.completion;

  assert.equal(result.ok, true);
  assert.equal((await stand.service.currentLifecycle()).recent.fixture.outcome, 'uninstalled');
  assert.equal((await stand.service.current()).recent.fixture, undefined);
  assert.deepEqual(stand.invalidations, [['fixture', { removed: true }]]);
  assert.equal(stand.events.every(isProviderInstallSnapshot), true);
});
