import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
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
export async function loggedStage(input: {
  name: string;
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prefix: string;
  streamOutput?: boolean;
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
      stdio: ['ignore', input.streamOutput ? 'pipe' : log.fd, input.streamOutput ? 'pipe' : log.fd],
    });
    let pending = Promise.resolve();

    /**
     * Полные строки сохраняются общей очередью без перемешивания их частичных порций.
     * Незавершённая строка ограничена 256 КиБ, а drain ограничивает буфер внешнего потока.
     */
    async function mirror(source: Readable, destination: Writable): Promise<void> {
      let partial = Buffer.alloc(0);

      for await (const chunk of source) {
        partial = Buffer.concat([partial, chunk]);

        const newline = partial.lastIndexOf(10);
        const length = newline >= 0 ? newline + 1 : partial.length >= 262144 ? 262144 : 0;

        if (length) {
          const bytes = partial.subarray(0, length);

          partial = partial.subarray(length);
          pending = pending.then(async () => {
            await log.writeFile(bytes);
          });
          await pending;
        }

        if (!destination.write(chunk)) {
          await once(destination, 'drain');
        }
      }

      if (partial.length) {
        pending = pending.then(async () => {
          await log.writeFile(partial);
        });
        await pending;
      }
    }

    const streams = input.streamOutput
      ? Promise.all([mirror(child.stdout!, process.stdout), mirror(child.stderr!, process.stderr)])
      : Promise.resolve();
    const result = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status) => resolve(status ?? 1));
    });

    await streams;
    code = result;

    if (code !== 0) {
      throw Object.assign(new Error(
        `Стадия ${input.name} завершилась кодом ${code}; журнал ${logFile}`,
      ), { code });
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
  const streamOutput = process.env.GRIGDESK_CTL_BUILD_OBSERVED === '1';
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
    streamOutput,
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
      streamOutput,
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
        streamOutput,
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
        streamOutput,
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
