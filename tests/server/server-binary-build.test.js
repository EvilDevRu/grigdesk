import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeBinaryBuild, parseBuildArgs } from '../../server/scripts/binary/buildSteps.mts';
import { runBinarySmoke } from '../../server/scripts/binary/smoke.mts';
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

/**
 * Порты заменяют процессы, но реальный smoke выбирает baseline и проверяет свои ворота.
 * Builder публикует тот же отчёт и ELF, поэтому тест видит сквозной контракт build-result.
 */
function smokeHarness(input, options = {}) {
  const events = [];
  const reportFile = path.join(input.root, 'e0.json');
  const warm = options.warm ?? [100, 100, 100];
  let candidateStarts = 0;
  let baselineStarts = 0;
  const record = (phase) => {
    events.push(phase);

    if (phase === options.failure) {
      throw new Error(`fixture ${phase} failed`);
    }
  };
  const ports = {
    probe: async (_binary, settings) => {
      record('metadata');
      assert.equal(settings.expectPackageId, input.manifest.packageId);

      return { packageId: input.manifest.packageId };
    },
    prepare: async (_binary, settings) => {
      record('prepare');
      assert.equal(settings.expectPackageId, input.manifest.packageId);

      return { preparationToken: 'fixture-token' };
    },
    verify: async (_binary, settings) => {
      record('verify');
      assert.equal(settings.expectPackageId, input.manifest.packageId);
      assert.equal(settings.timeoutMs, 120000);

      return { elfSha256: sha256('new-ELF') };
    },
    boot: async (settings) => {
      if (!settings.packageId) {
        record('baseline');
        baselineStarts += 1;

        return 100;
      }

      if (settings.ipc) {
        record('ipc');
        assert.equal(settings.preparationToken, 'fixture-token');

        return 90;
      }

      candidateStarts += 1;

      if (candidateStarts === 1) {
        record('cold');

        return options.coldMs ?? 100;
      }

      record('warm');

      return warm[candidateStarts - 2];
    },
  };

  input.steps.smoke = (binary, manifest) => runBinarySmoke({
    binary,
    manifest,
    cacheDir: input.options.cacheDir,
    reportFile,
  }, ports);

  return {
    events,
    reportFile,
    baselineStarts: () => baselineStarts,
  };
}

/**
 * Только существующий каталог baseline включает сравнение тёплых стартов.
 * Маленький файл не запускается: boot подменён портом с заданными измерениями.
 */
async function putBaseline(input) {
  const binary = path.join(input.options.cacheDir, 'baseline-release/server/grigdesk-server');

  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, 'baseline');
}

test('SB22-E0: без baseline проходит полный smoke, отчёт и build-result явно помечают ratio', async (t) => {
  const input = await fixture(t);
  const harness = smokeHarness(input);
  const result = await executeBinaryBuild(input.options, input.steps);
  const report = JSON.parse(await readFile(harness.reportFile, 'utf8'));
  const stored = JSON.parse(await readFile(path.join(input.options.outDir, 'build-result.json'), 'utf8'));

  assert.equal(result.warmRatioNote, 'warm ratio не измерялся: нет baseline');
  assert.equal(result.warmRatio, null);
  assert.equal(result.warmP95Ratio, null);
  assert.equal(report.warmRatioNote, result.warmRatioNote);
  assert.equal(report.warmRatio, null);
  assert.equal(report.warmP95Ratio, null);
  assert.equal(report.coldMs, 100);
  assert.deepEqual(report.warm, []);
  assert.deepEqual(report.baseline, []);
  assert.deepEqual(stored, result);
  assert.deepEqual(harness.events, ['metadata', 'cold', 'prepare', 'ipc', 'verify']);
});

test('SB22-E0: без baseline холодный старт всё ещё ограничен 30 секундами', async (t) => {
  const input = await fixture(t);

  smokeHarness(input, { coldMs: 30001 });
  await assert.rejects(executeBinaryBuild(input.options, input.steps), /cold API/);
  assert.equal(await readFile(input.target, 'utf8'), 'previous');
});

test('SB22-E0: без baseline отказ любой функциональной проверки запрещает публикацию', async (t) => {
  for (const failure of ['metadata', 'cold', 'prepare', 'ipc', 'verify']) {
    const input = await fixture(t);

    smokeHarness(input, { failure });
    await assert.rejects(executeBinaryBuild(input.options, input.steps), /fixture.*failed/, failure);
    assert.equal(await readFile(input.target, 'utf8'), 'previous');
    assert.equal(await readFile(path.join(input.options.outDir, 'build-result.json'), 'utf8'),
      'previous-result');
  }
});

test('SB22-E0: существующий baseline сохраняет пары замеров и пороги median/p95', async (t) => {
  const input = await fixture(t);
  const harness = smokeHarness(input, { warm: [200, 200, 200] });

  await putBaseline(input);

  const result = await executeBinaryBuild(input.options, input.steps);
  const report = JSON.parse(await readFile(harness.reportFile, 'utf8'));

  assert.equal(result.warmRatio, 2);
  assert.equal(result.warmP95Ratio, 2);
  assert.equal(result.warmRatioNote, null);
  assert.equal(report.warmRatio, 2);
  assert.equal(report.warmP95Ratio, 2);
  assert.equal(report.warmRatioNote, null);
  assert.deepEqual(report.warm, [200, 200, 200]);
  assert.deepEqual(report.baseline, [100, 100, 100]);
  assert.equal(harness.baselineStarts(), 4);
  assert.deepEqual(harness.events.slice(5),
    ['baseline', 'baseline', 'warm', 'baseline', 'warm', 'baseline', 'warm']);
});

test('SB22-E0: при baseline превышение median или p95 останавливает сборку', async (t) => {
  for (const warm of [[201, 201, 201], [100, 100, 300]]) {
    const input = await fixture(t);

    smokeHarness(input, { warm });
    await putBaseline(input);
    await assert.rejects(executeBinaryBuild(input.options, input.steps), /warm.*ratio/);
    assert.equal(await readFile(input.target, 'utf8'), 'previous');
  }
});

test('SB22-E0: неполный явно существующий baseline не считается отсутствующим', async (t) => {
  const input = await fixture(t);
  const harness = smokeHarness(input);

  await mkdir(path.join(input.options.cacheDir, 'baseline-release'));
  await assert.rejects(executeBinaryBuild(input.options, input.steps), /ENOENT/);
  assert.deepEqual(harness.events, []);
});
