import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeBinaryBuild, parseBuildArgs } from '../../server/scripts/binary/buildSteps.mts';
import { createServerManifest } from '../../server/src/binary/metadata.ts';
import { sha256 } from '../../shared/node/hash.ts';

/**
 * Все тяжёлые шаги заменены портами с маленькими проверяемыми файлами.
 * Проверка SHA архива, прежних outputs и атомарного rename остаётся настоящей.
 */
async function fixture(t, failure) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'server-build-'));
  const options = { outDir: path.join(root, 'out'), cacheDir: path.join(root, 'cache') };
  const target = path.join(options.outDir, 'grigdesk-server');
  const runtime = {
    version: '24.21.0',
    platform: 'linux-x64',
    sha256: sha256('archive'),
  };
  const events = [];

  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(options.outDir);
  await mkdir(options.cacheDir);
  await writeFile(target, 'previous');
  await writeFile(path.join(options.outDir, 'build-result.json'), 'previous-result');
  await writeFile(path.join(options.cacheDir, 'node-v24.21.0-linux-x64.tar.xz'), 'archive');

  const step = (name) => {
    events.push(name);

    if (name === failure) {
      throw new Error(`fixture ${name} failed`);
    }
  };
  const manifest = createServerManifest({
    entries: [],
    size: 22,
    sha256: 'a'.repeat(64),
  }, {
    launcherSha256: sha256('launcher'),
    engineSha256: 'c'.repeat(64),
    buildInputs: {},
  });
  const steps = {
    platform: 'linux',
    arch: 'x64',
    runtime,
    run: async (file, _args, input) => {
      step(file === 'tar' ? 'extract' : 'blob');

      if (file === 'tar') {
        await mkdir(path.join(input.cwd, 'bin'));
        await writeFile(path.join(input.cwd, 'bin/node'), 'new-ELF');
        await writeFile(path.join(input.cwd, 'LICENSE'), 'Node license');
      } else {
        await writeFile(path.join(input.cwd, 'sea-prep.blob'), 'blob');
      }

      return { stdout: '', stderr: '' };
    },
    prepare: async () => step('prepare'),
    bundle: async (work) => {
      step('bundle');
      await writeFile(path.join(work, 'bundle.cjs'), 'launcher');
    },
    package: async () => {
      step('package');

      return manifest;
    },
    copy: async (from, to) => {
      step('copy');
      await writeFile(to, await readFile(from));
    },
    postject: async () => step('postject'),
    smoke: async () => step('smoke'),
  };

  return {
    root,
    options,
    target,
    steps,
    events,
    manifest,
  };
}

test('SB22: build argv закрыт, out/cache обязательны и не выбирают живой bin', () => {
  for (const args of [[], ['--bad'], ['--out-dir', 'out'],
    ['--out-dir', 'out', '--cache-dir', 'cache', '--cache-dir', 'other']]) {
    assert.ok('error' in parseBuildArgs(args, '/fixture'));
  }

  assert.deepEqual(parseBuildArgs(['--out-dir', 'out', '--cache-dir', 'cache'], '/fixture'), {
    outDir: '/fixture/out',
    cacheDir: '/fixture/cache',
  });
});

test('SB22: injected отказы всех стадий сохраняют предыдущие ELF/result', async (t) => {
  for (const failure of ['extract', 'prepare', 'bundle', 'package', 'blob', 'copy', 'postject', 'smoke']) {
    const input = await fixture(t, failure);

    await assert.rejects(executeBinaryBuild(input.options, input.steps), /fixture.*failed/, failure);
    assert.equal(await readFile(input.target, 'utf8'), 'previous');
    assert.equal(await readFile(path.join(input.options.outDir, 'build-result.json'), 'utf8'),
      'previous-result');
  }
});

test('SB22: pin/missing archive/tracked output отказывают до тяжёлых стадий', async (t) => {
  const input = await fixture(t);

  await rm(path.join(input.options.cacheDir, 'node-v24.21.0-linux-x64.tar.xz'));
  await assert.rejects(executeBinaryBuild(input.options, input.steps), /архив|закреплён/);
  assert.deepEqual(input.events, []);
  execFileSync('git', ['init', '--quiet'], { cwd: input.options.outDir });
  execFileSync('git', ['add', 'grigdesk-server'], { cwd: input.options.outDir });
  await assert.rejects(executeBinaryBuild(input.options, input.steps), /отслеживается git/);
});

test('SB22: публикация после smoke выдаёт SHA/size/packageId того же ELF', async (t) => {
  const input = await fixture(t);
  const result = await executeBinaryBuild(input.options, input.steps);

  assert.equal(result?.packageId, input.manifest.packageId);
  assert.equal(result.sha256, sha256('new-ELF'));
  assert.equal(result.size, Buffer.byteLength('new-ELF'));
  assert.deepEqual(input.events,
    ['extract', 'prepare', 'bundle', 'package', 'blob', 'copy', 'postject', 'smoke']);
  assert.deepEqual(JSON.parse(await readFile(path.join(input.options.outDir, 'build-result.json'), 'utf8')),
    result);
});
