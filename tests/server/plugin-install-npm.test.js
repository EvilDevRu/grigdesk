import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createNpmRunner, prepareNpmDependencies } from '../../server/src/lib/packageInstall/npm.ts';
import { runCommand } from '../../server/src/lib/packageInstall/runCommand.ts';

const success = {
  code: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  stdout: 'fixture',
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
  workspaceLimitExceeded: false,
};

/**
 * npm fixture не использует домашний config или кэш разработчика.
 * Шпион получает уже созданные приватные config и может проверить их содержимое.
 */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-npm-'));
  const cwd = path.join(root, 'package');

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(cwd);
  await writeFile(path.join(cwd, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
  await writeFile(path.join(cwd, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"":{}}}');

  return cwd;
}

test('N1: доверенный npm, ci flags, разные private configs, cache, prefix, signal и timeout', async (t) => {
  const root = await fixture(t);
  const signal = new AbortController().signal;
  let calls = 0;
  const run = createNpmRunner(async (file, args, options) => {
    calls += 1;
    assert.equal(file, path.join(path.dirname(process.execPath), 'npm'));
    assert.ok(path.isAbsolute(file));

    for (const flag of ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
      '--registry=https://registry.npmjs.org/', '--update-notifier=false', `--prefix=${root}`]) {
      assert.ok(args.includes(flag), flag);
    }

    const user = args.find((arg) => arg.startsWith('--userconfig='))?.split('=').slice(1).join('=');
    const global = args.find((arg) => arg.startsWith('--globalconfig='))?.split('=').slice(1).join('=');
    const cache = args.find((arg) => arg.startsWith('--cache='))?.slice('--cache='.length);

    assert.ok(user && global && cache);
    assert.notEqual(user, global);
    assert.equal(await readFile(user, 'utf8'), '');
    assert.equal(await readFile(global, 'utf8'), '');
    assert.equal((await lstat(user)).mode & 0o777, 0o600);
    assert.equal(options.timeoutMs, 600_000);
    assert.equal(options.signal, signal);
    assert.equal(options.cwd, root);
    assert.equal(options.env.PATH, `${path.dirname(process.execPath)}:/usr/bin:/bin`);
    assert.equal(options.env.PATH.includes('node_modules'), false);

    return success;
  });

  await run(root, signal);
  assert.equal(calls, 1);
});

test('N2: результат и flags сохраняются, общий budget один для всех cwd', async (t) => {
  const root = await fixture(t);
  const budget = {
    root: path.dirname(root),
    maxBytes: 4096,
    minFreeBytes: 0,
    checkIntervalMs: 10,
  };
  const results = [
    {
      ...success,
      code: 7,
      timedOut: true,
      stdoutTruncated: true,
      stderrTruncated: true,
    },
    {
      ...success,
      code: 130,
      aborted: true,
    },
    {
      ...success,
      workspaceLimitExceeded: true,
      code: 1,
    },
  ];
  let call = 0;
  const runner = createNpmRunner(async (_file, _args, options) => {
    assert.equal(options.workspaceBudget, budget);

    return results[call++];
  });

  await mkdir(path.join(root, 'browser'));
  await writeFile(path.join(root, 'browser/package.json'), '{"name":"fixture","version":"1.0.0"}');
  await writeFile(path.join(root, 'browser/package-lock.json'), '{"lockfileVersion":3,"packages":{"":{}}}');

  assert.equal(await runner(root, undefined, budget), results[0]);
  assert.equal(await runner(path.join(root, 'browser'), undefined, budget), results[1]);
  await assert.rejects(runner(root, undefined, budget), { code: 'workspace_limit' });
});

test('N3: настоящий worker не наследует импорт, Git/npm overrides и fixture-secret', async (t) => {
  const root = await fixture(t);
  const marker = path.join(root, 'import-marker');
  const poison = path.join(root, 'poison.mjs');
  const fixtureEnv = {
    NODE_OPTIONS: `--import=${pathToFileURL(poison).href}`,
    NODE_PATH: root,
    npm_config_git: './wrapper',
    NPM_CONFIG_REGISTRY: 'https://evil.example',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.sshCommand',
    GIT_CONFIG_VALUE_0: './wrapper',
    GRIGDESK_INTERNAL_TOKEN: 'fixture-secret',
    OPENAI_API_KEY: 'fixture-secret',
    PATH: `${root}/node_modules/.bin`,
  };

  await writeFile(poison,
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed');`);

  const runner = createNpmRunner(async (_file, _args, options) => runCommand(process.execPath, [
    '--input-type=module',
    '--eval',
    'process.stdout.write(JSON.stringify(Object.keys(process.env).filter('
      + '(key) => /^(NODE_|npm_config_|NPM_CONFIG_|GIT_|GRIGDESK_|OPENAI_)/.test(key))));',
  ], options), { baseEnv: fixtureEnv });
  const result = await runner(root);

  assert.equal(await lstat(marker).catch(() => null), null, 'импорт не исполнился');
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), []);
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
});

test('N5: .npmrc с wrapper и опасный dependency отвергнуты до npm spawn', async (t) => {
  const root = await fixture(t);
  const marker = path.join(root, 'wrapper-marker');
  let calls = 0;
  const runner = createNpmRunner(async () => {
    calls += 1;

    return success;
  });

  await writeFile(path.join(root, 'wrapper'), `#!/bin/sh\ntouch ${marker}\nexec /usr/bin/git "$@"\n`, {
    mode: 0o755,
  });
  await writeFile(path.join(root, '.npmrc'), 'git=./wrapper\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    dependencies: { synthetic: 'git+https://fixture.example/repo' },
  }));

  await assert.rejects(runner(root), { code: 'package_unsupported' });
  assert.equal(calls, 0);
  assert.equal(await lstat(marker).catch(() => null), null);
  await rm(path.join(root, '.npmrc'));

  for (const spec of ['file:../x', 'link:../x', 'workspace:*', 'https://evil.example/archive.tgz']) {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { synthetic: spec } }));
    await assert.rejects(runner(root), { code: 'package_unsupported' });
  }

  await writeFile(path.join(root, 'package.json'), '{"name":"fixture"}');

  for (const flag of [{ dev: true }, { optional: true }, {}]) {
    await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/synthetic': {
          version: '1.0.0',
          resolved: 'https://evil.example/archive.tgz',
          integrity: 'sha512-YQ==',
          ...flag,
        },
      },
    }));
    await assert.rejects(runner(root), { code: 'package_unsupported' });
  }

  assert.equal(calls, 0);
});

test('N7: post-npm изменения и внешние links не проходят подготовку, quota проверяется процессом',
  async (t) => {
    for (const variant of ['manifest', 'external']) {
      const cwd = await fixture(t);

      await writeFile(path.join(cwd, 'plugin.json'), '{"id":"demo","version":"1.0.0"}');

      const npm = async () => {
        if (variant === 'manifest') {
          await writeFile(path.join(cwd, 'plugin.json'), '{"id":"other","version":"1.0.0"}');
        } else {
          await mkdir(path.join(cwd, 'node_modules'));
          await symlink('../../outside', path.join(cwd, 'node_modules/external'));
        }

        return success;
      };

      await assert.rejects(prepareNpmDependencies(cwd, ['.'], npm), (error) => {
        assert.ok(['preview_stale', 'symlink_forbidden'].includes(error.code));

        return true;
      });
    }

    const cwd = await fixture(t);
    const budget = {
      root: path.dirname(cwd),
      maxBytes: 4096,
      minFreeBytes: 0,
      checkIntervalMs: 10,
    };
    const npm = createNpmRunner(async (_file, _args, options) => runCommand(process.execPath, [
      '--input-type=module',
      '--eval',
      'import fs from "node:fs"; fs.writeFileSync("oversized", Buffer.alloc(16384));'
        + 'setInterval(() => {}, 100);',
    ], options));

    await assert.rejects(prepareNpmDependencies(cwd, ['.'], npm, undefined, budget), {
      code: 'workspace_limit',
    });
  });
