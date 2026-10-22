import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { deepSeekPackagePaths } from '../../deepseek/scripts/paths.ts';
import { sha256 } from '../../shared/node/hash.ts';
import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { testDeepSeekRuntimeDependencies } from '../helpers/deepseekBinary.mts';

const ENVIRONMENT = [
  'GRIGDESK_DEEPSEEK_NODE_CACHE',
  'GRIGDESK_TEST_DEEPSEEK_ROOT',
  'GRIGDESK_ARTIFACTS_DIR',
] as const;

/**
 * Каждый сценарий выбирает cache независимо от внешнего прогона и возвращает окружение.
 * Никакие файлы настоящей подготовки или legacy prefix не изменяются.
 */
async function fixture(t: TestContext): Promise<string> {
  const artifacts = artifactsPath({ env: process.env, home: os.homedir() });

  await fs.mkdir(artifacts, { recursive: true });

  const root = await fs.mkdtemp(path.join(artifacts, 'source-deps-'));
  const saved = ENVIRONMENT.map((name) => [name, process.env[name]] as const);

  t.after(async () => {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }

    await fs.rm(root, { recursive: true, force: true });
  });

  delete process.env.GRIGDESK_DEEPSEEK_NODE_CACHE;
  delete process.env.GRIGDESK_TEST_DEEPSEEK_ROOT;
  process.env.GRIGDESK_ARTIFACTS_DIR = path.join(root, 'artifacts');

  return root;
}

/**
 * Синтетический stamp проверяет делегирование существующему verifier без установки пакетов.
 * Node здесь только файл с хешем: source helper не исполняет worker или native addons.
 */
async function preparedFixture(cache: string): Promise<string> {
  const directory = path.join(cache, 'runtime-deps-node24');
  const node = Buffer.from('synthetic pinned executable\n');
  const paths = deepSeekPackagePaths();
  const pin = JSON.parse(await fs.readFile(path.join(paths.root, 'build/node-runtime.json'), 'utf8'));
  const stamp: Record<string, string> = {
    version: pin.version,
    archiveSha256: pin.sha256,
    abi: '137',
    nodeSha256: sha256(node),
  };

  await fs.mkdir(path.join(cache, 'node-runtime/bin'), { recursive: true });
  await fs.writeFile(path.join(cache, 'node-runtime/bin/node'), node);

  for (const name of ['typescript', 'esbuild']) {
    const compiler = path.join(directory, 'node_modules', name);

    await fs.mkdir(compiler, { recursive: true });
    await fs.writeFile(path.join(compiler, 'package.json'), '{}');
  }

  for (const name of ['package.json', 'package-lock.json']) {
    const bytes = await fs.readFile(path.join(paths.runtimeDependenciesDir, name));

    await fs.writeFile(path.join(directory, name), bytes);
    stamp[name] = sha256(bytes);
  }

  await fs.writeFile(path.join(directory, '.prepared.json'), JSON.stringify(stamp));

  return directory;
}

for (const mode of ['explicit-cache', 'test-root', 'artifacts'] as const) {
  test(`source dependencies выбирают ${mode} по общему binary-контракту`, async (t) => {
    const root = await fixture(t);
    let cache: string;

    if (mode === 'explicit-cache') {
      cache = path.join(root, 'chosen-cache');
      process.env.GRIGDESK_DEEPSEEK_NODE_CACHE = cache;
      process.env.GRIGDESK_TEST_DEEPSEEK_ROOT = path.join(root, 'unused-root');
    } else if (mode === 'test-root') {
      process.env.GRIGDESK_TEST_DEEPSEEK_ROOT = path.join(root, 'test-root');
      cache = path.join(process.env.GRIGDESK_TEST_DEEPSEEK_ROOT, 'node-cache');
    } else {
      cache = path.join(root, 'artifacts/deepseek-binary/node-cache');
    }

    const directory = await preparedFixture(cache);
    const dependencies = await testDeepSeekRuntimeDependencies();

    assert.equal(dependencies.cacheDir, cache);
    assert.equal(dependencies.directory, directory);
    assert.equal(dependencies.node, path.join(cache, 'node-runtime/bin/node'));
    assert.equal(dependencies.abi, '137');
  });
}

test('неподготовленный explicit cache не получает fallback или скрытую подготовку', async (t) => {
  const root = await fixture(t);
  const cache = path.join(root, 'missing-cache');

  process.env.GRIGDESK_TEST_DEEPSEEK_ROOT = path.join(root, 'ready-root');
  await preparedFixture(path.join(process.env.GRIGDESK_TEST_DEEPSEEK_ROOT, 'node-cache'));
  process.env.GRIGDESK_DEEPSEEK_NODE_CACHE = cache;

  await assert.rejects(testDeepSeekRuntimeDependencies(), {
    message: 'Подготовьте dependencies pinned Node: npm --prefix deepseek run prepare:runtime -- '
      + `--node-cache-dir ${cache}`,
  });
  await assert.rejects(fs.stat(cache), { code: 'ENOENT' });
});

for (const broken of ['stamp', 'version', 'archive', 'node', 'package.json', 'package-lock.json',
  'typescript', 'esbuild'] as const) {
  test(`повреждение ${broken} требует явной подготовки без ремонта cache`, async (t) => {
    const root = await fixture(t);
    const cache = path.join(root, 'broken-cache');
    const directory = await preparedFixture(cache);
    const stampFile = path.join(directory, '.prepared.json');
    let changed = stampFile;

    process.env.GRIGDESK_DEEPSEEK_NODE_CACHE = cache;

    if (broken === 'version' || broken === 'archive') {
      const stamp = JSON.parse(await fs.readFile(stampFile, 'utf8'));

      stamp[broken === 'version' ? 'version' : 'archiveSha256'] = 'wrong';
      await fs.writeFile(stampFile, JSON.stringify(stamp));
    } else {
      if (broken === 'node') {
        changed = path.join(cache, 'node-runtime/bin/node');
      } else if (broken === 'package.json' || broken === 'package-lock.json') {
        changed = path.join(directory, broken);
      } else if (broken === 'typescript' || broken === 'esbuild') {
        changed = path.join(directory, 'node_modules', broken, 'package.json');
      }

      if (broken === 'node' || broken === 'package.json' || broken === 'package-lock.json') {
        await fs.writeFile(changed, 'corrupted');
      } else {
        await fs.rm(changed);
      }
    }

    const before = await fs.readFile(changed).catch(() => null);

    await assert.rejects(testDeepSeekRuntimeDependencies(), {
      message: 'Подготовьте dependencies pinned Node: npm --prefix deepseek run prepare:runtime -- '
        + `--node-cache-dir ${cache}`,
    });
    assert.deepEqual(await fs.readFile(changed).catch(() => null), before);
  });
}
