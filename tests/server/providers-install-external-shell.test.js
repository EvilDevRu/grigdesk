import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  installFixture, prepare, startWithToken, current, completed,
} from './helpers/providerInstallFixture.js';
import { runCommand } from '../../server/src/lib/pluginInstall/runCommand.ts';
import { EXTERNAL_BASELINE_PATH } from '../../server/src/lib/providerInstall/npmEnvironment.ts';

/**
 * Release gate требует НАСТОЯЩИЕ внешние Node, npm и Bash: отсутствие не
 * маскируется skip, потому что иначе проверка границы npm ничего не доказывает.
 */
function realCommand(name) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) {
      continue;
    }

    const candidate = path.join(directory, name);

    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`release gate: внешний ${name} обязателен в PATH`);
}

const realNpm = realCommand('npm');
const realNode = realCommand('node');
const realBash = existsSync('/bin/bash') ? '/bin/bash' : realCommand('bash');

/**
 * Стенд изолирован: собственные HOME/prefix/cache/npmrc, локальный пакет и
 * две независимые Bash-формы. Ни реестр, ни аккаунты, ни пакеты владельца не нужны.
 */
async function offlineFixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-external-shell-'));
  const packageName = 'grigdesk-fixture-cli';
  const binName = 'fixture-cli';
  const packageDir = path.join(base, 'package');
  const prefix = options.prefixInHome ? null : path.join(base, 'prefix');
  const roots = {
    dataHome: path.join(base, 'data'),
    installationRoot: path.join(base, 'installation'),
    runtimeRoot: path.join(base, 'runtime'),
  };
  const external = path.join(base, 'external');
  const cache = path.join(base, 'npm-cache');

  t.after(() => fs.rm(base, { recursive: true, force: true }));

  await fs.mkdir(path.join(packageDir, 'bin'), { recursive: true });
  await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({
    name: packageName,
    version: '2.0.0',
    bin: { [binName]: './bin/cli.js' },
  }));
  await fs.writeFile(path.join(packageDir, 'bin', 'cli.js'),
    '#!/usr/bin/env node\nprocess.stdout.write("2.0.0\\n");\n', { mode: 0o755 });

  for (const directory of [external, cache, roots.dataHome, roots.installationRoot,
    roots.runtimeRoot]) {
    await fs.mkdir(directory, { recursive: true });
  }

  await fs.symlink(realNode, path.join(external, 'node'));
  await fs.symlink(realNpm, path.join(external, 'npm'));
  await fs.mkdir(path.join(roots.dataHome, 'state'), { recursive: true });

  const packageId = packageDir;
  const command = `${realNpm} i -g ${packageId} --prefix ${prefix ?? ''}`;
  const binding = {
    packageId,
    binName,
    configKey: 'claudeBin',
    envKey: 'GRIGDESK_CLAUDE_BIN',
  };
  const descriptor = {
    install: {
      executable: 'npm',
      args: ['i', '-g', packageId],
      command,
      fallbackCommand: command,
      npmBinding: binding,
    },
    update: {
      executable: 'npm',
      args: ['i', '-g', packageId],
      command,
      fallbackCommand: command,
      npmBinding: binding,
    },
    loginCommand: `${binName} login`,
    loginArgs: ['login'],
  };
  const npmrc = [
    'fund=false',
    'audit=false',
    `cache=${cache}`,
    options.prefixInHome ? `prefix=${path.join(base, '.local')}` : `prefix=${prefix}`,
    '',
  ].join('\n');
  const fixture = await installFixture(t, {
    installed: true,
    before: '2.0.0',
    descriptor,
    runner: runCommand,
    config: {
      providerInstallStatePath: path.join(base, 'installs', 'state.json'),
      artifactsDir: path.join(base, 'artifacts'),
    },
    env: {
      HOME: base,
      SHELL: realBash,
      PATH: `${external}${path.delimiter}${EXTERNAL_BASELINE_PATH}`,
      npm_config_userconfig: path.join(base, '.npmrc'),
      npm_config_cache: cache,
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      // Защитный prefix прежней политики: сервис обязан его снять.
      npm_config_prefix: path.join(roots.dataHome, 'state', 'npm-global'),
    },
    providerInstall: {
      roots,
      artifactsDir: path.join(base, 'artifacts'),
      bashTimeoutMs: 20_000,
    },
  });

  await fs.writeFile(path.join(base, '.npmrc'), npmrc);
  await fs.writeFile(path.join(base, '.bashrc'), `export PATH="${external}:$PATH"\n`);
  await fs.writeFile(path.join(base, '.bash_profile'), 'source "$HOME/.bashrc"\n');
  fixture.config.envPath = path.join(base, '.env');
  await fs.writeFile(fixture.config.envPath, 'OTHER=value\n');
  fixture.base = base;
  fixture.prefix = options.prefixInHome ? path.join(base, '.local') : prefix;
  fixture.packageDir = packageDir;
  fixture.packageName = packageName;
  fixture.binName = binName;
  fixture.external = external;
  fixture.roots = roots;

  return fixture;
}

const shellEnv = (stand) => ({
  PATH: EXTERNAL_BASELINE_PATH,
  HOME: stand.base,
  SHELL: realBash,
  LANG: 'C.UTF-8',
});

function launch(stand, mode, command) {
  return spawnSync(realBash, [mode === 'login' ? '-lic' : '-ic', command], {
    env: shellEnv(stand),
    encoding: 'utf8',
    timeout: 20_000,
  });
}

/** Снимок неизменного дерева: ни один файл поставки не появляется при установке. */
async function treeState(directory) {
  const entries = await fs.readdir(directory, { recursive: true }).catch(() => []);

  return entries.map(String).sort();
}

test('настоящий npm ставит локальный пакет вне D/I/R, обе Bash формы запускают его', async (t) => {
  const stand = await offlineFixture(t);
  const before = {
    dataHome: await treeState(stand.roots.dataHome),
    installation: await treeState(path.join(stand.base, 'installation')),
    runtime: await treeState(path.join(stand.base, 'runtime')),
  };
  const preparation = (await prepare(stand.app, 'claude', 'update')).json();

  assert.equal(preparation.prefix, stand.prefix);

  const started = await startWithToken(stand.app, preparation.token, 'claude', 'update');

  assert.equal(started.statusCode, 202, started.body);

  const job = (await completed(stand.app)).recent.claude;

  assert.equal(job.status, 'succeeded', `${JSON.stringify(job.error)} ${job.outputTail}`);
  assert.equal(job.terminal.status, 'ready', JSON.stringify(job.terminal));

  const binary = path.join(stand.prefix, 'bin', stand.binName);

  assert.equal(await fs.realpath(binary),
    path.join(stand.packageDir, 'bin', 'cli.js'), 'bin ведёт не в установленный пакет');
  assert.equal((await fs.lstat(path.join(stand.prefix, 'lib', 'node_modules',
    stand.packageName))).isSymbolicLink(), true);
  assert.equal(stand.config.claudeBin, binary);
  assert.match(await fs.readFile(stand.config.envPath, 'utf8'), /GRIGDESK_CLAUDE_BIN=/u);

  const dataPrefix = path.join(stand.base, 'data', 'state', 'npm-global', 'bin', stand.binName);

  await assert.rejects(fs.access(dataPrefix), { code: 'ENOENT' });

  for (const mode of ['interactive', 'login']) {
    const launched = launch(stand, mode, `${stand.binName} --version`);

    assert.equal(launched.status, 0, launched.stderr);
    assert.equal(launched.stdout.trim(), '2.0.0');
  }

  assert.deepEqual(await treeState(path.join(stand.base, 'installation')), before.installation);
  assert.deepEqual(await treeState(path.join(stand.base, 'runtime')), before.runtime);

  const restarted = await current(stand.app);

  assert.equal(restarted.recent.claude.status, 'succeeded');
  assert.equal(stand.config.claudeBin, binary);
});

test('настоящий npm получает legacy bin-link и устраняет EEXIST миграцией', async (t) => {
  const stand = await offlineFixture(t, { prefixInHome: true });
  const dataPackage = path.join(stand.base, 'data', 'state', 'npm-global', 'lib',
    'node_modules', stand.packageName);
  const legacyEntry = path.join(dataPackage, 'bin', 'cli.js');
  const target = path.join(stand.base, '.local', 'bin', stand.binName);

  await fs.mkdir(path.dirname(legacyEntry), { recursive: true });
  await fs.writeFile(path.join(dataPackage, 'package.json'),
    JSON.stringify({ name: stand.packageDir, version: '1.0.0' }));
  await fs.writeFile(legacyEntry,
    '#!/usr/bin/env node\nprocess.stdout.write("1.0.0\\n");\n', { mode: 0o755 });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.symlink(legacyEntry, target);
  stand.config.claudeBin = legacyEntry;

  const preparation = (await prepare(stand.app, 'claude', 'update')).json();

  assert.equal(preparation.prefix, path.join(stand.base, '.local'));

  const started = await startWithToken(stand.app, preparation.token, 'claude', 'update');

  assert.equal(started.statusCode, 202, started.body);

  const job = (await completed(stand.app)).recent.claude;

  assert.equal(job.status, 'succeeded', `${JSON.stringify(job.error)} ${job.outputTail}`);
  assert.deepEqual(job.migration, { from: legacyEntry, to: path.join(stand.prefix, 'bin',
    stand.binName) });

  assert.equal(await fs.realpath(target),
    await fs.realpath(path.join(stand.prefix, 'bin', stand.binName)),
    'npm не заменил ссылку');

  const backups = (await fs.readdir(path.dirname(target)))
    .filter((name) => name.includes('grigdesk-backup'));

  assert.deepEqual(backups, []);

  for (const mode of ['interactive', 'login']) {
    const launched = launch(stand, mode, `${stand.binName} --version`);

    assert.equal(launched.status, 0, launched.stderr);
    assert.equal(launched.stdout.trim(), '2.0.0');
  }
});

test('прежнее защитное окружение действительно ставило пакет в папку данных', async (t) => {
  const stand = await offlineFixture(t);
  const dataPrefix = path.join(stand.base, 'data', 'state', 'npm-global');

  await new Promise((resolve, reject) => {
    execFile(realNpm, ['i', '-g', stand.packageDir, '--prefix', dataPrefix], {
      env: {
        PATH: `${stand.external}${path.delimiter}${EXTERNAL_BASELINE_PATH}`,
        HOME: stand.base,
        npm_config_cache: path.join(stand.base, 'npm-cache'),
        npm_config_userconfig: path.join(stand.base, '.npmrc'),
        npm_config_fund: 'false',
        npm_config_audit: 'false',
      },
      timeout: 120_000,
    }, (error) => error ? reject(error) : resolve());
  });

  assert.equal(await fs.stat(path.join(dataPrefix, 'bin', stand.binName)).then(
    (stat) => stat.isSymbolicLink() || stat.isFile()), true);

  const launched = launch(stand, 'interactive', `${stand.binName} --version`);

  assert.notEqual(launched.status, 0, 'внешняя оболочка нашла копию из папки данных');
});
