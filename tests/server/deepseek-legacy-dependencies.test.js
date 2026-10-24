import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepareLegacyDeepSeekDependencies } from '../helpers/deepseekLegacyDependencies.mts';

/**
 * Установка заменяется маленькими пакетами, но проверку загрузки исполняет настоящий Node.
 * Исходный prefix и кэш разнесены, поэтому видна любая запись helper в дерево исходников.
 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-dependencies-'));
  const sourceDirectory = path.join(root, 'source');
  const artifacts = path.join(root, 'artifacts');
  const installs = [];
  const manifest = {
    private: true,
    dependencies: {
      typescript: '1.0.0',
      esbuild: '1.0.0',
      'node-pty': '1.0.0',
    },
  };
  const lock = {
    lockfileVersion: 3,
    packages: Object.fromEntries(Object.keys(manifest.dependencies).map((name) => [
      `node_modules/${name}`, { version: '1.0.0' },
    ])),
  };

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(sourceDirectory);
  await fs.writeFile(path.join(sourceDirectory, 'package.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(sourceDirectory, 'package-lock.json'), JSON.stringify(lock));

  /**
   * Малые CommonJS-пакеты проходят настоящую проверку загрузки без npm и сети.
   * Их версии берутся из копии lock в staging, а вызовы остаются наблюдаемыми тесту.
   */
  const install = async (directory, npmCache, logFile) => {
    installs.push({
      directory,
      npmCache,
      logFile,
    });

    const selected = JSON.parse(await fs.readFile(path.join(directory, 'package-lock.json'), 'utf8'));

    for (const [name, entry] of Object.entries(selected.packages)) {
      const target = path.join(directory, name);

      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, 'package.json'), JSON.stringify({
        name: path.basename(name),
        version: entry.version,
        main: 'index.cjs',
      }));
      await fs.writeFile(path.join(target, 'index.cjs'), 'module.exports = {};\n');
    }

    await fs.writeFile(logFile, 'fixture install completed\n');
  };
  const options = { sourceDirectory, install };

  return {
    root,
    sourceDirectory,
    artifacts,
    installs,
    manifest,
    lock,
    options,
    prepare: () => prepareLegacyDeepSeekDependencies(artifacts, options),
  };
}

test('чистый запуск сам готовит prefix, повторный не запускает installer', async (t) => {
  const f = await fixture(t);
  const directory = await f.prepare();
  const stamp = JSON.parse(await fs.readFile(path.join(directory, '.prepared.json'), 'utf8'));

  assert.equal(f.installs.length, 1);
  assert.equal(stamp.nodeVersion, process.versions.node);
  assert.equal(stamp.abi, process.versions.modules);
  assert.equal(stamp.platform, process.platform);
  assert.equal(stamp.arch, process.arch);
  assert.ok(directory.startsWith(f.artifacts + path.sep));
  assert.notEqual(f.installs[0].directory, directory, 'npm должен работать в staging');
  assert.equal(await fs.stat(f.installs[0].directory).catch(() => null), null);
  assert.equal(await fs.stat(path.join(f.sourceDirectory, 'node_modules')).catch(() => null), null);
  assert.equal(await f.prepare(), directory);
  assert.equal(f.installs.length, 1, 'Прогретый кэш повторил установку');
});

test('параллельные запуски ждут одну подготовку', async (t) => {
  const f = await fixture(t);
  const directories = await Promise.all([f.prepare(), f.prepare(), f.prepare()]);

  assert.equal(new Set(directories).size, 1);
  assert.equal(f.installs.length, 1);
});

test('новый lock и manifest создают отдельные кэши', async (t) => {
  const f = await fixture(t);
  const original = await f.prepare();

  f.lock.packages['node_modules/esbuild'].version = '2.0.0';
  await fs.writeFile(path.join(f.sourceDirectory, 'package-lock.json'), JSON.stringify(f.lock));

  const changedLock = await f.prepare();

  assert.notEqual(changedLock, original);
  f.manifest.description = 'new build manifest';
  await fs.writeFile(path.join(f.sourceDirectory, 'package.json'), JSON.stringify(f.manifest));

  const changedManifest = await f.prepare();

  assert.notEqual(changedManifest, changedLock);
  assert.equal(f.installs.length, 3);
  assert.ok(await fs.stat(path.join(original, '.prepared.json')));
});

test('чужой ABI, повреждённый пакет и незавершённая установка исправляются автоматически', async (t) => {
  for (const corruption of ['abi', 'package', 'native', 'marker', 'lock']) {
    await t.test(corruption, async (scenario) => {
      const f = await fixture(scenario);
      const directory = await f.prepare();

      if (corruption === 'abi') {
        const file = path.join(directory, '.prepared.json');
        const stamp = JSON.parse(await fs.readFile(file, 'utf8'));

        stamp.abi = 'different-abi';
        await fs.writeFile(file, JSON.stringify(stamp));
      } else if (corruption === 'package') {
        await fs.rm(path.join(directory, 'node_modules/esbuild'), { recursive: true });
      } else if (corruption === 'native') {
        await fs.writeFile(path.join(directory, 'node_modules/node-pty/index.cjs'),
          'throw new Error("NODE_MODULE_VERSION mismatch");\n');
      } else if (corruption === 'marker') {
        await fs.rm(path.join(directory, '.prepared.json'));
      } else {
        await fs.writeFile(path.join(directory, 'package-lock.json'), '{}');
      }

      assert.equal(await f.prepare(), directory);
      assert.equal(f.installs.length, 2);
      assert.equal(await f.prepare(), directory);
      assert.equal(f.installs.length, 2);
    });
  }
});

test('отказ установки не публикует кэш; следующий запуск автоматически повторяет подготовку', async (t) => {
  const f = await fixture(t);
  const install = f.options.install;
  let rejected = false;

  f.options.install = async (...args) => {
    if (!rejected) {
      rejected = true;
      await fs.mkdir(path.join(args[0], 'node_modules'));

      throw new Error('ECONNRESET fixture');
    }

    await install(...args);
  };

  await assert.rejects(f.prepare(), /Автоподготовка.*теста миграции.*журнал/u);

  const parent = path.join(f.artifacts, 'deepseek-vendoring/legacy-dependencies');
  const entries = await fs.readdir(parent);
  const logs = entries.filter((name) => name.endsWith('.log'));

  assert.equal(entries.length, 1, 'Отказ оставил lock или staging');
  assert.equal(logs.length, 1);
  assert.match(await fs.readFile(path.join(parent, logs[0]), 'utf8'), /ECONNRESET/u);

  const directory = await f.prepare();

  assert.ok(await fs.stat(path.join(directory, '.prepared.json')));
  assert.equal(f.installs.length, 1);
});
