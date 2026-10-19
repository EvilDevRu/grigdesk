import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { bundleServer } from '../../server/scripts/sea/bundle.mts';
import { parseBuildArgs, publishRelease } from '../../server/scripts/sea/release.mts';
import * as release from '../../server/scripts/sea/release.mts';
import { checkRuntime, writeReleaseManifest } from '../../server/src/lib/releaseManifest.ts';
import { auditStage } from '../../server/scripts/sea/stage.mts';
import * as stage from '../../server/scripts/sea/stage.mts';
import { runSeaCli } from '../../server/src/lib/seaCli.ts';

const SOURCE = path.resolve(import.meta.dirname, '../..');
const runFile = promisify(execFile);
const RUNTIME = {
  node: '24.21.0',
  abi: '137',
  platform: 'linux',
  arch: 'x64',
};

/**
 * Создаёт отдельный staging проверки; ни один опубликованный комплект не используется.
 * Уборка удаляет только каталог, созданный текущим тестом.
 */
async function scratch(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grigdesk-sea-release-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

test('SEA-RELEASE-01: аргументы сборки отвергают неизвестное и не выбирают живую установку', () => {
  assert.equal(parseBuildArgs(['--unknown'], SOURCE, SOURCE).error.includes('--unknown'), true);
  assert.equal(parseBuildArgs(['--out-dir'], SOURCE, SOURCE).error.length > 0, true);
  assert.equal(parseBuildArgs(['--out-dir', 'one', '--out-dir', 'two'], SOURCE, SOURCE).error.length > 0,
    true);
  assert.equal(parseBuildArgs(['--out-dir', 'out', '--cache-dir', 'cache'], '/tmp/build', SOURCE).outDir,
    '/tmp/build/out');
});

test('SEA-RELEASE-02: manifest проверяет файл, платформу и собственный id', async (t) => {
  const root = await scratch(t);
  const file = path.join(root, 'VERSION');

  await writeFile(file, '1.2.3');
  await chmod(file, 0o644);

  const files = await auditStage(root, { required: ['VERSION'] });
  const manifest = await writeReleaseManifest(root, {
    version: '1.2.3',
    runtime: RUNTIME,
    files,
  });

  assert.equal((await checkRuntime(root, RUNTIME)).ok, true);
  await writeFile(file, 'changed');
  assert.equal((await checkRuntime(root, RUNTIME)).ok, false);
  await rm(file);
  assert.equal((await checkRuntime(root, RUNTIME)).ok, false);
  await writeFile(file, '1.2.3');
  assert.equal((await checkRuntime(root, { ...RUNTIME, arch: 'arm64' })).ok, false);
  await writeFile(path.join(root, 'release.json'), JSON.stringify({
    ...manifest, contentId: '0'.repeat(64),
  }));
  assert.equal((await checkRuntime(root, RUNTIME)).ok, false);
});

test('SEA-RELEASE-03: служебная проверка печатает JSON и не загружает сервер', async () => {
  let loaded = 0;
  let stdout = '';
  const code = await runSeaCli(['--check-runtime'], {
    readVersion: () => '1.2.3',
    readLicense: () => 'license',
    loadServer: async () => {
      loaded += 1;
    },
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => {},
    nodeVersion: 'v24.21.0',
    platform: 'linux',
    arch: 'x64',
    checkRuntime: async () => ({ ok: false, errors: ['fixture corruption'] }),
  });

  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).ok, false);
  assert.equal(loaded, 0);
});

test('SEA-RELEASE-04: отказ prepare, smoke или archive сохраняет прежний результат', async (t) => {
  const root = await scratch(t);
  const archive = path.join(root, 'grigdesk-server-1.2.3-linux-x64.tar.xz');

  await writeFile(archive, 'old archive');

  for (const phase of ['prepare', 'smoke', 'archive']) {
    const fail = async () => {
      throw new Error(`fixture ${phase}`);
    };

    await assert.rejects(publishRelease({
      outDir: root,
      name: 'grigdesk-server-1.2.3-linux-x64',
      prepare: phase === 'prepare' ? fail : async (directory) => {
        await writeFile(path.join(directory, 'VERSION'), 'new');

        return { contentId: 'a'.repeat(64) };
      },
      smoke: phase === 'smoke' ? fail : async () => {},
      archive: phase === 'archive' ? fail : async (_directory, file) => writeFile(file, 'new archive'),
    }), /fixture/);
    assert.equal(await readFile(archive, 'utf8'), 'old archive');
  }
});

test('SEA-RELEASE-05: полный CJS граф включает реестры и не содержит пути checkout', async (t) => {
  const root = await scratch(t);
  const outfile = path.join(root, 'server.cjs');
  const result = await bundleServer({
    sourceRoot: SOURCE,
    workDir: root,
    outfile,
  });
  const inputs = Object.keys(result.metafile.inputs).map((file) => file.replaceAll('\\', '/'));

  assert.equal(inputs.some((file) => file.endsWith('server/src/lib/db/engines/redis.ts')), true);
  assert.equal(inputs.some((file) => file.endsWith('server/src/lib/executors/claude.ts')), true);

  for (const file of ['server/src/plugins/apiVersion.ts', 'server/src/lib/clientAccess/bootstrap.ts',
    'server/src/lib/clientAccess/listener.ts', 'server/src/modules/devices/index.ts',
    'server/src/lib/deepseek/distribution.ts']) {
    assert.equal(inputs.some((input) => input.endsWith(file)), true, file);
  }

  for (const file of [
    'server/src/lib/grigDeskUpdate.ts',
    'server/src/lib/grigDeskRelease.ts',
    'server/src/lib/deepseek/binaryReadiness.ts',
    'server/src/workers/grigdesk-update-worker.js',
    'server/scripts/deepSeekCandidateGate.ts',
  ]) {
    assert.equal(inputs.some((input) => input.endsWith(file)), false, file);
  }

  assert.equal((await readFile(outfile, 'utf8')).includes(SOURCE), false);
});

test('SEA-RELEASE-06: публикация оставляет отдельную версию и атомарно заменяет архив', async (t) => {
  const root = await scratch(t);
  const name = 'grigdesk-server-1.2.3-linux-x64';
  const contentId = 'b'.repeat(64);
  const archive = path.join(root, `${name}.tar.xz`);

  await writeFile(archive, 'old archive');

  const result = await publishRelease({
    outDir: root,
    name,
    prepare: async (directory) => {
      await writeFile(path.join(directory, 'VERSION'), 'new');

      return { contentId };
    },
    smoke: async (directory) => assert.equal(await readFile(path.join(directory, 'VERSION'), 'utf8'), 'new'),
    archive: async (_directory, target) => writeFile(target, 'new archive'),
  });

  assert.equal(await readFile(archive, 'utf8'), 'new archive');
  assert.equal(await readFile(path.join(result.directory, 'VERSION'), 'utf8'), 'new');
  assert.equal((await readdir(root)).some((file) => file.startsWith('.')), false);
});

test('SEA-RELEASE-07: добавления дают warnings, неподдерживаемая упаковка запрещает runtime', async (t) => {
  const root = await scratch(t);

  await writeFile(path.join(root, 'VERSION'), '1.2.3');

  const files = await auditStage(root, { required: ['VERSION'] });
  const manifest = await writeReleaseManifest(root, {
    version: '1.2.3',
    runtime: RUNTIME,
    files,
  });

  await writeFile(path.join(root, 'extra.txt'), 'extra');

  const added = await checkRuntime(root, RUNTIME);

  assert.equal(added.ok, true);
  assert.ok(added.warnings.some((warning) => warning.includes('extra.txt')));
  await rm(path.join(root, 'extra.txt'));
  await writeFile(path.join(root, 'release.json'), JSON.stringify({ ...manifest, packagingVersion: 99 }));
  assert.equal((await checkRuntime(root, RUNTIME)).ok, false);
});

test('REVIEW-P2: потеря group-write не означает повреждение поставки', async (t) => {
  const root = await scratch(t);
  const file = path.join(root, 'VERSION');

  await writeFile(file, '1.2.3');
  await chmod(file, 0o664);

  const files = await auditStage(root, { required: ['VERSION'] });

  await writeReleaseManifest(root, {
    version: '1.2.3',
    runtime: RUNTIME,
    files,
  });
  await chmod(file, 0o644);
  assert.equal((await checkRuntime(root, RUNTIME)).ok, true);
});

test('REVIEW-P2: архив имеет числового владельца 0/0 и проходит проверку под umask 022', async (t) => {
  const root = await scratch(t);
  const packaged = path.join(root, 'release');
  const extracted = path.join(root, 'extracted');
  const archive = path.join(root, 'release.tar.xz');

  await mkdir(packaged);
  await mkdir(extracted);
  await writeFile(path.join(packaged, 'VERSION'), '1.2.3');
  await chmod(path.join(packaged, 'VERSION'), 0o664);
  await stage.normalizeStageModes(packaged);

  const files = await auditStage(packaged, { required: ['VERSION'] });

  await writeReleaseManifest(packaged, {
    version: '1.2.3',
    runtime: RUNTIME,
    files,
  });
  await release.createReleaseArchive(packaged, archive);

  const listed = await runFile('tar', ['--numeric-owner', '-tvJf', archive]);

  assert.ok(listed.stdout.trim().split('\n').every((line) => /^\S+ 0\/0\s/.test(line)));
  await runFile('bash', ['-c', 'umask 022; tar -xJf "$1" -C "$2"', '_', archive, extracted]);

  const unpacked = path.join(extracted, 'release');

  assert.equal((await stat(path.join(unpacked, 'VERSION'))).mode & 0o777, 0o644);
  assert.equal((await stat(path.join(unpacked, 'release.json'))).mode & 0o777, 0o644);
  assert.equal((await checkRuntime(unpacked, RUNTIME)).ok, true);
});

test('REVIEW-P4: быстрая проверка не хеширует библиотечные файлы, полная находит порчу', async (t) => {
  const root = await scratch(t);

  await writeFile(path.join(root, 'library.txt'), 'original');

  const files = await auditStage(root, { required: ['library.txt'] });

  await writeReleaseManifest(root, {
    version: '1.2.3',
    runtime: RUNTIME,
    files,
  });
  await writeFile(path.join(root, 'library.txt'), 'changed!');
  assert.equal((await checkRuntime(root, RUNTIME, { mode: 'startup' })).ok, true);
  assert.equal((await checkRuntime(root, RUNTIME)).ok, false);
});

test('REVIEW-P4: startup проверяет хеши обоих бинарников и отсутствие файлов состава', async (t) => {
  const root = await scratch(t);
  const binaries = ['server/grigdesk-server', 'runtime/node/bin/node'];

  for (const file of binaries) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), 'original');
    await chmod(path.join(root, file), 0o755);
  }

  await writeFile(path.join(root, 'library.txt'), 'library');

  const files = await auditStage(root, { required: [...binaries, 'library.txt'] });

  await writeReleaseManifest(root, {
    version: '1.2.3',
    runtime: RUNTIME,
    files,
  });

  for (const binary of binaries) {
    await writeFile(path.join(root, binary), 'changed!');
    assert.equal((await checkRuntime(root, RUNTIME, { mode: 'startup' })).ok, false);
    await writeFile(path.join(root, binary), 'original');
  }

  await rm(path.join(root, 'library.txt'));
  assert.equal((await checkRuntime(root, RUNTIME, { mode: 'startup' })).ok, false);
});

test('REVIEW-P4: служебные argv выбирают startup/full без boot', async () => {
  const modes = [];

  for (const argument of ['--check-startup', '--check-runtime']) {
    let stdout = '';
    const code = await runSeaCli([argument], {
      readVersion: () => '1.2.3',
      readLicense: () => 'license',
      loadServer: async () => assert.fail('служебная команда запустила сервер'),
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      nodeVersion: 'v24.21.0',
      platform: 'linux',
      arch: 'x64',
      checkRuntime: async (mode) => {
        modes.push(mode);

        return { ok: true, errors: [] };
      },
    });

    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).ok, true);
  }

  assert.deepEqual(modes, ['startup', 'full']);
});

test('REVIEW-P1: сторонний pycache не влияет на состав manifest', async (t) => {
  const root = await scratch(t);

  await writeFile(path.join(root, 'VERSION'), '1.2.3');

  const files = await auditStage(root, { required: ['VERSION'] });

  await writeReleaseManifest(root, {
    version: '1.2.3',
    runtime: RUNTIME,
    files,
  });
  await mkdir(path.join(root, '__pycache__'));
  await writeFile(path.join(root, '__pycache__/fixture.pyc'), 'cache');

  const checked = await checkRuntime(root, RUNTIME);

  assert.equal(checked.ok, true);
  assert.deepEqual(checked.warnings, []);
});

test('SEA-RELEASE-08: повторная публикация не доверяет id повреждённого каталога версии', async (t) => {
  const root = await scratch(t);
  const input = {
    outDir: root,
    name: 'grigdesk-server-1.2.3-linux-x64',
    prepare: async (directory) => {
      await writeFile(path.join(directory, 'VERSION'), '1.2.3');

      const files = await auditStage(directory, { required: ['VERSION'] });

      return writeReleaseManifest(directory, {
        version: '1.2.3',
        runtime: RUNTIME,
        files,
      });
    },
    smoke: async () => {},
    archive: async (_directory, file) => writeFile(file, 'archive-one'),
  };
  const first = await publishRelease(input);

  await writeFile(path.join(first.directory, 'VERSION'), 'corrupt');
  await assert.rejects(publishRelease({
    ...input,
    archive: async (_directory, file) => writeFile(file, 'archive-two'),
  }), /поврежд|целостност/i);
  assert.equal(await readFile(first.archive, 'utf8'), 'archive-one');
});
