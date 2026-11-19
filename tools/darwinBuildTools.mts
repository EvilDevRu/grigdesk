import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { sha256 } from '../shared/node/hash.ts';
import { isArm64MachOExecutable } from '../shared/node/machO.ts';

const sources = [
  { name: 'process-identity', source: 'tools/macos/process-identity.c' },
  { name: 'setsid', source: 'tools/macos/setsid.c' },
] as const;

interface BuildTool {
  path: string;
  sha256: string;
}

export interface DarwinBuildTools {
  processIdentity: BuildTool;
  setsid: BuildTool;
}

/**
 * Проверяет MACOS в LC_BUILD_VERSION и deployment target 15.0.
 * Границы команд проверяются до чтения полей каждой записи.
 */
function macOS15Executable(bytes: Buffer): boolean {
  if (!isArm64MachOExecutable(bytes)) {
    return false;
  }

  const count = bytes.readUInt32LE(16);
  const limit = 32 + bytes.readUInt32LE(20);

  if (count > 128 || limit > bytes.length) {
    return false;
  }

  let offset = 32;
  let supportedBuild = false;

  for (let index = 0; index < count; index++) {
    if (offset + 8 > limit) {
      return false;
    }

    const kind = bytes.readUInt32LE(offset);
    const size = bytes.readUInt32LE(offset + 4);

    if (size < 8 || offset + size > limit) {
      return false;
    }

    if (kind === 0x32) {
      if (supportedBuild || size < 24 || bytes.readUInt32LE(offset + 8) !== 1
        || bytes.readUInt32LE(offset + 12) !== (15 << 16)) {
        return false;
      }

      supportedBuild = true;
    }

    offset += size;
  }

  return supportedBuild && offset === limit;
}

/**
 * Готовый инструмент читается с O_NOFOLLOW из физического приватного каталога.
 * Adopted-файл другого владельца, размера или deployment target не годится для запуска.
 */
async function verifyTool(file: string): Promise<BuildTool> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const stat = await handle.stat();

    if (!stat.isFile() || stat.uid !== process.getuid!() || stat.nlink !== 1
      || (stat.mode & 0o7777) !== 0o500 || stat.size > 8 * 1024 * 1024) {
      throw new Error('darwin_build_tool_invalid');
    }

    const bytes = await handle.readFile();

    if (!macOS15Executable(bytes)) {
      throw new Error('darwin_build_tool_invalid');
    }

    return { path: file, sha256: sha256(bytes) };
  } finally {
    await handle.close();
  }
}

/**
 * Runner сверяет физическую приватную копию setsid с SHA подготовленных инструментов.
 * Случайный одноимённый бинарник из PATH никогда не участвует в запуске.
 */
export async function readDarwinBuildSetsid(env: NodeJS.ProcessEnv): Promise<string> {
  const file = env.GRIGDESK_TEST_SETSID_BIN ?? '';
  const directory = path.dirname(file);

  if (!path.isAbsolute(file) || (await fs.realpath(directory)) !== directory) {
    throw new Error('darwin_build_tools_directory_invalid');
  }

  const stat = await fs.lstat(directory);

  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o700) {
    throw new Error('darwin_build_tools_directory_invalid');
  }

  if ((await verifyTool(file)).sha256 !== env.GRIGDESK_BUILD_SETSID_SHA256) {
    throw new Error('darwin_build_tool_invalid');
  }

  return file;
}

/**
 * Запускает xcrun с журналом в файле: потомок компилятора не может удерживать pipe.
 * После отмены scope остаётся у вызывающего для подтверждения quiescence.
 */
async function compile(input: {
  sourceFile: string;
  output: string;
  directory: string;
  signal?: AbortSignal;
}): Promise<void> {
  const logFile = input.output + '.log';
  const log = await fs.open(logFile, 'wx', 0o600);

  try {
    input.signal?.throwIfAborted();

    const child = spawn('/usr/bin/xcrun', [
      'clang', '-arch', 'arm64', '-O2', '-Wall', '-Wextra', '-mmacosx-version-min=15.0',
      '-o', input.output, input.sourceFile,
    ], {
      cwd: input.directory,
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: input.directory,
        TMPDIR: input.directory,
      },
      stdio: ['ignore', log.fd, log.fd],
      shell: false,
    });

    await new Promise<void>((resolve, reject) => {
      let failure: unknown;
      let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;

      /**
       * Сохраняет первую причину завершения и больше не даёт стартовать компилятору.
       * Лимит применяется только к уже запущенному собственному child handle.
       */
      function stop(error: unknown): void {
        if (failure !== undefined) {
          return;
        }

        failure = error;

        if (child.exitCode === null && child.signalCode === null && child.pid) {
          child.kill('SIGTERM');
        }

        cleanupDeadline = setTimeout(() => {
          child.unref();
          settle();
          reject(Object.assign(new Error(`Не подтверждён выход компилятора, журнал ${logFile}`), {
            cause: failure,
            cleanupConfirmed: false,
          }));
        }, 10_000);
      }

      const abort = () => stop(input.signal?.reason ?? new Error('darwin_build_tools_cancelled'));
      const deadline = setTimeout(() => stop(new Error('darwin_build_tools_timeout')), 120_000);

      /**
       * Закрывает только таймеры и обработчик текущего дочернего процесса.
       * Внешний AbortSignal остаётся у владельца всей сборки.
       */
      function settle(): void {
        clearTimeout(deadline);
        clearTimeout(cleanupDeadline);
        input.signal?.removeEventListener('abort', abort);
      }

      child.once('error', (error) => {
        settle();
        reject(failure ?? error);
      });
      child.once('exit', (code) => {
        settle();

        if (failure !== undefined || code !== 0) {
          reject(failure ?? new Error(`Нативный компилятор завершился кодом ${code}, журнал ${logFile}`));

          return;
        }

        resolve();
      });
      input.signal?.addEventListener('abort', abort, { once: true });

      if (input.signal?.aborted) {
        abort();
      }
    });
  } finally {
    await log.close();
  }
}

/**
 * Собирает два нативных инструмента в переданном пустом 0700 корне.
 * Инструменты считаются готовыми только после проверки каждого файла и хеша.
 */
export async function prepareDarwinBuildTools(input: {
  sourceRoot: string;
  toolsRoot: string;
  signal?: AbortSignal;
}): Promise<DarwinBuildTools> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('darwin_build_host_unsupported');
  }

  const root = await fs.lstat(input.toolsRoot);

  if (!path.isAbsolute(input.toolsRoot) || await fs.realpath(input.toolsRoot) !== input.toolsRoot
    || !root.isDirectory() || root.uid !== process.getuid!() || (root.mode & 0o7777) !== 0o700
    || (await fs.readdir(input.toolsRoot)).length !== 0) {
    throw new Error('darwin_build_tools_directory_invalid');
  }

  const tools = new Map<typeof sources[number]['name'], BuildTool>();
  const brokerSource = path.join(input.sourceRoot, 'tools/macos/runner-fds.h');

  if (!(await fs.lstat(brokerSource)).isFile() || await fs.realpath(brokerSource) !== brokerSource) {
    throw new Error('darwin_build_tool_source_invalid');
  }

  for (const { name, source } of sources) {
    input.signal?.throwIfAborted();

    const sourceFile = path.join(input.sourceRoot, source);
    const output = path.join(input.toolsRoot, name);

    if (!(await fs.lstat(sourceFile)).isFile() || await fs.realpath(sourceFile) !== sourceFile) {
      throw new Error('darwin_build_tool_source_invalid');
    }

    await compile({
      sourceFile,
      output,
      directory: input.toolsRoot,
      signal: input.signal,
    });
    input.signal?.throwIfAborted();
    await fs.chmod(output, 0o500);
    tools.set(name, await verifyTool(output));
  }

  input.signal?.throwIfAborted();

  return {
    processIdentity: tools.get('process-identity')!,
    setsid: tools.get('setsid')!,
  };
}
