import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  executeBinaryBuild,
  parseBuildArgs,
  type BinaryBuildOptions,
  type BinaryBuildSteps,
} from '../../deepseek/scripts/buildSteps.mts';
import { sha256 } from '../../shared/node/hash.ts';
import { canonicalJson } from '../../shared/lib/canonicalJson.ts';
import { runtimeInfoFixture } from '../helpers/deepseekMetadataFixture.mts';
import { deepSeekBuildInputs } from '../../deepseek/scripts/buildRuntime.mts';
import { deepSeekPackagePaths } from '../../deepseek/scripts/paths.ts';

/**
 * Подменяются только build-шаги; файловая публикация и проверка hash настоящие.
 * Фикстура никогда не пишет в bin рабочего дерева или кэш установленного runtime.
 */
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'binary build '));
  const options: BinaryBuildOptions = {
    outDir: path.join(root, 'out'),
    nodeCacheDir: path.join(root, 'node-cache'),
    binaryVersion: null,
    payload: null,
  };
  const calls: string[] = [];
  const steps: BinaryBuildSteps = {
    platform: 'linux',
    arch: 'x64',
    runtime: {
      version: '24.21.0',
      platform: 'linux-x64',
      sha256: sha256('synthetic pinned archive'),
    },
    defaultBinaryVersion: '1.0.0',
    download: async (_url, file) => {
      calls.push('download');
      await fs.writeFile(file, 'synthetic pinned archive');
    },
    run: async (command, _args, runOptions) => {
      calls.push(command === 'tar' ? 'extract-node' : 'sea-config');

      if (command === 'tar') {
        await fs.mkdir(path.join(runOptions!.cwd!, 'bin'));
        await fs.writeFile(path.join(runOptions!.cwd!, 'bin/node'), 'candidate-node');
        await fs.writeFile(path.join(runOptions!.cwd!, 'LICENSE'), 'node-license');
      } else {
        await fs.writeFile(path.join(runOptions!.cwd!, 'sea-prep.blob'), 'synthetic-blob');
      }

      return { stdout: '', stderr: '' };
    },
    bundle: async (work) => {
      calls.push('bundle');
      await fs.writeFile(path.join(work, 'bundle.cjs'), 'compiled-launcher');
    },
    prepare: async (work) => {
      calls.push('payload');
      await fs.writeFile(path.join(work, 'payload.zip'), 'synthetic-payload');

      const { packageId: _ignored, ...info } = runtimeInfoFixture();

      return info;
    },
    postject: async () => {
      calls.push('postject');
    },
    smoke: async (_binary, info) => {
      calls.push('smoke');
      assert.equal(info.upstreamVersion, runtimeInfoFixture().upstreamVersion);
    },
  };

  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(options.outDir);
  await fs.writeFile(path.join(options.outDir, 'deepseek'), 'previous-output');

  return {
    root,
    options,
    steps,
    calls,
  };
}

test('build parser разрешает node-cache-dir от cwd и отделяет binaryVersion/payload', () => {
  assert.deepEqual(parseBuildArgs([], '/other/cwd', '/repo/deepseek'), {
    outDir: '/repo/bin',
    nodeCacheDir: '/repo/deepseek/.cache',
    binaryVersion: null,
    payload: null,
  });
  assert.deepEqual(parseBuildArgs([
    '--node-cache-dir', 'relative cache',
    '--out-dir', '/custom/out',
    '--binary-version', '1.2.3-test',
    '--payload', 'payload.zip',
  ], '/build/cwd', '/repo/deepseek'), {
    outDir: '/custom/out',
    nodeCacheDir: '/build/cwd/relative cache',
    binaryVersion: '1.2.3-test',
    payload: '/build/cwd/payload.zip',
  });

  for (const args of [
    ['--cache-dir', '/wrong-contract'],
    ['--out-dir'],
    ['--binary-version', ''],
    ['--payload', '--out-dir'],
    ['--out-dir', '/a', '--out-dir', '/b'],
  ]) {
    assert.ok('error' in parseBuildArgs(args, '/cwd', '/repo/deepseek'));
  }
});

test('ELF публикуется после smoke и получает packageId с binaryVersion', async (t) => {
  const { options, steps, calls } = await fixture(t);
  const manifest = await executeBinaryBuild({ ...options, binaryVersion: '2.0.0' }, steps);

  assert.equal(await fs.readFile(path.join(options.outDir, 'deepseek'), 'utf8'), 'candidate-node');
  assert.equal((await fs.stat(path.join(options.outDir, 'deepseek'))).mode & 0o777, 0o755);
  assert.equal(manifest.binaryVersion, '2.0.0');
  assert.match(manifest.packageId, /^[a-f0-9]{64}$/u);
  assert.deepEqual(calls, [
    'download', 'extract-node', 'bundle', 'payload', 'sea-config', 'postject', 'smoke',
  ]);
});

test('SEA получает канонические bytes manifest, защищённые отдельным packageId', async (t) => {
  const { options, steps } = await fixture(t);
  const run = steps.run;
  let embeddedId = '';

  steps.run = async (command, args, input) => {
    if (command !== 'tar') {
      const bytes = await fs.readFile(path.join(input!.cwd!, 'manifest.json'), 'utf8');
      const value = JSON.parse(bytes);

      assert.equal('packageId' in value, false, 'Нет самоссылки в защищённых bytes');
      assert.equal(bytes, canonicalJson(value));
      embeddedId = await fs.readFile(path.join(input!.cwd!, 'package-id'), 'utf8');
      assert.equal(sha256(bytes), embeddedId);

      const config = JSON.parse(await fs.readFile(path.join(input!.cwd!, 'sea-config.json'), 'utf8'));

      assert.equal(config.assets['package-id'], 'package-id');
    }

    return run(command, args, input);
  };

  const result = await executeBinaryBuild(options, steps);

  assert.equal(result.packageId, embeddedId);
});

for (const failure of ['platform', 'archive-hash', 'license', 'compiler', 'postject', 'smoke']) {
  test(`отказ ${failure} сохраняет прежний output`, async (t) => {
    const { options, steps, calls } = await fixture(t);
    let expected: RegExp;

    if (failure === 'platform') {
      steps.platform = 'darwin';
      expected = /Linux x64/u;
    } else if (failure === 'archive-hash') {
      steps.download = async (_url, file) => {
        await fs.writeFile(file, 'wrong-archive');
      };
      expected = /сумма/u;
    } else if (failure === 'license') {
      const run = steps.run;

      steps.run = async (command, args, input) => {
        const result = await run(command, args, input);

        await fs.unlink(path.join(input!.cwd!, 'LICENSE'));

        return result;
      };
      expected = /LICENSE/u;
    } else {
      const key = failure === 'compiler' ? 'bundle' : failure;

      steps[key as 'bundle' | 'postject' | 'smoke'] = async () => {
        throw new Error(`${failure} failed`);
      };
      expected = new RegExp(`${failure} failed`, 'u');
    }

    await assert.rejects(() => executeBinaryBuild(options, steps), expected);
    assert.equal(await fs.readFile(path.join(options.outDir, 'deepseek'), 'utf8'), 'previous-output');
    assert.deepEqual(await fs.readdir(options.outDir), ['deepseek']);

    if (failure === 'platform') {
      assert.deepEqual(calls, []);
    }
  });
}

test('git-tracked target отвергается до загрузки Node, индекс ворктри не используется', async (t) => {
  const { root, options, steps, calls } = await fixture(t);

  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'add', '--', 'out/deepseek']);

  await assert.rejects(() => executeBinaryBuild(options, steps), /отслеживается git/u);
  assert.equal(await fs.readFile(path.join(options.outDir, 'deepseek'), 'utf8'), 'previous-output');
  assert.deepEqual(calls, []);
});

test('binaryVersion и --payload сохраняют buildId, меняя packageId', async (t) => {
  const { options, steps } = await fixture(t);
  const a = await executeBinaryBuild(options, steps);
  const originalPrepare = steps.prepare;

  steps.prepare = async (work, selected) => {
    assert.equal(selected.payload, '/prepared/payload.zip');

    return originalPrepare(work, selected);
  };

  const b = await executeBinaryBuild({
    ...options,
    binaryVersion: '1.0.1',
    payload: '/prepared/payload.zip',
  }, steps);

  assert.equal(a.buildId, b.buildId);
  assert.notEqual(a.packageId, b.packageId);
});

test('явные dependencies для worker обязаны сохранять exact runtime lock', async (t) => {
  const { root } = await fixture(t);
  const paths = deepSeekPackagePaths();
  const selected = path.join(root, 'runtime-deps-node24');

  await fs.mkdir(selected);
  await fs.copyFile(path.join(paths.runtimeDependenciesDir, 'package.json'),
    path.join(selected, 'package.json'));
  await fs.writeFile(path.join(selected, 'package-lock.json'), '{}\n');

  await assert.rejects(() => deepSeekBuildInputs(paths.vendorDir, selected), /exact runtime lock/u);
});

/**
 * Source-sync должен собирать переданный vendor, а не скрыто брать pinned default.
 * Reusable payload нельзя совместить с vendor override, иначе candidate остался бы непроверенным.
 */
test('vendor-dir передаётся в source build и несовместим с reusable payload', () => {
  const parsed = parseBuildArgs(['--vendor-dir', '../changed-vendor'], '/fixture/work', '/fixture/deepseek');

  assert.ok(!('error' in parsed));
  assert.equal(parsed.vendorDir, '/fixture/changed-vendor');
  assert.ok('error' in parseBuildArgs([
    '--vendor-dir', '/fixture/vendor', '--payload', '/fixture/old-payload.zip',
  ], '/fixture/work', '/fixture/deepseek'));
});
