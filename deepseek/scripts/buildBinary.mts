import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { build } from 'esbuild';

import { decodeDeepSeekRuntimeInfo } from '../../shared/chat/deepSeekBinary.ts';
import { readNodeRuntime, SEA_FUSE } from '../../shared/node/nodeRuntime.ts';
import { downloadFile } from '../../shared/node/seaBuild.ts';

import { prepareBinaryPayload } from './buildPayload.mts';
import { executeBinaryBuild, parseBuildArgs, type BinaryBuildOptions } from './buildSteps.mts';

const run = promisify(execFile);
const packageDir = fileURLToPath(new URL('..', import.meta.url));

/**
 * Все три entry собираются внутри work, готовый ELF не импортирует исходники или npm deps.
 * CJS-launcher не использует snapshot, worker bootstrap и verifier исполняются обычным Node.
 */
async function bundle(work: string): Promise<void> {
  for (const [entry, output, format] of [
    ['src/launcher/main.ts', 'bundle.cjs', 'cjs'],
    ['src/launcher/workerBootstrap.ts', 'worker-bootstrap.mjs', 'esm'],
    ['src/runtime/verifyWorker.ts', 'worker-verify.mjs', 'esm'],
  ] as const) {
    const result = await build({
      absWorkingDir: packageDir,
      entryPoints: [entry],
      outfile: path.join(work, output),
      bundle: true,
      platform: 'node',
      target: 'node24',
      format,
      logLevel: 'silent',
    });

    if (result.warnings.length > 0) {
      throw new Error(result.warnings.map((warning) => warning.text).join('\n'));
    }
  }
}

/**
 * Реальные run/postject/download принадлежат builder, тестовый execute API внедряет их отдельно.
 * Публикация разрешена лишь после metadata и полного --verify собственным обычным Node.
 */
export async function buildDeepSeekBinary(options: BinaryBuildOptions) {
  const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  const runtime = readNodeRuntime(JSON.parse(await readFile(
    path.join(packageDir, 'build/node-runtime.json'), 'utf8',
  )), 'deepseek/build/node-runtime.json');

  return executeBinaryBuild(options, {
    platform: process.platform,
    arch: process.arch,
    runtime,
    defaultBinaryVersion: manifest.version,
    download: downloadFile,
    run: (command, args, input) => run(command, args, { ...input, maxBuffer: 4 * 1024 * 1024 }),
    bundle,
    prepare: prepareBinaryPayload,
    postject: async (work) => {
      const root = path.join(packageDir, 'node_modules/postject');
      const postject = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
      const cli = path.join(root, typeof postject.bin === 'string' ? postject.bin : postject.bin.postject);

      await run(process.execPath, [cli, 'deepseek', 'NODE_SEA_BLOB', 'sea-prep.blob',
        '--sentinel-fuse', SEA_FUSE], { cwd: work, maxBuffer: 4 * 1024 * 1024 });
    },
    smoke: async (binary, expected, work) => {
      const result = await run(binary, ['--runtime-info', '--json'], { env: { PATH: '' }, timeout: 30000 });
      const info = decodeDeepSeekRuntimeInfo(JSON.parse(result.stdout));

      if (info.packageId !== expected.packageId || result.stderr !== '') {
        throw new Error('Metadata smoke DeepSeek не подтвердил candidate');
      }

      const verifyArgs = ['--cache-dir', path.join(work, 'smoke-cache'), '--verify', '--json'];
      const verified = await run(binary, verifyArgs, {
        env: { PATH: '' },
        timeout: 120000,
        maxBuffer: 65536,
      });
      const proof = JSON.parse(verified.stdout);

      if (proof.packageId !== expected.packageId || proof.verified !== true || proof.glmPlugin !== true
        || verified.stderr !== '') {
        throw new Error('Полный smoke DeepSeek не подтвердил candidate');
      }
    },
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parsed = parseBuildArgs(process.argv.slice(2), process.cwd(), packageDir);

  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = 2;
  } else {
    await buildDeepSeekBinary(parsed).then((info) => {
      process.stdout.write(`${JSON.stringify(info)}\n`);
    }, (error: unknown) => {
      process.stderr.write(`Сборка DeepSeek не удалась: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
  }
}
