import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { ProviderInstallService } from '../../../../server/src/lib/providerInstall/service.ts';
import { inspectNpmGraph } from '../../../../server/src/lib/providerInstall/npmGraph.ts';
import { treeSnapshot } from '../../../../server/src/lib/providerInstall/treeSnapshot.ts';
import { discoverExternalCli } from '../../../../server/src/lib/providerInstall/inventory.ts';
import claude from '../../../../server/src/lib/executors/claude.ts';
import codex from '../../../../server/src/lib/executors/codex.ts';
import kimi from '../../../../server/src/lib/executors/kimi.ts';

const execute = promisify(execFile);
const ADAPTERS = {
  claude,
  codex,
  kimi,
};

/**
 * Официальная проверка запускается только по явному manifest.
 * Драйвер отказывает при production HOME/prefix и при путях вне своего fixture root.
 */
async function readManifest() {
  const file = process.env.GRIGDESK_CLI_SMOKE_MANIFEST;

  if (!file || !path.isAbsolute(file)) {
    throw new Error('Не задан GRIGDESK_CLI_SMOKE_MANIFEST');
  }

  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  const root = path.resolve(String(manifest.root ?? ''));
  const home = path.resolve(os.homedir());

  if (!path.isAbsolute(root) || inside(home, root) || root === home
    || root === '/' || root === path.dirname(home)) {
    throw new Error('Fixture root не изолирован от HOME');
  }
  if (!manifest.packages || !Array.isArray(manifest.platforms) || !manifest.node || !manifest.npm) {
    throw new Error('Manifest неполон');
  }

  return {
    manifest,
    root,
    file,
  };
}

const inside = (file, root) => file === root || file.startsWith(root + path.sep);

/**
 * Изолированный runtime содержит только Node и npm выбранной машины.
 * Реальный nvm bin не попадает в PATH: иначе fixture увидит чужой kimi.
 */
async function makeRuntime(root) {
  const bin = path.join(root, 'runtime/bin');

  await fs.mkdir(bin, { recursive: true });
  await fs.symlink(process.execPath, path.join(bin, 'node'));
  await fs.symlink(await fs.realpath(path.join(path.dirname(process.execPath), 'npm')),
    path.join(bin, 'npm'));

  return bin;
}

/**
 * A/B одного провайдера: Install V1 → Update V2 → повреждение → exact reinstall V2
 * → Uninstall → повторный Install V2. Данные аккаунта и rc побайтно сохраняются.
 */
async function runProvider({ provider, adapter, versions, runtimeBin, root, results }) {
  const cycle = path.join(root, `cycle-${provider}-${Date.now()}`);
  const home = path.join(cycle, 'home');
  const prefix = path.join(cycle, 'prefix');
  const data = path.join(cycle, 'data');
  const env = {
    HOME: home,
    SHELL: '/bin/bash',
    PATH: `${prefix}/bin:${runtimeBin}:/usr/bin:/bin`,
    npm_config_prefix: prefix,
  };

  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(path.join(prefix, 'bin'), { recursive: true });
  await fs.writeFile(path.join(home, '.bashrc'),
    `export PATH="${env.PATH}"\nexport npm_config_prefix="${prefix}"\n`);
  await fs.writeFile(path.join(home, '.bash_profile'), 'source "$HOME/.bashrc"\n');

  for (const directory of ['.claude', '.codex', '.kimi-code']) {
    await fs.mkdir(path.join(home, directory), { recursive: true });
    await fs.writeFile(path.join(home, directory, 'preserve-canary'), 'keep');
  }

  await fs.mkdir(data, { recursive: true });

  const shellHash = await treeSnapshot(path.join(home, '.bashrc'));
  const config = {
    dataHome: data,
    artifactsDir: path.join(cycle, 'artifacts'),
    claudeBin: 'claude',
    codexBin: 'codex',
    kimiBin: 'kimi',
    kimiLaunchMode: 'host',
    envPath: path.join(data, '.env'),
  };

  await fs.writeFile(config.envPath, 'KEEP=canary\n');

  let latest = versions.v1;
  const service = new ProviderInstallService({
    config,
    env,
    statePath: path.join(data, 'install.json'),
    roots: {
      dataHome: data,
      runtimeRoot: path.join(cycle, 'R'),
      installationRoot: path.join(cycle, 'I'),
    },
    adaptersOf: async () => new Map([[adapter.id, adapter]]),
    latestOf: () => latest,
    refreshModels: async () => {},
    invalidate: async () => {},
    broadcast: () => {},
  });
  const definition = adapter.externalCli(config, home);
  const packageRoot = path.join(prefix, 'lib/node_modules', definition.packageId);
  const alias = path.join(prefix, 'bin', definition.binName);

  /**
   * Проверяет физический пакет, graph, запуск по имени и canaries.
   * Текст success от сервиса сам по себе ничего не доказывает.
   */
  async function verify(operation, version) {
    const current = await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8')
      .then((text) => JSON.parse(text));

    assert.equal(current.name, definition.packageId);
    assert.equal(current.version, version);

    const graph = await inspectNpmGraph(packageRoot);

    assert.ok(graph.length >= 1);

    const launched = await execute(alias, ['--version'], { env, timeout: 60_000 });

    assert.match(launched.stdout, new RegExp(version.replaceAll('.', '\\.')));

    for (const directory of ['.claude', '.codex', '.kimi-code']) {
      assert.equal(await fs.readFile(path.join(home, directory, 'preserve-canary'), 'utf8'), 'keep');
    }

    assert.equal(await treeSnapshot(path.join(home, '.bashrc')), shellHash);
    results.push({
      provider,
      operation,
      version,
      outcome: 'verified',
    });
  }

  const plan = [
    ['install', versions.v1],
    ['update', versions.v2],
    ['reinstall', versions.v2],
    ['uninstall', null],
    ['install', versions.v2],
  ];

  for (const [operation, version] of plan) {
    latest = operation === 'install' && results.filter((item) => item.provider === provider
      && item.operation === 'install').length === 0 ? versions.v1 : versions.v2;

    if (operation === 'reinstall') {
      const entry = await fs.realpath(alias);

      await fs.writeFile(entry, 'broken\n');
      await fs.writeFile(path.join(packageRoot, 'corrupt-extra'), 'remove me');
    }

    process.stdout.write(`${provider} ${operation} preparing\n`);

    const preview = await service.prepareLifecycle(adapter.id, operation, 'smoke');

    assert.equal(preview.shellChanges.length, 0);

    const started = await service.startLifecycle(adapter.id, operation, preview.token, 'smoke');
    const done = await started.completion;
    const snapshot = await service.currentLifecycle();

    assert.equal(done.ok, true, JSON.stringify(snapshot.recent[adapter.id]?.error));

    if (operation === 'reinstall') {
      assert.equal(await fs.stat(path.join(packageRoot, 'corrupt-extra')).then(() => true, () => false),
        false, 'повреждённый лишний файл должен исчезнуть');
      assert.notEqual(await fs.readFile(await fs.realpath(alias), 'utf8'), 'broken\n');
    }
    if (operation === 'uninstall') {
      assert.equal(await fs.stat(packageRoot).then(() => true, () => false), false);
      assert.equal(await fs.stat(alias).then(() => true, () => false), false);
      results.push({
        provider,
        operation,
        version: '',
        outcome: 'verified',
      });
    } else {
      await verify(operation, version);
    }

    await fs.writeFile(path.join(root, 'results.json'), JSON.stringify({
      provider,
      version: versions,
      node: process.version,
      results,
    }, null, 2));
  }

  const inventory = await discoverExternalCli({
    providerId: adapter.id,
    definition,
    configuredBin: String(config[definition.configKey] ?? ''),
    env,
    home,
  });
  const terminal = inventory.installations.find((item) =>
    item.installationId === (inventory.selectedId ?? inventory.terminalId));

  assert.equal(terminal?.realpath, await fs.realpath(alias));
  results.push({
    provider,
    operation: 'inventory',
    version: terminal?.version ?? '',
    outcome: 'verified',
  });

  // Повторяет устаревшую абсолютную привязку после удаления другой копии.
  // Обычная установка должна обслужить оставшийся пакет и снять мёртвый путь.
  const missing = path.join(cycle, 'removed/bin', definition.binName);

  config[definition.configKey] = missing;
  env[definition.envKey] = missing;
  await fs.writeFile(config.envPath, `KEEP=canary\n${definition.envKey}=${missing}\n`);
  process.stdout.write(`${provider} stale binding install preparing\n`);

  const preview = await service.prepareLifecycle(adapter.id, 'install', 'smoke');

  assert.equal(preview.prefix, prefix);
  assert.equal(preview.fromVersion, versions.v2);
  assert.equal(config[definition.configKey], missing);

  const started = await service.startLifecycle(adapter.id, 'install', preview.token, 'smoke');
  const done = await started.completion;

  assert.equal(done.ok, true, JSON.stringify((await service.currentLifecycle()).recent[adapter.id]?.error));
  assert.equal(config[definition.configKey], definition.binName);
  assert.equal(env[definition.envKey], undefined);
  assert.equal(await fs.readFile(config.envPath, 'utf8'), 'KEEP=canary\n');
  await verify('install-after-stale-binding', versions.v2);
}

const { manifest, root, file: manifestFile } = await readManifest();
const runtimeBin = await makeRuntime(root);
const results = [];

assert.equal(manifest.platforms.includes(`${process.platform}-${process.arch}`), true,
  `Не подготовлена платформа ${process.platform}-${process.arch}`);

await fs.writeFile(path.join(root, 'started.json'), JSON.stringify({
  manifestFile,
  pid: process.pid,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
}, null, 2));

for (const [provider, versions] of Object.entries(manifest.packages)) {
  const adapter = ADAPTERS[provider];

  if (!adapter) {
    throw new Error(`Неизвестный провайдер ${provider}`);
  }

  await runProvider({
    provider,
    adapter,
    versions,
    runtimeBin,
    root,
    results,
  });
}

await fs.writeFile(path.join(root, 'results.json'), JSON.stringify({
  node: process.version,
  manifest: manifestFile,
  results,
}, null, 2));
process.stdout.write(`official smoke GREEN: ${results.length} checks\n`);
