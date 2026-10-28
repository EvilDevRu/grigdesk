import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { artifactsPath } from '../../shared/runtime/dataHome.ts';

import {
  prepareNpmStrategy, revalidateNpmStrategy, executeNpmStrategy,
} from '../../server/src/lib/providerInstall/npmStrategy.ts';

const base = path.join(artifactsPath({ env: process.env, home: os.homedir() }),
  'external-cli-lifecycle/npm-fixtures');
const result = (stdout = '') => ({
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
 * Поддельный transport меняет только изолированный prefix штатной формы npm.
 * Поведение repair проверяет файлы зависимости, а не последовательность внутренних вызовов.
 */
async function fixture(t, operation = 'reinstall') {
  await fs.mkdir(base, { recursive: true });

  const directory = await fs.mkdtemp(path.join(base, 'case-'));
  const prefix = path.join(directory, 'user');
  const root = path.join(prefix, 'lib/node_modules/@fixture/cli');
  const alias = path.join(prefix, 'bin/fixture');
  const node = path.join(directory, 'node');
  const npm = path.join(directory, 'npm');

  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(node, 'node');
  await fs.writeFile(npm, 'npm');

  /**
   * Materialize кладёт только fixture-пакет в изолированный prefix.
   * Никаких пользовательских файлов за пределами temporary directory.
   */
  async function install(target) {
    const targetRoot = path.join(target, 'lib/node_modules/@fixture/cli');

    await fs.mkdir(targetRoot, { recursive: true });
    await fs.writeFile(path.join(targetRoot, 'package.json'), JSON.stringify({
      name: '@fixture/cli',
      version: '1.2.3',
      bin: { fixture: 'cli.js' },
    }));
    await fs.writeFile(path.join(targetRoot, 'cli.js'), 'ok');
    await fs.writeFile(path.join(targetRoot, 'dependency.js'), 'intact');
    await fs.mkdir(path.join(target, 'bin'), { recursive: true });
    await fs.symlink('../lib/node_modules/@fixture/cli/cli.js', path.join(target, 'bin/fixture'))
      .catch((error) => {
        if (error.code !== 'EEXIST') {
          throw error;
        }
      });
  }

  await install(prefix);

  const calls = [];
  const input = {
    providerId: 'fixture',
    operation,
    definition: {
      packageId: '@fixture/cli',
      binName: 'fixture',
      configKey: 'fixtureBin',
      envKey: 'FIXTURE_BIN',
    },
    selected: {
      source: 'npm',
      root,
      prefix,
      version: '1.2.3',
      path: alias,
      aliases: [alias],
      resourceKey: 'a'.repeat(64),
      installationId: 'b'.repeat(64),
      state: 'ready',
    },
    runtime: {
      node,
      npm,
      home: directory,
      env: { HOME: directory, PATH: path.join(prefix, 'bin') },
    },
    prefix,
    version: '1.2.3',
    scratch: path.join(directory, 'scratch'),
    /**
     * Транспорт имитирует только файловые эффекты npm в изолированной папке.
     * Различие install/uninstall проверяется по состоянию prefix, не по argv.
     */
    async run(file, args) {
      calls.push([file, ...args]);

      if (file === alias) {
        return result('fixture 1.2.3');
      }
      if (args[1] === 'view') {
        return result(JSON.stringify('sha512-Zml4dHVyZQ=='));
      }

      const target = args[args.indexOf('--prefix') + 1];

      if (args[1] === 'uninstall') {
        await fs.rm(root, { recursive: true });
        await fs.unlink(alias);
      } else {
        if (target === prefix) {
          assert.equal(await fs.stat(path.join(root, 'corrupt-only')).then(() => true, () => false), false);
        }

        await install(target);
      }

      return result();
    },
  };

  return {
    input,
    root,
    alias,
    directory,
    calls,
  };
}

test('repair сохраняет версию, восстанавливает dependency и оставляет backup до postcheck', async (t) => {
  const { input, root, directory, calls } = await fixture(t);

  await fs.writeFile(path.join(root, 'dependency.js'), 'corrupt');
  await fs.writeFile(path.join(root, 'corrupt-only'), 'garbage');
  await fs.writeFile(path.join(directory, 'credentials'), 'canary');

  const prepared = await prepareNpmStrategy(input);

  await revalidateNpmStrategy(prepared);
  await executeNpmStrategy(prepared, { async phase() {} });
  assert.equal(await fs.readFile(path.join(root, 'dependency.js'), 'utf8'), 'intact');
  assert.equal(await fs.readFile(path.join(prepared.backup, 'dependency.js'), 'utf8'), 'corrupt');
  assert.equal(await fs.readFile(path.join(directory, 'credentials'), 'utf8'), 'canary');
  assert.equal(calls.some((call) => call.includes('--offline') && !call.includes('--ignore-scripts')), true);
});

test('изменение dependency после preview запрещает start до npm', async (t) => {
  const { input, root, calls } = await fixture(t);
  const prepared = await prepareNpmStrategy(input);
  const before = calls.length;

  await fs.writeFile(path.join(root, 'dependency.js'), 'changed-after-preview');
  await assert.rejects(revalidateNpmStrategy(prepared), { code: 'preparation_changed' });
  assert.equal(calls.length, before);
});

test('uninstall удаляет только выбранный пакет и оставляет canary HOME', async (t) => {
  const { input, root, directory } = await fixture(t, 'uninstall');

  await fs.writeFile(path.join(directory, 'auth'), 'canary');

  const prepared = await prepareNpmStrategy(input);

  await revalidateNpmStrategy(prepared);
  await executeNpmStrategy(prepared, { async phase() {} });
  assert.equal(await fs.stat(root).then(() => true, () => false), false);
  assert.equal(await fs.readFile(path.join(directory, 'auth'), 'utf8'), 'canary');
});

test('offline-прогон перед mutation замечает изменившийся dependency graph', async (t) => {
  const { input } = await fixture(t);
  const prepared = await prepareNpmStrategy(input);
  const original = input.run;

  input.run = async (file, args) => {
    const value = await original(file, args);
    const target = args[args.indexOf('--prefix') + 1] ?? '';
    const targetRoot = path.join(target, 'lib/node_modules/@fixture/cli');

    if (target.includes('rehearsal') && await fs.stat(targetRoot).then(() => true, () => false)) {
      await fs.mkdir(path.join(targetRoot, 'node_modules/@fixture/new'), { recursive: true });
      await fs.writeFile(path.join(targetRoot, 'node_modules/@fixture/new/package.json'),
        JSON.stringify({ name: '@fixture/new', version: '9.9.9' }));
    }

    return value;
  };

  await assert.rejects(revalidateNpmStrategy(prepared), { code: 'npm_graph_changed' });
});
