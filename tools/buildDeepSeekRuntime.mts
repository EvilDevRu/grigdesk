import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  checkDeepSeekPatches,
  verifyDeepSeekSnapshot,
  verifyDeepSeekVendorMetadata,
  vendorHash,
} from './deepseekVendorManifest.ts';
import { writeDeepSeekLicenseInventory } from './deepseekBuildLicenses.ts';
import {
  assertKnownDynamicReferences,
  scanDynamicRuntimeReferences,
  verifyCompiledResources,
} from './deepseekBuildInputs.ts';
import {
  COMPOSITION_REVISION,
  discoverRuntimeClosure,
  readRuntimeComposition,
} from './runtimeComposition.ts';

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const dependencyRoot = path.join(repositoryRoot, 'tools/deepseek-build');
const requireBuild = createRequire(path.join(dependencyRoot, 'package.json'));

/**
 * Fingerprint охватывает manifest исходников, код сборки, композицию, launcher и exact lock.
 * Считается без самих исходников: manifest закрепляет их хеши, поэтому готовая сборка
 * проверяется без сети. Патч-версия Node не входит: совместимость задаёт native ABI.
 * Статус gates не меняет source identity и не создаёт самоподдерживающуюся пересборку.
 */
export async function deepSeekBuildInputs(vendorDir: string): Promise<Record<string, unknown>> {
  const manifest = await verifyDeepSeekVendorMetadata(vendorDir);
  const { requiredGates: _gates, ...source } = manifest;
  const inputs = ['tools/buildDeepSeekRuntime.mts', 'tools/deepseekBuildInputs.ts',
    'tools/deepseekBuildLicenses.ts',
    'tools/runtimeComposition.ts', 'tools/deepseekEntry.mjs', 'tools/deepseekWebHost.mjs',
    'tools/deepseekAcpSettingsBridge.mjs',
    'tools/deepseekPresetsHost.mjs',
    'tools/deepseek-build/package.json', 'tools/deepseek-build/package-lock.json',
    'tools/deepseek-build/dynamic-imports.json', 'tools/deepseek-build/licenses/sources.json',
    'tools/deepseek-build/licenses/xterm-6.0.0-LICENSE.txt',
    'tools/deepseek-build/licenses/LGPL-3.0.txt', 'tools/deepseek-build/licenses/GPL-3.0.txt'];
  const hashes: Record<string, string> = {};
  const licenses = JSON.parse(await fs.readFile(
    path.join(dependencyRoot, 'licenses/sources.json'), 'utf8',
  ));

  for (const entry of licenses.files) {
    const input = `tools/deepseek-build/licenses/${entry.file}`;

    if (!inputs.includes(input)) {
      inputs.push(input);
    }
  }

  for (const input of inputs) {
    hashes[input] = vendorHash(await fs.readFile(path.join(repositoryRoot, input)));
  }

  return {
    hashes,
    source: {
      commit: source.commit,
      version: source.version,
      manifest: vendorHash(JSON.stringify(source)),
    },
    nodeMajor: Number(process.versions.node.split('.')[0]),
    nativeAbi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
  };
}

/**
 * Артефакт содержит все файлы и внутренние ссылки; наружная ссылка запрещена.
 * Хеш ссылки учитывает её относительную цель без случайного пути сборочной папки.
 */
export async function hashRuntimePayload(root: string, relative = ''): Promise<Record<string, string>> {
  const output: Record<string, string> = {};

  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);

    if (name === 'runtime.json') {
      continue;
    }

    if (entry.isDirectory()) {
      Object.assign(output, await hashRuntimePayload(root, name));
    } else if (entry.isFile()) {
      const file = path.join(root, name);
      const mode = (await fs.stat(file)).mode & 0o777;

      const bytes = await fs.readFile(file);

      output[name] = vendorHash(`${mode}:${bytes.toString('base64')}`);
    } else if (entry.isSymbolicLink()) {
      const target = await fs.readlink(path.join(root, name));
      const resolved = path.relative(root, path.resolve(root, path.dirname(name), target));

      if (path.isAbsolute(target) || resolved.startsWith('..') || path.isAbsolute(resolved)) {
        throw new Error(`Runtime содержит внешнюю ссылку: ${name} → ${target}`);
      }

      await fs.stat(path.join(root, name));
      output[name] = vendorHash(`link:${target}`);
    } else {
      throw new Error(`Runtime содержит специальный файл: ${name}`);
    }
  }

  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b, 'en')));
}

/**
 * Каждому пакету доступны точные версии его external dependencies из upstream lock.
 * Относительные ссылки остаются внутри generation после переноса каталога.
 */
async function linkWorkspace(
  root: string,
  closure: Awaited<ReturnType<typeof discoverRuntimeClosure>>,
): Promise<void> {
  const buildManifest = JSON.parse(await fs.readFile(path.join(dependencyRoot, 'package.json'), 'utf8'));
  const moduleRoot = path.join(root, 'node_modules');

  for (const item of closure.packages) {
    const target = path.join(moduleRoot, item.name);

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(path.relative(path.dirname(target), path.join(root, item.root)), target);

    for (const [name, version] of Object.entries(closure.external[item.name] ?? {})) {
      const alias = buildManifest.dependencies[name] === version
        ? name
        : `cockpit-${name.replaceAll('@', '').replaceAll('/', '-')}-${version}`;
      const dependency = path.join(moduleRoot, alias);

      await fs.stat(dependency);

      const local = path.join(root, item.root, 'node_modules', name);

      await fs.mkdir(path.dirname(local), { recursive: true });
      await fs.symlink(path.relative(path.dirname(local), dependency), local);
    }
  }
}

/**
 * Компиляция использует закреплённый TypeScript и upstream host-проекты.
 * Агрегат ограничен выбранными пакетами; browser face не компилируется.
 */
async function compileWorkspace(
  root: string,
  closure: Awaited<ReturnType<typeof discoverRuntimeClosure>>,
): Promise<void> {
  const references: { path: string }[] = [];

  for (const item of closure.packages) {
    const host = path.join(item.root, 'tsconfig.host.json');
    const ordinary = path.join(item.root, 'tsconfig.json');
    const config = await fs.access(path.join(root, host)).then(() => host, () => ordinary);

    if (!(await fs.access(path.join(root, config)).then(() => true, () => false))) {
      continue;
    }

    const configFile = path.join(root, config);
    const project = JSON.parse(await fs.readFile(configFile, 'utf8'));

    for (const reference of project.references ?? []) {
      const target = path.resolve(path.dirname(configFile), reference.path);
      const directory = target.endsWith('.json') ? path.dirname(target) : target;
      const hostTarget = path.join(directory, 'tsconfig.host.json');

      if (await fs.access(hostTarget).then(() => true, () => false)) {
        reference.path = path.relative(path.dirname(configFile), hostTarget);
      }
    }

    await fs.writeFile(configFile, JSON.stringify(project, null, 2));
    references.push({ path: config });
  }

  await fs.writeFile(path.join(root, 'tsconfig.host.json'), JSON.stringify({
    extends: './tsconfig.base.json',
    files: [],
    references,
  }));
  await exec(process.execPath, [
    '--max-old-space-size=4096',
    path.join(dependencyRoot, 'node_modules/typescript/bin/tsc'),
    '-b',
    'tsconfig.host.json',
  ], { cwd: root, maxBuffer: 16 * 1024 * 1024 });

  const esbuild = requireBuild('esbuild');

  for (const item of closure.packages) {
    const entries = new Map<string, string>();

    /**
     * Компилируются runtime exports host-части, а reflection создаётся генератором.
     * Browser exports не становятся случайными точками входа host generation.
     */
    const findExports = (value: any): void => {
      const targets = value && typeof value === 'object'
        ? [value.default, value.import, value.require].filter((target) => typeof target === 'string')
        : [];

      if (targets.length > 0 && typeof value.types === 'string') {
        const source = value.types.replace(/\.d\.ts$/u, '.js');

        for (const target of targets) {
          if (target.startsWith('./lib/') && /\.[cm]?js$/u.test(target)
            && !target.includes('client') && !target.includes('typert')) {
            entries.set(target, source);
          }
        }
      } else if (value && typeof value === 'object') {
        for (const child of Object.values(value)) {
          findExports(child);
        }
      }
    };

    findExports(item.manifest.exports);

    if (['@deepseek-ai/dsh-code-runtime-worker-thread',
      '@deepseek-ai/dsh-workflow-worker-thread'].includes(item.name)) {
      entries.set('./lib/worker.cjs', './lib/types/worker.js');
    }

    for (const [entry, source] of entries) {
      const input = path.join(root, item.root, source);

      await fs.stat(input);

      if (input === path.join(root, item.root, entry)) {
        continue;
      }

      // Комментарии бандла содержат пути от absWorkingDir: корень сборки делает их одинаковыми
      // для любого staging-каталога, и те же входы дают тот же payload и buildId.
      await esbuild.build({
        absWorkingDir: root,
        entryPoints: [input],
        outfile: path.join(root, item.root, entry),
        bundle: true,
        platform: 'node',
        target: 'node22.19',
        format: entry.endsWith('.cjs') ? 'cjs' : 'esm',
        packages: 'external',
        external: ['@deepseek-ai/*'],
        tsconfigRaw: { compilerOptions: {} },
        logLevel: 'silent',
      });
    }
  }

  const generatorPath = path.join(root, 'packages/typert/generator/lib/index.js');
  const { WorkspaceTypertGenerator } = await import(pathToFileURL(generatorPath).href);
  const generator = new WorkspaceTypertGenerator(root, { checkDiagnostics: false });
  const reflectionPackages = closure.packages
    .filter((item) => Object.hasOwn(item.manifest.exports ?? {}, './typert'))
    .map((item) => item.name);

  for (const artifact of generator.generate(reflectionPackages, ['host'])) {
    const directory = path.join(root, artifact.packageRoot, 'lib');

    await fs.writeFile(path.join(directory, 'typert.host.js'), artifact.js);
    await fs.writeFile(path.join(directory, 'typert.host.d.ts'), artifact.dts);

    if (artifact.remote) {
      await fs.writeFile(path.join(directory, 'typert.remote-client.js'), artifact.remote.js);
      await fs.writeFile(path.join(directory, 'typert.remote-client.d.ts'), artifact.remote.dts);
    }
  }
}

/**
 * Сведения о плагине llm-pi-ai входят в контракт generation и тем самым в её buildId.
 * Snapshot без исходников плагина поля не получает: GLM видит отказ, DeepSeek — нет.
 */
async function llmPiAiContract(manifest: {
  files: readonly { path: string; sha256: string }[];
  patches: readonly { path: string; sha256: string }[];
}): Promise<Record<string, unknown> | null> {
  const sources = manifest.files
    // Сборка переписывает tsconfig пакета; commit upstream и так входит в identity допуска.
    .filter((file) => file.path.startsWith('packages/llm/llm-pi-ai/'))
    .filter((file) => !/\/tsconfig[^/]*\.json$/u.test(file.path))
    .map((file) => ({ path: file.path, sha256: file.sha256 }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  if (sources.length === 0) {
    return null;
  }

  const lock = JSON.parse(await fs.readFile(path.join(dependencyRoot, 'package-lock.json'), 'utf8'));
  const piAi = lock.packages?.['node_modules/@earendil-works/pi-ai'];

  if (typeof piAi?.version !== 'string' || typeof piAi.integrity !== 'string') {
    throw new Error('В lock сборки нет exact pi-ai с integrity');
  }

  return {
    piAi: {
      version: piAi.version,
      integrity: piAi.integrity,
    },
    sourceHash: vendorHash(JSON.stringify(sources)),
    patches: manifest.patches.map((patch) => ({ path: patch.path, sha256: patch.sha256 })),
  };
}

/**
 * Сборка никогда не пишет в current и не зависит от server/node_modules.
 * Source snapshot проверяется до копирования, патчи накладываются только в staging.
 */
export async function buildDeepSeekRuntime(options: {
  vendorDir: string;
  outputDir: string;
}): Promise<string> {
  const manifest = await verifyDeepSeekSnapshot(options.vendorDir);
  const originalInputs = await deepSeekBuildInputs(options.vendorDir);
  const major = Number(process.versions.node.split('.')[0]);
  const minor = Number(process.versions.node.split('.')[1]);

  if (!(major === 22 && minor >= 19 || major >= 24)) {
    throw new Error('DeepSeek требует Node ^22.19.0 || >=24.0.0');
  }

  try {
    requireBuild('typescript');
    requireBuild('esbuild');
  } catch {
    throw new Error('Подготовьте зависимости: npm ci --prefix tools/deepseek-build');
  }

  const stagingParent = path.dirname(path.resolve(options.outputDir));

  await fs.mkdir(stagingParent, { recursive: true });

  const container = await fs.mkdtemp(path.join(stagingParent, '.deepseek-build-'));
  const staging = path.join(container, 'generation');

  try {
    await checkDeepSeekPatches(options.vendorDir, staging);
    await fs.cp(path.join(dependencyRoot, 'node_modules'), path.join(staging, 'node_modules'), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    await fs.writeFile(path.join(staging, 'package.json'), '{"private":true,"type":"module"}\n');

    const closure = await discoverRuntimeClosure(staging);
    const composition = await readRuntimeComposition(staging);
    const dynamicImports = JSON.parse(await fs.readFile(
      path.join(dependencyRoot, 'dynamic-imports.json'), 'utf8',
    ));

    const references = await scanDynamicRuntimeReferences(staging, closure.packages, [
      'node_modules/@earendil-works/pi-ai/dist',
    ]);

    assertKnownDynamicReferences(references, dynamicImports);

    for (const [bundle, patches] of Object.entries(composition)) {
      const { runtimeYaml } = await import('./runtimeComposition.ts');

      await fs.writeFile(path.join(staging, `packages/bundle/${bundle}/cordis.patch.yml`),
        runtimeYaml().dump(patches));
    }

    await linkWorkspace(staging, closure);
    await compileWorkspace(staging, closure);
    await exec(process.execPath, ['native/system/scripts/build.ts', '--host-addon-only'], {
      cwd: staging,
      maxBuffer: 4 * 1024 * 1024,
    });
    await exec(process.execPath, ['packages/subprocess/subprocess-local/scripts/ensure-spawn-helper.mjs'], {
      cwd: staging,
      maxBuffer: 64 * 1024,
    });
    await verifyCompiledResources(staging, closure.packages);
    await fs.copyFile(path.join(repositoryRoot, 'tools/deepseekEntry.mjs'), path.join(staging, 'entry.mjs'));
    await fs.copyFile(path.join(repositoryRoot, 'tools/deepseekWebHost.mjs'),
      path.join(staging, 'webHost.mjs'));
    await fs.copyFile(path.join(repositoryRoot, 'tools/deepseekAcpSettingsBridge.mjs'),
      path.join(staging, 'acpSettingsBridge.mjs'));
    await fs.copyFile(path.join(repositoryRoot, 'tools/deepseekPresetsHost.mjs'),
      path.join(staging, 'presetsHost.mjs'));

    // Compiler и bundler уже завершили работу; runtime не получает их executable dependencies.
    for (const name of ['typescript', 'esbuild', '@esbuild']) {
      await fs.rm(path.join(staging, 'node_modules', name), { recursive: true, force: true });
    }

    await fs.rm(path.join(staging, 'node_modules/.bin'), { recursive: true, force: true });
    await fs.rm(path.join(staging, 'node_modules/.package-lock.json'), { force: true });
    await fs.unlink(path.join(staging, 'node_modules/@deepseek-ai/dsh-typert-generator'));
    await fs.rm(path.join(staging, 'packages/typert/generator'), { recursive: true });

    closure.packages = closure.packages.filter((item) => item.name !== '@deepseek-ai/dsh-typert-generator');
    await fs.writeFile(path.join(staging, 'composition.json'), JSON.stringify(closure, null, 2));
    await writeDeepSeekLicenseInventory(staging, closure.packages);
    await fs.rm(path.join(staging, 'node_modules/@types'), { recursive: true, force: true });

    const finalInputs = await deepSeekBuildInputs(options.vendorDir);

    if (JSON.stringify(finalInputs) !== JSON.stringify(originalInputs)) {
      throw new Error('Входы DeepSeek изменились во время сборки; candidate запрещён');
    }

    const payload = await hashRuntimePayload(staging);
    const llmPiAi = await llmPiAiContract(manifest);
    const contract = {
      format: 1,
      hostContract: 1,
      journalFormat: 1,
      source: {
        repository: manifest.repository,
        commit: manifest.commit,
        version: manifest.version,
      },
      nodeCompatibility: '^22.19.0 || >=24.0.0',
      entry: 'entry.mjs',
      capabilities: {
        web: true,
        acp: true,
        settingsWeb: true,
        settingsAcp: true,
      },
      ...(llmPiAi ? { llmPiAi } : {}),
    };
    const inputIdentity = {
      contract,
      source: vendorHash(JSON.stringify(originalInputs.source)),
      composition: COMPOSITION_REVISION,
      compositionSource: vendorHash(await fs.readFile(
        path.join(repositoryRoot, 'tools/runtimeComposition.ts'),
      )),
      dynamicImports: vendorHash(JSON.stringify(dynamicImports)),
      builder: vendorHash(await fs.readFile(fileURLToPath(import.meta.url))),
      launcher: vendorHash(await fs.readFile(path.join(staging, 'entry.mjs'))),
      webHost: vendorHash(await fs.readFile(path.join(staging, 'webHost.mjs'))),
      dependencyLock: vendorHash(await fs.readFile(path.join(dependencyRoot, 'package-lock.json'))),
      platform: process.platform,
      arch: process.arch,
      nativeAbi: process.versions.modules,
      toolInputs: originalInputs,
      nativeToolchain: (await exec('cc', ['--version'])).stdout.split('\n')[0],
    };
    const buildId = createHash('sha256').update(JSON.stringify({ inputIdentity, payload })).digest('hex');
    const descriptor = {
      ...contract,
      buildId,
      runtimeVersion: `${manifest.version}.cockpit.b${buildId.slice(0, 16)}`,
      inputIdentity,
      payload,
    };

    await fs.writeFile(path.join(staging, 'runtime.json'), JSON.stringify(descriptor, null, 2) + '\n');
    await fs.rename(staging, path.resolve(options.outputDir));
    await fs.rmdir(container);

    return path.resolve(options.outputDir);
  } catch (error) {
    await fs.rm(container, { recursive: true, force: true });

    if ((error as { stdout?: string }).stdout) {
      throw new Error((error as { stdout: string }).stdout, { cause: error });
    }

    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const vendorIndex = args.indexOf('--vendor-dir');
  const outputIndex = args.indexOf('--output-dir');

  try {
    if (outputIndex < 0 || !args[outputIndex + 1]) {
      throw new Error('Сборка требует --output-dir; общий cache: npm --prefix server run deepseek:build');
    }

    const directory = await buildDeepSeekRuntime({
      vendorDir: path.resolve(vendorIndex >= 0 ? args[vendorIndex + 1]!
        : path.join(repositoryRoot, 'third_party/deepseek-harness')),
      outputDir: path.resolve(args[outputIndex + 1]!),
    });

    console.log(directory);
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
