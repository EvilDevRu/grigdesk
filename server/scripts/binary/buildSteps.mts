import { chmod, copyFile, mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { withWorkDirectory, syncDirectory } from '../../../shared/node/files.ts';
import { sha256File } from '../../../shared/node/hash.ts';
import {
  assertUntracked, readNodeRuntime, serverSeaHostTarget, serverNodeRuntimeManifest, type NodeRuntime,
} from '../../../shared/node/nodeRuntime.ts';
import { nodeArchive, seaConfig } from '../../../shared/node/seaBuild.ts';
import { HELP_LOCALES } from '../../../shared/help/helpContracts.ts';
import { decodeServerManifest, serverManifestBytes,
  type ServerPackageManifest } from '../../src/binary/metadata.ts';

export interface BinaryBuildOptions {
  outDir: string;
  cacheDir: string;
  factoryCandidate?: string;
}

export interface BinarySmokeMetrics {
  warmRatio: number | null;
  warmP95Ratio: number | null;
  warmRatioNote: string | null;
}

/**
 * Отпечаток сборочных контрактов снимается до стадий и повторяется перед упаковкой.
 * В manifest входят только относительные имена и SHA, без путей машины и timestamp.
 */
export async function readBuildInputs(
  sourceRoot: string,
  target: NodeRuntime['platform'] = 'linux-x64',
): Promise<Record<string, string>> {
  const files = ['VERSION', 'server/package.json', 'server/package-lock.json',
    serverNodeRuntimeManifest(target), 'server/build/helpers.json', 'server/build/compatibility.json',
    'shared/node/helpSources.ts', 'web/package-lock.json',
    'server/build/binary-resources.json', 'server/build/esmBridge.cjs', 'server/scripts/buildBinary.mts',
    'go.mod', 'tools/build-factory.sh'];

  if (target === 'darwin-arm64') {
    files.push('cli/darwinBuildProcesses.ts', 'shared/node/processIdentity.ts',
      'tools/macos/process-identity.c', 'tools/macos/runner-fds.h', 'tools/macos/setsid.c',
      'tools/darwinBuildTools.mts');
  }

  for (const directory of ['server/scripts/binary', 'server/scripts/sea']) {
    for (const name of (await readdir(path.join(sourceRoot, directory))).sort()) {
      if (name.endsWith('.mts') && !name.startsWith('install')) {
        files.push(`${directory}/${name}`);
      }
    }
  }

  for (const directory of ['docs/grigdesk/guide',
    ...HELP_LOCALES.map((locale) => `docs/grigdesk/guide/${locale}`),
    'shared/help', 'web/help', 'server/scripts/help']) {
    for (const entry of await readdir(path.join(sourceRoot, directory), { withFileTypes: true })) {
      if (directory === 'docs/grigdesk/guide' && entry.isDirectory()
        && HELP_LOCALES.some((locale) => locale === entry.name)) {
        continue;
      }

      if (!entry.isFile()) {
        throw new Error(`Недопустимый вход справки: ${directory}/${entry.name}`);
      }

      files.push(`${directory}/${entry.name}`);
    }
  }

  const inputs: Record<string, string> = {};

  for (const file of files.sort()) {
    inputs[file] = await sha256File(path.join(sourceRoot, file));
  }

  return inputs;
}

export interface BinaryBuildSteps {
  platform: string;
  arch: string;
  runtime: NodeRuntime;
  run(file: string, args: string[], options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<{ stdout: string; stderr: string }>;
  factory(work: string): Promise<string>;
  prepare(work: string, options: BinaryBuildOptions): Promise<void>;
  bundle(work: string): Promise<void>;
  package(work: string, options: BinaryBuildOptions): Promise<ServerPackageManifest>;
  copy?: typeof copyFile;
  assets?(work: string): Promise<Record<string, string>>;
  postject(work: string): Promise<void>;
  smoke(binary: string, manifest: ServerPackageManifest, work: string): Promise<BinarySmokeMetrics | void>;
  beforePublish?(): void;
}

/**
 * Оба выходных каталога задаются явно, живой bin по умолчанию не выбирается.
 * Неизвестные/повторные флаги отвергаются до чтения pin или подготовки staging.
 */
export function parseBuildArgs(args: readonly string[], cwd: string): BinaryBuildOptions | { error: string } {
  const values = new Map<string, string>();
  const known = ['--out-dir', '--cache-dir', '--factory-candidate'];

  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1];

    if (!known.includes(key) || values.has(key)
      || !value || value.startsWith('--') || value.includes('\0')) {
      return { error: 'Допустимы --out-dir, --cache-dir и --factory-candidate со значениями, без повторов' };
    }

    values.set(key, path.resolve(cwd, value));
  }

  const outDir = values.get('--out-dir');
  const cacheDir = values.get('--cache-dir');

  if (!outDir || !cacheDir || outDir === '/' || cacheDir === '/' || outDir === cacheDir) {
    return { error: 'Нужны отдельные явные --out-dir и --cache-dir' };
  }

  const factoryCandidate = values.get('--factory-candidate');

  return {
    outDir,
    cacheDir,
    ...(factoryCandidate ? { factoryCandidate } : {}),
  };
}

/**
 * Архив pinned Node разрешён только как заранее подготовленный локальный вход.
 * Сборщик не скачивает runtime и не использует установленный Node как источник ELF.
 */
export async function localRuntimeArchive(cacheDir: string, runtime: NodeRuntime): Promise<string> {
  const archive = path.join(cacheDir, nodeArchive(runtime).name);

  if (await sha256File(archive).catch(() => '') !== runtime.sha256) {
    throw new Error('Нет проверенного закреплённого архива Node; явно подготовьте его в build cache');
  }

  return archive;
}

/**
 * До атомарной публикации все стадии работают с копией на файловой системе out.
 * Инъекция портов проверяет каждый отказ без настоящей сборки и без изменения старого ELF.
 */
export async function executeBinaryBuild(options: BinaryBuildOptions, steps: BinaryBuildSteps) {
  const hostTarget = serverSeaHostTarget(steps.platform, steps.arch);
  const runtime = readNodeRuntime(steps.runtime, serverNodeRuntimeManifest(hostTarget));

  if (runtime.version !== '24.21.0' || runtime.platform !== hostTarget) {
    throw new Error('Неверный pin Node серверного пакета');
  }

  const target = path.join(options.outDir, 'grigdesk-server');
  const resultFile = path.join(options.outDir, 'build-result.json');

  await mkdir(options.outDir, { recursive: true });
  await assertUntracked(target);
  await assertUntracked(resultFile);

  const archive = await localRuntimeArchive(options.cacheDir, runtime);

  return withWorkDirectory(options.outDir, async (work) => {
    const node = nodeArchive(runtime);

    await steps.run('tar', ['-xJf', archive, '--strip-components=1',
      `${node.directory}/bin/node`, `${node.directory}/LICENSE`], { cwd: work });

    if ((await readFile(path.join(work, 'LICENSE'))).length === 0) {
      throw new Error('Нет лицензии закреплённого Node');
    }

    const factoryCandidate = options.factoryCandidate ?? await steps.factory(work);
    const payloadOptions = { ...options, factoryCandidate };

    await steps.prepare(work, payloadOptions);
    await steps.bundle(work);

    const manifest = await steps.package(work, payloadOptions);
    const bytes = serverManifestBytes(manifest);

    const { runtime: runtimeInfo } = decodeServerManifest(bytes, manifest.packageId);

    if (runtimeInfo.platform !== steps.platform || runtimeInfo.arch !== steps.arch
      || runtimeInfo.node !== runtime.version) {
      throw new Error('Runtime серверного manifest не совпадает с закреплённым Node');
    }

    if (manifest.launcher.sha256 !== await sha256File(path.join(work, 'bundle.cjs'))) {
      throw new Error('Launcher изменился после вычисления package identity');
    }

    await writeFile(path.join(work, 'manifest.json'), bytes);
    await writeFile(path.join(work, 'package-id'), manifest.packageId);

    const assets = await steps.assets?.(work);

    await writeFile(path.join(work, 'sea-config.json'), JSON.stringify(seaConfig({
      ...assets,
      manifest: 'manifest.json',
      'package-id': 'package-id',
      payload: 'payload.zip',
    })));
    await steps.run(path.join(work, 'bin/node'), ['--experimental-sea-config', 'sea-config.json'], {
      cwd: work,
      env: {},
    });
    await stat(path.join(work, 'sea-prep.blob'));

    const staged = path.join(work, 'grigdesk-server');

    await (steps.copy ?? copyFile)(path.join(work, 'bin/node'), staged);
    await steps.postject(work);
    await chmod(staged, 0o755);

    if ((await stat(staged)).size > 450 * 1024 * 1024) {
      throw new Error('ELF превышает ворота 450 MiB');
    }

    const smoke = await steps.smoke(staged, manifest, work);

    const result = {
      binary: target,
      sha256: await sha256File(staged),
      size: (await stat(staged)).size,
      packageId: manifest.packageId,
      node: runtime.version,
      ...hostTarget === 'darwin-arm64' ? { runtime: runtimeInfo } : {},
      ...smoke ? {
        warmRatio: smoke.warmRatio,
        warmP95Ratio: smoke.warmP95Ratio,
        warmRatioNote: smoke.warmRatioNote,
      } : {},
    };
    const resultTemporary = path.join(work, 'build-result.json');

    await writeFile(resultTemporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });

    for (const file of [staged, resultTemporary]) {
      const handle = await open(file, 'r+');

      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }

    steps.beforePublish?.();
    await rename(staged, target);
    await rename(resultTemporary, resultFile);
    await syncDirectory(options.outDir);

    return result;
  }, { preserveOnUnconfirmedCleanup: hostTarget === 'darwin-arm64' });
}
