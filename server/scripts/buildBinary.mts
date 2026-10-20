import { spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readNodeRuntime, SEA_FUSE } from '../../shared/node/nodeRuntime.ts';
import { postjectCli } from './sea/buildSteps.mts';
import { executeBinaryBuild, localRuntimeArchive, parseBuildArgs, readBuildInputs,
  type BinaryBuildOptions, type BinarySmokeMetrics } from './binary/buildSteps.mts';
import type { ServerPackageManifest } from '../src/binary/metadata.ts';

const sourceRoot = path.resolve(import.meta.dirname, '../..');

/**
 * Каждая стадия работает на переднем плане под timeout и пишет собственные log/exit.
 * Вывод компилятора не накапливается в памяти и не смешивается с JSON результата сборки.
 */
async function loggedStage(input: {
  name: string;
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prefix: string;
}) {
  const logFile = `${input.prefix}${input.name}.log`;
  const exitFile = `${input.prefix}${input.name}.exit`;
  const log = await open(logFile, 'w', 0o600);
  let code = 1;

  process.stdout.write(`Стадия ${input.name}: ${logFile}\n`);

  try {
    const child = spawn('/usr/bin/timeout', ['--foreground', '3600', input.file, ...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', log.fd, log.fd],
    });
    const result = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (status) => resolve(status ?? 1));
    });

    code = result;

    if (code !== 0) {
      throw new Error(`Стадия ${input.name} завершилась кодом ${code}; журнал ${logFile}`);
    }

    return { stdout: '', stderr: '' };
  } finally {
    await log.close();
    await writeFile(exitFile, `${code}\n`);
  }
}

/**
 * Builder объединяет проверенные стадии, не собирая старый tar или внутренний SEA сервера.
 * Единственная публикация ELF происходит после metadata/full verify/authenticated HTTP/IPC E0.
 */
export async function buildBinary(options: BinaryBuildOptions) {
  const runtime = readNodeRuntime(JSON.parse(await readFile(
    path.join(sourceRoot, 'server/build/node-runtime.json'), 'utf8',
  )), 'server/build/node-runtime.json');
  const archive = await localRuntimeArchive(options.cacheDir, runtime);
  const buildInputs = await readBuildInputs(sourceRoot);
  const runRoot = path.dirname(options.outDir);
  const prefix = path.join(runRoot, `s22-${Date.now().toString(36)}-`);
  const home = path.join(options.cacheDir, 'build-home');
  const temporary = path.join(options.cacheDir, 'tmp');
  const env: NodeJS.ProcessEnv = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: temporary,
    npm_config_cache: path.join(options.cacheDir, 'npm'),
    XDG_CACHE_HOME: path.join(options.cacheDir, 'xdg'),
    GRIGDESK_ARTIFACTS_DIR: runRoot,
    NODE_ENV: 'production',
    NODE_TEST_MAX_RSS_MB: '4096',
  };

  await mkdir(home, { recursive: true });
  await mkdir(temporary, { recursive: true });

  const nodeStage = async (name: string, work: string) => loggedStage({
    name,
    file: process.execPath,
    args: [path.join(sourceRoot, 'server/scripts/binary/buildStage.mts'), name,
      path.join(work, 'build-input.json')],
    cwd: sourceRoot,
    env,
    prefix,
  });

  return executeBinaryBuild(options, {
    platform: process.platform,
    arch: process.arch,
    runtime,
    run: (file, args, context) => loggedStage({
      name: file === 'tar' ? 'extract-node' : 'blob',
      file,
      args,
      cwd: context.cwd,
      env: { ...env, ...context.env },
      prefix,
    }),
    prepare: async (work) => {
      await writeFile(path.join(work, 'build-input.json'), JSON.stringify({
        sourceRoot,
        work,
        cacheDir: options.cacheDir,
        archive,
        buildInputs,
      }));
      await nodeStage('prepare', work);
    },
    bundle: async (work) => {
      await nodeStage('bundle', work);
    },
    package: async (work) => {
      await nodeStage('package', work);

      return JSON.parse(await readFile(path.join(work, 'prepared-manifest.json'), 'utf8')) as
        ServerPackageManifest;
    },
    postject: async (work) => {
      await loggedStage({
        name: 'postject',
        file: path.join(work, 'bin/node'),
        args: [await postjectCli(path.join(sourceRoot, 'server')), 'grigdesk-server', 'NODE_SEA_BLOB',
          'sea-prep.blob', '--sentinel-fuse', SEA_FUSE],
        cwd: work,
        env,
        prefix,
      });
    },
    smoke: async (binary, manifest, work) => {
      const entry = path.join(work, 'e0.test.mjs');
      const reportFile = `${prefix}e0.json`;
      const module = path.join(sourceRoot, 'server/scripts/binary/smoke.mts');
      const input = {
        binary,
        manifest,
        cacheDir: options.cacheDir,
        reportFile,
      };

      await writeFile(entry, [
        'import test from "node:test";',
        `import { runBinarySmoke } from ${JSON.stringify(module)};`,
        'await test("S22 E0: metadata/prepare/verify/HTTP/IPC/тайминги",',
        '  { timeout: 180000 }, async () => {',
        `    await runBinarySmoke(${JSON.stringify(input)});`,
        '  });',
      ].join('\n'));
      await loggedStage({
        name: 'smoke',
        file: '/bin/bash',
        args: [path.join(sourceRoot, 'tests/run-node-tests-safe.sh'),
          '--test', '--test-concurrency=1', entry],
        cwd: sourceRoot,
        env,
        prefix,
      });

      const report = JSON.parse(await readFile(reportFile, 'utf8')) as BinarySmokeMetrics;

      return {
        warmRatio: report.warmRatio,
        warmP95Ratio: report.warmP95Ratio,
        warmRatioNote: report.warmRatioNote,
      };
    },
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseBuildArgs(process.argv.slice(2), process.cwd());

  if ('error' in options) {
    process.stderr.write(`${options.error}\n`);
    process.exitCode = 2;
  } else {
    await buildBinary(options).then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }, (error: unknown) => {
      process.stderr.write(`Сборка серверного ELF не удалась: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
  }
}
