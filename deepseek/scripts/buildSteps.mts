import { chmod, copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assertUntracked, ensureNodeArchive, publishFile, readPinnedNodeRuntime }
  from '../../shared/node/binaryBuild.ts';
import { withWorkDirectory } from '../../shared/node/files.ts';
import { sha256File } from '../../shared/node/hash.ts';
import { nodeArchive, seaConfig } from '../../shared/node/seaBuild.ts';
import { createDeepSeekMetadata, manifestBytes } from '../src/runtime/metadata.ts';
import type { DeepSeekManifest } from '../src/runtime/metadata.ts';
import type { DeepSeekRuntimeInfo } from '../../shared/chat/deepSeekBinary.ts';
import type { NodeRuntime } from '../../shared/node/binaryBuild.ts';

export interface BinaryBuildOptions {
  outDir: string;
  nodeCacheDir: string;
  binaryVersion: string | null;
  payload: string | null;
  vendorDir?: string;
}

export interface BinaryBuildSteps {
  platform: string;
  arch: string;
  runtime: NodeRuntime;
  defaultBinaryVersion: string;
  download(url: string, file: string): Promise<void>;
  run(command: string, args: string[], options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<{ stdout: string; stderr: string }>;
  bundle(work: string): Promise<void>;
  prepare(work: string, options: BinaryBuildOptions): Promise<DeepSeekManifest>;
  postject(work: string): Promise<void>;
  smoke(binary: string, manifest: DeepSeekRuntimeInfo, work: string): Promise<void>;
}

/**
 * Build-флаги проверяются до загрузок; node-cache-dir разрешается от cwd сборщика.
 * Launcher cache-dir является другим контрактом и здесь не принимается.
 */
export function parseBuildArgs(
  args: readonly string[],
  cwd: string,
  packageDir: string,
): BinaryBuildOptions | { error: string } {
  const result: BinaryBuildOptions = {
    outDir: path.resolve(packageDir, '../bin'),
    nodeCacheDir: path.join(packageDir, '.cache'),
    binaryVersion: null,
    payload: null,
  };
  const flags = new Map<string, keyof BinaryBuildOptions>([
    ['--out-dir', 'outDir'],
    ['--node-cache-dir', 'nodeCacheDir'],
    ['--binary-version', 'binaryVersion'],
    ['--payload', 'payload'],
    ['--vendor-dir', 'vendorDir'],
  ]);
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 2) {
    const key = flags.get(args[index] ?? '');
    const value = args[index + 1];

    if (!key || seen.has(key) || !value || value.startsWith('--') || value.includes('\0')) {
      return { error: 'Ожидаются --out-dir, --node-cache-dir, --binary-version или --payload со значением' };
    }

    seen.add(key);
    result[key] = key === 'binaryVersion' ? value : path.resolve(cwd, value);
  }

  if (result.vendorDir && result.payload) {
    return { error: '--vendor-dir несовместим с --payload: candidate должен быть собран заново' };
  }

  return result;
}

/**
 * Шаги сборки внедряются отдельно, чтобы отказ каждого проверялся без настоящего postject.
 * Старый output остаётся целым до успешного smoke нового ELF.
 */
export async function executeBinaryBuild(
  options: BinaryBuildOptions,
  steps: BinaryBuildSteps,
): Promise<DeepSeekRuntimeInfo> {
  if (steps.platform !== 'linux' || steps.arch !== 'x64') {
    throw new Error('Сборка DeepSeek поддерживает только Linux x64');
  }

  const runtime = readPinnedNodeRuntime(steps.runtime, 'deepseek/build/node-runtime.json');
  const target = path.join(options.outDir, 'deepseek');

  await assertUntracked(target);

  const archive = await ensureNodeArchive(runtime, options.nodeCacheDir, {
    download: steps.download,
    attempts: 1,
  });
  const node = nodeArchive(runtime);

  return withWorkDirectory(options.nodeCacheDir, async (work) => {
    await steps.run('tar', ['-xJf', archive, '--strip-components=1',
      `${node.directory}/bin/node`, `${node.directory}/LICENSE`], { cwd: work });

    if ((await readFile(path.join(work, 'LICENSE'))).length === 0) {
      throw new Error('Отсутствует лицензия worker Node');
    }

    await steps.bundle(work);

    const prepared = await steps.prepare(work, options);
    const manifest = createDeepSeekMetadata({
      ...prepared,
      binaryVersion: options.binaryVersion ?? steps.defaultBinaryVersion,
      launcher: await sha256File(path.join(work, 'bundle.cjs')),
    });

    await writeFile(path.join(work, 'manifest.json'), manifestBytes(manifest));
    await writeFile(path.join(work, 'package-id'), manifest.packageId);
    await writeFile(path.join(work, 'sea-config.json'), JSON.stringify(seaConfig({
      'manifest.json': 'manifest.json',
      'package-id': 'package-id',
      'payload.zip': 'payload.zip',
    })));
    await steps.run(path.join(work, 'bin/node'), ['--experimental-sea-config', 'sea-config.json'], {
      cwd: work,
      env: {},
    });
    await copyFile(path.join(work, 'bin/node'), path.join(work, 'deepseek'));
    await steps.postject(work);
    await chmod(path.join(work, 'deepseek'), 0o755);
    await steps.smoke(path.join(work, 'deepseek'), manifest, work);
    await publishFile(path.join(work, 'deepseek'), target);

    return manifest;
  });
}
