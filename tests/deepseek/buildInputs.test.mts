import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

import { deepSeekPackagePaths } from '../../deepseek/scripts/paths.ts';
import { deepSeekBuildInputs } from '../../deepseek/scripts/buildRuntime.mts';
import { assertKnownDynamicReferences } from '../../deepseek/scripts/deepseekBuildInputs.ts';
import { verifyDeepSeekSnapshot } from '../../deepseek/scripts/deepseekVendorManifest.ts';
import { sha256, sha256File } from '../../shared/node/hash.ts';
import { componentNodeRuntimeManifest, readTargetNodeRuntime } from '../../shared/node/nodeRuntime.ts';
import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { createDeepSeekVendorFixture, selectedDeepSeekVendor } from '../helpers/deepseekVendor.mts';
import { verifyTestDeepSeekArtifact } from '../helpers/deepseekRuntimeArtifact.mts';
import { testDeepSeekRuntimeDependencies } from '../helpers/deepseekBinary.mts';

interface CommandFailure extends Error {
  code: number;
  stdout: string;
  stderr: string;
}

const exec = promisify(execFile);

it('Harness выбирает свой Node 24.22.3 на всех трёх нативных целях', async () => {
  const { root } = deepSeekPackagePaths();
  const pins = {
    'linux-x64': '4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb',
    'linux-arm64': '6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c',
    'darwin-arm64': '1d64136c8a43d648d1b3bad10797a4c995b1ca032d2bde8799de43b37f058fe5',
  } as const;

  for (const target of Object.keys(pins) as (keyof typeof pins)[]) {
    const file = componentNodeRuntimeManifest(root, target);
    const pin = await readTargetNodeRuntime(file, target);

    assert.equal(path.dirname(file), path.join(root, 'build'));
    assert.deepEqual(pin, {
      version: '24.22.3',
      platform: target,
      sha256: pins[target],
    });
  }
});

describe('runtime-deps package и lock принадлежат пакету', () => {
  it('читает exact metadata и учитывает неизменные байты lock по новому пути', async () => {
    const paths = deepSeekPackagePaths();

    assert.equal(paths.runtimeDependenciesDir, path.join(paths.root, 'build/runtime-deps'));

    const manifest = JSON.parse(await readFile(path.join(paths.runtimeDependenciesDir, 'package.json'),
      'utf8'));
    const lock = await readFile(path.join(paths.runtimeDependenciesDir, 'package-lock.json'));
    const inputs = await deepSeekBuildInputs(selectedDeepSeekVendor());

    assert.equal(manifest.name, 'grigdesk-deepseek-build-dependencies');
    assert.equal(inputs.hashes['deepseek/build/runtime-deps/package-lock.json'], sha256(lock));
  });
});

describe('dynamic imports и license supplements принадлежат пакету', () => {
  it('проверяет registry и включает каждый supplement в fingerprint по новому пути', async () => {
    const paths = deepSeekPackagePaths();

    assert.equal(paths.dynamicImportsFile, path.join(paths.root, 'build/dynamic-imports.json'));
    assert.equal(paths.licensesDir, path.join(paths.root, 'build/licenses'));

    const registry = JSON.parse(await readFile(paths.dynamicImportsFile, 'utf8'));
    const sources = JSON.parse(await readFile(path.join(paths.licensesDir, 'sources.json'), 'utf8'));
    const inputs = await deepSeekBuildInputs(selectedDeepSeekVendor());

    assertKnownDynamicReferences([registry[0]], registry);
    assert.throws(() => assertKnownDynamicReferences([{
      ...registry[0],
      expression: 'import(unregistered)',
    }], registry), /неизвестный dynamic/u);

    for (const entry of sources.files) {
      const bytes = await readFile(path.join(paths.licensesDir, entry.file));

      assert.equal(inputs.hashes[`deepseek/build/licenses/${entry.file}`], sha256(bytes));
    }
  });
});

/**
 * Проверяет потребление перенесённого host-файла реальным builder fingerprint.
 * Байты host сохраняются; внутреннее имя generation задаётся прежним выходным контрактом.
 */
async function assertHostInput(
  role: keyof ReturnType<typeof deepSeekPackagePaths>['hostFiles'],
): Promise<void> {
  const paths = deepSeekPackagePaths();
  const relative = `deepseek/src/host/${role}.mjs`;

  assert.equal(paths.hostFiles[role], path.join(paths.root, 'src/host', `${role}.mjs`));

  const bytes = await readFile(paths.hostFiles[role]);
  const inputs = await deepSeekBuildInputs(selectedDeepSeekVendor());

  assert.equal(inputs.hashes[relative], sha256(bytes));
}

describe('entry host перенесён без изменения содержимого', () => {
  it('builder читает entry из пакета', () => assertHostInput('entry'));
});

describe('web host перенесён без изменения содержимого', () => {
  it('builder читает web host из пакета', () => assertHostInput('webHost'));
});

describe('ACP settings bridge перенесён без изменения содержимого', () => {
  it('builder читает ACP bridge из пакета', () => assertHostInput('acpSettingsBridge'));
});

describe('обязательная policy прав входит в fingerprint пакета', () => {
  for (const role of ['toolPermissionPolicy', 'toolPermissionPaths', 'toolPermissionGate'] as const) {
    it(`builder учитывает ${role}`, () => assertHostInput(role));
  }
});

describe('runtime composition принадлежит scripts пакета', () => {
  it('новый модуль проверяет peer/resource/native closure и сохраняет revision', async () => {
    const paths = deepSeekPackagePaths();

    assert.equal(paths.scripts.composition, path.join(paths.root, 'scripts/runtimeComposition.ts'));

    const composition = await import(pathToFileURL(paths.scripts.composition).href);

    assert.equal(composition.COMPOSITION_REVISION, 'grigdesk-host-web-acp-v5');
    assert.throws(() => composition.assertRuntimeClosure(new Set(), [
      {
        owner: 'package',
        kind: 'peer',
        target: 'missing-peer',
      },
      {
        owner: 'worker',
        kind: 'generated',
        target: 'missing-worker',
      },
      {
        owner: 'native',
        kind: 'native',
        target: 'missing-addon',
      },
    ]), (error: Error) => {
      assert.match(error.message, /missing-peer/u);
      assert.match(error.message, /missing-worker/u);
      assert.match(error.message, /missing-addon/u);

      return true;
    });
  });
});

describe('build inputs и license writer принадлежат scripts пакета', () => {
  it('отвергает отсутствующие compiled resources/native helper и лицензию', async (t) => {
    const paths = deepSeekPackagePaths();

    assert.equal(paths.scripts.inputs, path.join(paths.root, 'scripts/deepseekBuildInputs.ts'));
    assert.equal(paths.scripts.licenses, path.join(paths.root, 'scripts/deepseekBuildLicenses.ts'));

    const inputs = await import(pathToFileURL(paths.scripts.inputs).href);
    const licenses = await import(pathToFileURL(paths.scripts.licenses).href);
    const parent = path.join(artifactsPath({ env: process.env, home: os.homedir() }), 'build-input-tests');

    await mkdir(parent, { recursive: true });

    const scratch = await mkdtemp(path.join(parent, 'missing-'));

    t.after(() => rm(scratch, { recursive: true, force: true }));
    await assert.rejects(inputs.verifyCompiledResources(scratch, [{
      name: '@deepseek-ai/dsh-session-persistence-jsonl',
      root: 'packages/worker',
      manifest: { exports: { '.': './lib/typert.host.js' } },
    }]), (error: Error) => {
      assert.match(error.message, /packages\/worker\/lib\/typert.host.js/u);
      assert.match(error.message, /packages\/worker\/lib\/worker.cjs/u);
      assert.match(error.message, /native\/system\/packages\//u);

      return true;
    });
    await mkdir(path.join(scratch, 'node_modules/no-license'), { recursive: true });
    await writeFile(path.join(scratch, 'node_modules/no-license/package.json'), JSON.stringify({
      name: 'no-license',
      version: '1.0.0',
    }));
    await assert.rejects(licenses.writeDeepSeekLicenseInventory(scratch, []), /license declaration/u);
  });
});

describe('vendor manifest и sync CLI принадлежат scripts пакета', () => {
  it('проверяет offline snapshot и требует полный SHA в новом CLI', async (t) => {
    const paths = deepSeekPackagePaths();

    assert.equal(paths.scripts.vendor, path.join(paths.root, 'scripts/deepseekVendorManifest.ts'));
    assert.equal(paths.scripts.sync, path.join(paths.root, 'scripts/syncDeepSeekHarness.mts'));

    const vendor = await import(pathToFileURL(paths.scripts.vendor).href);
    const fixture = await createDeepSeekVendorFixture(t);
    const candidate = await vendor.prepareDeepSeekSync({ ...fixture, commit: fixture.sha });

    assert.equal((await vendor.verifyDeepSeekSnapshot(candidate.stagingDir)).commit, fixture.sha);
    await assert.rejects(exec(process.execPath, [paths.scripts.sync, '--commit', 'master'], {
      cwd: fixture.root,
      env: {
        PATH: process.env.PATH,
        GRIGDESK_ARTIFACTS_DIR: process.env.GRIGDESK_ARTIFACTS_DIR,
      },
    }), (error: CommandFailure) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /полный SHA commit/u);

      return true;
    });
  });
});

describe('builder принадлежит пакету и не требует server', () => {
  it('строит из другого cwd и отказывает при изменении входов во время сборки', {
    // Холодная подготовка и две сборки делят общий срок; каждая команда ограничена отдельно.
    timeout: 900000,
  }, async (t) => {
    const paths = deepSeekPackagePaths();

    assert.equal(paths.scripts.runtime, path.join(paths.root, 'scripts/buildRuntime.mts'));

    const artifactsRoot = artifactsPath({ env: process.env, home: os.homedir() });
    const parent = path.join(artifactsRoot, 'build-input-tests');
    const worker = await testDeepSeekRuntimeDependencies();

    assert.equal(await sha256File(worker.node), worker.nodeSha256);

    const identity = await exec(worker.node, ['-p',
      'JSON.stringify({ nodeVersion: process.versions.node, nativeAbi: process.versions.modules, '
      + 'platform: process.platform, arch: process.arch })',
    ], { env: { PATH: '' } });

    const runtime = JSON.parse(identity.stdout);

    assert.deepEqual(runtime, {
      nodeVersion: worker.version,
      nativeAbi: worker.abi,
      platform: process.platform,
      arch: process.arch,
    });

    await mkdir(parent, { recursive: true });

    const scratch = await mkdtemp(path.join(parent, 'standalone-'));
    const source = path.join(scratch, 'source');
    const copiedPackage = path.join(source, 'deepseek');
    const cwd = path.join(scratch, 'другой cwd');
    const output = path.join(scratch, 'output');
    const generation = path.join(output, 'generation');

    t.after(() => rm(scratch, { recursive: true, force: true }));

    // Сборка из отдельного cwd использует закреплённый worker и его prefix.
    // SEA dev dependencies и промежуточный cache в исходную фикстуру не входят.
    await cp(paths.root, copiedPackage, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (file) => !['node_modules', '.cache', 'vendor/deepseek-harness']
        .includes(path.relative(paths.root, file)),
    });
    await cp(path.join(path.dirname(path.resolve(paths.root)), 'shared'), path.join(source, 'shared'), {
      recursive: true,
    });
    await mkdir(cwd);
    await mkdir(output);
    await assert.rejects(access(path.join(source, 'server')), { code: 'ENOENT' });

    const cli = path.join(copiedPackage, 'scripts/buildRuntime.mts');
    const copiedVendor = path.join(copiedPackage, 'vendor/deepseek-harness');

    await cp(selectedDeepSeekVendor(), copiedVendor, { recursive: true, verbatimSymlinks: true });

    const snapshotBefore = await verifyDeepSeekSnapshot(copiedVendor);
    const options = {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: scratch,
        TMPDIR: scratch,
      },
      timeout: 240000,
      maxBuffer: 4 * 1024 * 1024,
    };
    const built = await exec(worker.node, [cli, '--runtime-deps-dir', worker.directory,
      '--output-dir', generation], options);

    assert.equal(built.stdout.trim(), generation);

    const metadata = await verifyTestDeepSeekArtifact(generation, runtime);

    assert.deepEqual(await verifyDeepSeekSnapshot(copiedVendor), snapshotBefore,
      'Успешная сборка не создаёт зависимости или compiled-файлы в vendor');
    assert.equal(metadata.inputIdentity.nativeAbi, worker.abi);
    await writeFile(path.join(artifactsPath({ env: process.env, home: os.homedir() }),
      'new-package-runtime.json'), JSON.stringify(metadata));

    const second = path.join(output, 'changed-inputs');
    const pending = exec(worker.node, [cli, '--runtime-deps-dir', worker.directory,
      '--output-dir', second], options);
    let finished = false;
    const outcome = pending.then((result) => {
      finished = true;

      return { code: 0, ...result };
    }, (error: CommandFailure) => {
      finished = true;

      return error;
    });

    try {
      // Staging создаётся после записи originalInputs: это наблюдаемый барьер сборщика.
      // Изменяется только приватная копия host-файла, исходный worktree остаётся целым.
      const deadline = Date.now() + 30000;
      let started = false;

      while (!started && !finished && Date.now() < deadline) {
        started = (await readdir(output)).some((entry) => entry.startsWith('.deepseek-build-'));

        if (!started) {
          await delay(25);
        }
      }

      assert.ok(started, 'Сборка не достигла staging после фиксации входов');

      const entry = path.join(copiedPackage, 'src/host/entry.mjs');

      await writeFile(entry, `${await readFile(entry, 'utf8')}\n// Изменённый вход fixture.\n`);

      const failure = await outcome;

      assert.equal(failure.code, 1, failure.stderr);
      assert.match(failure.stderr, /Входы DeepSeek изменились во время сборки/u);
      await assert.rejects(access(second), { code: 'ENOENT' });
    } finally {
      if (!finished) {
        pending.child.kill('SIGTERM');
        await outcome;
      }

      assert.deepEqual(await verifyDeepSeekSnapshot(copiedVendor), snapshotBefore,
        'Отказ сборки также оставляет vendor неизменным');
    }
  });
});
