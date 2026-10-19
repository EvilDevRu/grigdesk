// Единственная очередь тяжёлых GLB операций. Buffer/native память ограничивается
// watchdog дочернего процесса, heap — флагом Node; Fastify получает типизированный отказ.
import { spawn } from 'node:child_process';

import { helperCommand } from '../runtimePaths.ts';
import { constants as FS, promises as fs } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { parseStudio3d } from '../../../../shared/studio3d/studio3dContracts.ts';
import { DocumentReader } from '../documents/reader.ts';
import { withPathLock } from '../pathLock.ts';
import { GLB_MAX_BYTES } from './glb.ts';
import type { GlbStats, WrapOptions } from './glb.ts';
import { openVerified, pinDirectory } from './safePath.ts';
import type { PinnedDirectory } from './safePath.ts';

const reader = new DocumentReader();
const queueKey = 'studio3d:analysis-process';
const OUTPUT_MAX_BYTES = 16 * 1024 * 1024;

export interface AnalysisDeps {
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
  maxRssMb?: number;
  onRss?: (bytes: number) => void;
  root?: string;
  signal?: AbortSignal;
}

export class AnalysisError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code === 'too-large' ? 'Модель слишком велика для анализа (до 150 МиБ).'
      : code === 'timeout' ? 'Анализ модели не завершился за допустимое время.'
        : code === 'memory' ? 'Анализ модели превысил предел памяти.'
          : 'Не удалось безопасно обработать GLB.');
    this.name = 'AnalysisError';
    this.code = code;
  }
}

/**
 * Ревизия сравнивается по inode, размеру и наносекундным временам. Изменившийся
 * файл не становится достоверной сводкой даже при сохранённом mtime.
 */
function revision(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

/**
 * Подтверждает обычный source через контракт документов и передаёт worker-у fd.
 * Строковый путь не открывается второй раз внутри ребёнка, предел проверяется заранее.
 */
async function processFile(
  input: string,
  output: string | null,
  wrap: WrapOptions | null,
  deps: AnalysisDeps,
) {
  return withPathLock(queueKey, async () => {
    if (deps.signal?.aborted) {
      throw new AnalysisError('aborted');
    }

    const opened = await openVerified(deps.root ?? path.dirname(input), input);
    const canonical = opened.canonical;
    const handle = opened.handle;
    let directory: FileHandle | null = null;
    let pinned: PinnedDirectory | null = null;

    try {
      const before = await handle.stat({ bigint: true });

      if (!before.isFile() || before.nlink !== 1n) {
        throw new AnalysisError('unsafe-file');
      }

      if (before.size > BigInt(GLB_MAX_BYTES)) {
        throw new AnalysisError('too-large');
      }

      await reader.verifiedOpenedPath(handle, path.dirname(canonical), canonical);
      await opened.verify();

      let outputDirectory: string | null = null;
      let outputName: string | null = null;

      if (output) {
        outputDirectory = await fs.realpath(path.dirname(output));
        outputName = path.basename(output);

        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(outputName) || outputName.includes('..')) {
          throw new AnalysisError('unsafe-output');
        }

        pinned = await pinDirectory(deps.root ?? outputDirectory, outputDirectory);
        directory = pinned.handle;
        await reader.verifiedOpenedPath(directory, outputDirectory, outputDirectory);
      }

      const result = await runWorker(handle, directory, {
        operation: wrap ? 'rewrite' : 'inspect',
        sourcePath: canonical,
        outputDirectory,
        outputName,
        wrap,
      }, deps);
      const after = await handle.stat({ bigint: true });

      await reader.verifiedOpenedPath(handle, path.dirname(canonical), canonical);

      if (revision(before) !== revision(after)) {
        throw new AnalysisError('changed');
      }

      await opened.verify();
      await pinned?.verify();

      if (directory && outputDirectory) {
        await reader.verifiedOpenedPath(directory, outputDirectory, outputDirectory);
      }

      return result;
    } finally {
      await handle.close();
      await pinned?.close();
    }
  });
}

/**
 * RSS берётся у собственного ребёнка в /proc, не у всей машины. Отсутствующий
 * процесс означает окончание; права на чужие процессы для анализа не требуются.
 */
async function rssOf(pid: number): Promise<number> {
  const text = await fs.readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
  const value = /^VmRSS:\s+(\d+)\s+kB$/m.exec(text);

  return value ? Number(value[1]) * 1024 : 0;
}

/**
 * Worker получает только маленький запрос и унаследованные дескрипторы. Срок/RSS
 * ограничивают только этого ребёнка; stdout также имеет предел до JSON.parse.
 */
function runWorker(
  input: FileHandle,
  directory: FileHandle | null,
  request: Record<string, unknown>,
  deps: AnalysisDeps,
): Promise<GlbStats> {
  return new Promise((resolve, reject) => {
    const worker = helperCommand('studio3d-analysis-worker', []);
    const child = (deps.spawnImpl ?? spawn)(worker.command, [
      '--max-old-space-size=256',
      ...worker.args,
      JSON.stringify(request),
    ], {
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe', input.fd, ...(directory ? [directory.fd] : [])],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: AnalysisError | null = null;
    let sampling = false;
    const terminate = (code: string) => {
      failure ??= new AnalysisError(code);
      child.kill('SIGKILL');
    };
    const onAbort = () => terminate('aborted');

    deps.signal?.addEventListener('abort', onAbort, { once: true });

    if (deps.signal?.aborted) {
      onAbort();
    }
    
    const timeout = setTimeout(() => terminate('timeout'), Math.min(deps.timeoutMs ?? 60_000, 60_000));
    const watchdog = setInterval(() => {
      if (sampling || !child.pid) {
        return;
      }

      sampling = true;
      void rssOf(child.pid).then((bytes) => {
        deps.onRss?.(bytes);

        if (bytes > Math.min(deps.maxRssMb ?? 512, 512) * 1024 * 1024) {
          terminate('memory');
        }
      }).finally(() => {
        sampling = false;
      });
    }, 10);

    child.stdout?.on('data', (bytes: Buffer) => {
      size += bytes.length;

      if (size > OUTPUT_MAX_BYTES) {
        terminate('output-limit');
      } else {
        chunks.push(bytes);
      }
    });
    child.stderr?.on('data', () => {});
    child.once('error', () => {
      failure = new AnalysisError('worker-start');
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      clearInterval(watchdog);
      deps.signal?.removeEventListener('abort', onAbort);

      if (failure || code !== 0) {
        reject(failure ?? new AnalysisError('worker-exit'));

        return;
      }

      try {
        const response = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));

        if (!response || response.ok !== true || !response.stats || typeof response.stats !== 'object') {
          throw new AnalysisError(typeof response?.code === 'string' ? response.code : 'worker-response');
        }

        resolve(parseStudio3d.stats(response.stats));
      } catch (error) {
        reject(error instanceof AnalysisError ? error : new AnalysisError('worker-response'));
      }
    });
  });
}

/**
 * Сводка считается вне HTTP процесса и общей очередью с rewrite. Неизвестные
 * размеры остаются null, а превышение ресурсного предела — AnalysisError.
 */
export function inspectGlbFile(inputPath: string, deps: AnalysisDeps = {}): Promise<GlbStats> {
  return processFile(inputPath, null, null, deps);
}

/**
 * Результат rewrite публикуется worker-ом атомарно в закреплённый каталог.
 * Существующее имя не заменяется; библиотека создаёт новую папку версии заранее.
 */
export function rewriteGlbFile(
  inputPath: string,
  outputPath: string,
  options: WrapOptions,
  deps: AnalysisDeps = {},
): Promise<GlbStats> {
  return processFile(inputPath, outputPath, options, deps);
}
