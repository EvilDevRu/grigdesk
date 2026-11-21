import { readProductBuildVersion } from '../../shared/node/releaseBuild.ts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDarwinBuildProcess } from '../../cli/darwinBuildProcesses.ts';
import {
  readTargetNodeRuntime, SEA_FUSE, seaHostTarget, serverNodeRuntimeManifest,
} from '../../shared/node/nodeRuntime.ts';
import { injectSea } from '../../shared/node/seaBuild.ts';
import {
  configureDarwinBuildProcessHelper, stageDarwinProcessAssets,
} from '../../shared/node/processIdentity.ts';
import { readDarwinBuildSetsid } from '../../tools/darwinBuildTools.mts';
import { postjectCli } from './sea/buildSteps.mts';
import { executeBinaryBuild, localRuntimeArchive, parseBuildArgs, readBuildInputs,
  type BinaryBuildOptions, type BinarySmokeMetrics } from './binary/buildSteps.mts';
import { serverExecutableGuard } from './binary/installFiles.mts';
import type { ServerPackageManifest } from '../src/binary/metadata.ts';

const sourceRoot = path.resolve(import.meta.dirname, '../..');

/**
 * Каждая стадия работает под сторожем платформы и пишет собственные log/exit.
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
  signal?: AbortSignal;
  timeoutMs?: number;
}) {
  const logFile = `${input.prefix}${input.name}.log`;
  const exitFile = `${input.prefix}${input.name}.exit`;
  const log = await open(logFile, 'w', 0o600);
  let code = 1;

  process.stdout.write(`Стадия ${input.name}: ${logFile}\n`);

  try {
    let pending = Promise.resolve();

    /**
     * Полные строки сохраняются общей очередью без перемешивания их частичных порций.
     * Незавершённая строка ограничена 256 КиБ, а drain ограничивает буфер внешнего потока.
     */
    async function mirror(source: Readable, destination: Writable, signal?: AbortSignal): Promise<void> {
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

        signal?.throwIfAborted();

        if (!destination.write(chunk)) {
          await once(destination, 'drain', { signal });
        }
      }

      if (partial.length) {
        pending = pending.then(async () => {
          await log.writeFile(partial);
        });
        await pending;
      }
    }

    if (process.platform === 'darwin') {
      await configureDarwinBuildProcessHelper(input.env);

      const setsid = await readDarwinBuildSetsid(input.env);
      const result = await runDarwinBuildProcess({
        ...input,
        setsid,
        output: input.streamOutput ? 'pipe' : log.fd,
        timeoutMs: input.timeoutMs ?? 3600000,
        capture: input.streamOutput ? async (child, signal) => {
          await Promise.all([
            mirror(child.stdout!, process.stdout, signal), mirror(child.stderr!, process.stderr, signal),
          ]);
        } : undefined,
      });

      code = result.reason ?? result.code ?? 1;

      if (code !== 0 || !result.cleanupConfirmed) {
        const detail = !result.cleanupConfirmed ? 'не подтверждено завершение процессов'
          : (result.error as Error | undefined)?.message ?? `код ${code}`;

        throw Object.assign(new Error(`Стадия ${input.name}: ${detail}; журнал ${logFile}`, {
          cause: result.error,
        }), { code: code || 1, cleanupConfirmed: result.cleanupConfirmed });
      }

      return { stdout: '', stderr: '' };
    }

    const child = spawn('/usr/bin/timeout', ['--foreground', '3600', input.file, ...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', input.streamOutput ? 'pipe' : log.fd, input.streamOutput ? 'pipe' : log.fd],
    });

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
async function buildBinaryWithSignal(options: BinaryBuildOptions, signal?: AbortSignal) {
  const streamOutput = process.env.GRIGDESK_CTL_BUILD_OBSERVED === '1';
  const target = seaHostTarget();
  const manifestPath = path.join(sourceRoot, serverNodeRuntimeManifest(target));
  const runtime = await readTargetNodeRuntime(manifestPath, target);
  const archive = await localRuntimeArchive(options.cacheDir, runtime);
  const buildInputs = await readBuildInputs(sourceRoot, target);
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
    GRIGDESK_RELEASE_VERSION: await readProductBuildVersion(sourceRoot),
    NODE_ENV: 'production',
    NODE_TEST_MAX_RSS_MB: '4096',
  };

  if (target === 'darwin-arm64') {
    env.GRIGDESK_BUILD_PROCESS_HELPER = process.env.GRIGDESK_BUILD_PROCESS_HELPER;
    env.GRIGDESK_BUILD_PROCESS_HELPER_SHA256 = process.env.GRIGDESK_BUILD_PROCESS_HELPER_SHA256;
    env.GRIGDESK_TEST_SETSID_BIN = process.env.GRIGDESK_TEST_SETSID_BIN;
    env.GRIGDESK_BUILD_SETSID_SHA256 = process.env.GRIGDESK_BUILD_SETSID_SHA256;
  }

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
    signal,
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
      signal,
    }),
    factory: async (work) => {
      const output = path.join(work, 'factory-bin');

      await loggedStage({
        name: 'factory',
        file: '/usr/bin/bash',
        args: [path.join(sourceRoot, 'tools/build-factory.sh'), output],
        cwd: sourceRoot,
        env: {
          ...env,
          PATH: process.env.PATH || env.PATH,
          GOCACHE: path.join(options.cacheDir, 'go'),
          GOMODCACHE: path.join(options.cacheDir, 'go-modules'),
          GOPROXY: 'off',
        },
        prefix,
        streamOutput,
        signal,
      });

      return path.join(output, 'factory');
    },
    prepare: async (work, input) => {
      await writeFile(path.join(work, 'build-input.json'), JSON.stringify({
        sourceRoot,
        work,
        cacheDir: options.cacheDir,
        archive,
        buildInputs,
        factoryCandidate: input.factoryCandidate,
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
    assets: target === 'darwin-arm64' ? stageDarwinProcessAssets : undefined,
    postject: async (work) => {
      await injectSea({
        target,
        work,
        node: path.join(work, 'bin/node'),
        postject: await postjectCli(path.join(sourceRoot, 'server')),
        executable: 'grigdesk-server',
        fuse: SEA_FUSE,
        run: (file, args, { cwd }) => loggedStage({
          name: file === '/usr/bin/codesign' ? `postject-${args[0]!.slice(2)}` : 'postject',
          file,
          args,
          cwd,
          env,
          prefix,
          streamOutput,
          signal,
        }),
      });

      const executable = await open(path.join(work, 'grigdesk-server'), 'r');

      try {
        await serverExecutableGuard(target)(executable);
      } finally {
        await executable.close();
      }
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
        signal,
      });

      const report = JSON.parse(await readFile(reportFile, 'utf8')) as BinarySmokeMetrics;

      return {
        warmRatio: report.warmRatio,
        warmP95Ratio: report.warmP95Ratio,
        warmRatioNote: report.warmRatioNote,
      };
    },
    beforePublish: () => signal?.throwIfAborted(),
  });
}

/**
 * На Mac одна причина отмены действует до публикации готового бинарника.
 * Linux оставляет обработку сигналов своему существующему окружению сборки.
 */
export async function buildBinary(options: BinaryBuildOptions) {
  if (process.platform !== 'darwin') {
    return buildBinaryWithSignal(options);
  }

  const controller = new AbortController();
  const cancel = (signal: NodeJS.Signals) => {
    const code = signal === 'SIGINT' ? 130 : 143;

    controller.abort(Object.assign(new Error('Сборка отменена'), { code }));
  };

  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);

  try {
    return await buildBinaryWithSignal(options, controller.signal);
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
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

      const code = (error as { code?: unknown } | null)?.code;

      process.exitCode = process.platform === 'darwin' && (code === 124 || code === 130 || code === 143)
        ? code : 1;
    });
  }
}
