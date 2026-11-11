import fs from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';

import { openArtifactDirectory } from './artifactRemoval.ts';
import {
  acquireDirectoryLock, DIRECTORY_LOCK_SUFFIXES, directoryCleanupLockPath,
  directoryLockOwnedBy, directoryLockState,
} from './directoryLock.ts';
import type { DirectoryLockReference } from './directoryLock.ts';

export const DEFAULT_ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_KEEP_GENERATIONS = 3;

export type CleanupReason = 'young' | 'locked' | 'lock-unknown' | 'protected-cache' | 'keep-latest'
  | 'current' | 'symlink' | 'not-directory' | 'disappeared' | 'io-error';

export interface CleanupEntry {
  path: string;
  bytes: number | null;
  status: 'would-delete' | 'deleted' | 'skipped' | 'error';
  reason: CleanupReason | null;
}

export interface CleanupReport {
  format: 1;
  root: string;
  dryRun: boolean;
  olderThanMs: number;
  keepGenerations: number;
  entries: CleanupEntry[];
  wouldDeleteBytes: number;
  freedBytes: number;
  errorCount: number;
  interrupted: boolean;
}

type HeldLock = DirectoryLockReference;

export interface CleanupOptions {
  root: string;
  scope: 'artifacts' | 'deepseek-tests';
  olderThanMs?: number;
  keepGenerations?: number;
  dryRun?: boolean;
  now?: number;
  protectedPaths?: readonly string[];
  heldLock?: HeldLock;
  signal?: AbortSignal;
}

interface Candidate {
  directory: string;
  stat: Stats;
  bytes: number;
  newest: number;
  generation?: string;
  theme?: string;
}

type LockReason = 'locked' | 'lock-unknown' | null;

function lockSidecar(name: string): boolean {
  return /\.(?:release|stale)-[0-9a-f]{32}$/u.test(name)
    || /\.(?:lock|install-lock)\.(?:release|stale)-/u.test(name);
}

function lockName(name: string): boolean {
  return DIRECTORY_LOCK_SUFFIXES.some((suffix) => name.endsWith(suffix)) || name === 'lock';
}

function cleanupStaging(name: string): boolean {
  return /\.cleanup-[0-9a-f]{32}$/u.test(name);
}

/**
 * Срок задаётся положительным целым числом минут, часов или суток.
 * Один парсер служит команде и helper, чтобы границы хранения не расходились.
 */
export function parseArtifactRetention(value: string): number {
  const match = /^([1-9]\d*)(m|h|d)$/u.exec(value);
  const multiplier = match?.[2] === 'm' ? 60000 : match?.[2] === 'h' ? 3600000 : 86400000;
  const result = Number(match?.[1]) * multiplier;

  if (!match || !Number.isSafeInteger(result) || result <= 0) {
    throw new Error('Срок должен быть положительным целым числом с суффиксом m, h или d');
  }

  return result;
}

/**
 * Количество поколений не округляется и не допускает переполнения числа.
 * Нулевой лимит запрещён: подготовленный кэш всегда сохраняет последние поколения.
 */
export function parseKeepGenerations(value: string): number {
  const result = Number(value);

  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(result)) {
    throw new Error('Число поколений должно быть положительным безопасным целым');
  }

  return result;
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);

  return relative === '' || !path.isAbsolute(relative) && relative !== '..'
    && !relative.startsWith(`..${path.sep}`);
}

function errorReason(error: unknown): CleanupReason {
  return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'disappeared' : 'io-error';
}

/**
 * Каждый предок проверяется заново перед обходом и эффектом без перехода по ссылкам.
 * Подмена каталога относительно канонического корня отменяет работу с этим путём.
 */
async function containedStat(root: string, directory: string): Promise<Stats> {
  if (!contains(root, directory)) {
    throw new Error('Каталог уборки вышел за выбранный корень');
  }

  let current = root;
  let stat = await fs.lstat(current);

  for (const segment of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw Object.assign(new Error('Предок каталога заменён'), { code: 'ENOENT' });
    }

    current = path.join(current, segment);
    stat = await fs.lstat(current);
  }

  return stat;
}

/**
 * Размер учитывает обычные файлы, а свежесть — каждую запись, включая вложенные ссылки.
 * Содержимое файлов не читается; последовательный обход ограничивает память большого кэша.
 */
async function measure(
  root: string, directory: string, signal?: AbortSignal,
): Promise<{ bytes: number; newest: number }> {
  signal?.throwIfAborted();

  const stat = await containedStat(root, directory);
  let bytes = stat.isFile() ? stat.size : 0;
  let newest = stat.mtimeMs;

  if (stat.isDirectory()) {
    for (const name of await fs.readdir(directory)) {
      const child = await measure(root, path.join(directory, name), signal);

      bytes += child.bytes;
      newest = Math.max(newest, child.newest);
    }
  }

  return { bytes, newest };
}

/**
 * Только точный собственный token позволяет не считать lock чужой активной работой.
 * Возраст lock никогда не служит доказательством смерти процесса.
 */
async function lockReason(directory: string, held: readonly HeldLock[]): Promise<LockReason> {
  for (const own of held) {
    if (directory === own.path && await directoryLockOwnedBy(directory, own.owner)) {
      return null;
    }
  }

  const state = await directoryLockState(directory);

  return state === 'alive' ? 'locked' : state === 'unknown' ? 'lock-unknown' : null;
}

/**
 * Упаковка payload использует как sibling lock, так и записи внутри .locks.
 * Проверка вложенного дерева не следует по ссылкам и консервативно сохраняет неизвестный lock.
 */
async function nestedLocks(
  root: string, directory: string, held: readonly HeldLock[], signal?: AbortSignal,
): Promise<LockReason> {
  signal?.throwIfAborted();

  if (lockSidecar(path.basename(directory))) {
    return null;
  }

  const stat = await containedStat(root, directory);

  if (!stat.isDirectory()) {
    return path.basename(directory) === '.locks' ? 'lock-unknown' : null;
  }

  const names = await fs.readdir(directory);

  if (names.includes('owner.json')) {
    const reason = await lockReason(directory, held);

    if (reason) {
      return reason;
    }
  }

  for (const name of names) {
    signal?.throwIfAborted();

    const child = path.join(directory, name);

    if (lockSidecar(name)) {
      continue;
    }

    if (lockName(name) || path.basename(directory) === '.locks') {
      const reason = await lockReason(child, held);

      if (reason) {
        return reason;
      }
    } else {
      const reason = await nestedLocks(root, child, held, signal);

      if (reason) {
        return reason;
      }
    }
  }

  return null;
}

/**
 * Защищены lock-и кандидата и всех его предков вплоть до выбранного корня.
 * Поколения дополнительно сохраняются при сборке темы: builder читает их после release.
 */
async function candidateLocks(
  root: string, candidate: Candidate, held: readonly HeldLock[],
  themes: Map<string, LockReason>,
  signal?: AbortSignal,
): Promise<LockReason> {
  let directory = candidate.directory;

  for (;;) {
    signal?.throwIfAborted();

    for (const suffix of DIRECTORY_LOCK_SUFFIXES) {
      const reason = await lockReason(`${directory}${suffix}`, held);

      if (reason) {
        return reason;
      }
    }

    if (directory === root) {
      break;
    }

    directory = path.dirname(directory);
  }

  const nested = await nestedLocks(root, candidate.directory, held, signal);

  if (nested || !candidate.theme) {
    return nested;
  }

  if (themes.has(candidate.theme)) {
    return themes.get(candidate.theme)!;
  }

  for (const name of await fs.readdir(candidate.theme)) {
    if (name === 'node-cache') {
      continue;
    }

    const child = path.join(candidate.theme, name);
    const reason = lockName(name) ? await lockReason(child, held)
      : await nestedLocks(root, child, held, signal);

    if (reason) {
      themes.set(candidate.theme, reason);

      return reason;
    }
  }

  themes.set(candidate.theme, null);

  return null;
}

/**
 * Полная свежесть каждого дерева измерена при сборе кандидатов, без квадратичных обходов.
 * Перед удалением обновляются состав и mtime корней; исчезнувшие поколения не занимают K мест.
 */
async function latestGenerations(
  root: string, directory: string, keep: number, known: ReadonlyMap<string, Candidate>,
): Promise<Set<string>> {
  const values: Array<{ directory: string; newest: number }> = [];

  for (const name of await fs.readdir(directory)) {
    const child = path.join(directory, name);

    if (lockName(name) || lockSidecar(name) || cleanupStaging(name)) {
      continue;
    }

    const stat = await containedStat(root, child);

    if (stat.isDirectory()) {
      values.push({ directory: child, newest: Math.max(known.get(child)?.newest ?? 0, stat.mtimeMs) });
    }
  }

  values.sort((left, right) => right.newest - left.newest
    || (left.directory < right.directory ? -1 : left.directory > right.directory ? 1 : 0));

  return new Set(values.slice(0, keep).map((value) => value.directory));
}

/**
 * Общий движок разделяет выбор кандидатов, предварительный просмотр и защищённое удаление.
 * Сам корень и структурные контейнеры сохраняются; ошибка одного дерева не скрывает остальные.
 */
export async function cleanupArtifacts(options: CleanupOptions): Promise<CleanupReport> {
  const olderThanMs = options.olderThanMs ?? DEFAULT_ARTIFACT_RETENTION_MS;
  const keepGenerations = options.keepGenerations ?? DEFAULT_KEEP_GENERATIONS;

  if (!path.isAbsolute(options.root) || path.resolve(options.root) === path.parse(options.root).root
    || !Number.isSafeInteger(olderThanMs) || olderThanMs <= 0
    || !Number.isSafeInteger(keepGenerations) || keepGenerations <= 0) {
    throw new Error('Уборка требует абсолютный корень, положительный срок и число поколений');
  }

  let rootError: unknown;
  const root = await fs.realpath(options.root).catch((error: NodeJS.ErrnoException) => {
    rootError = error.code === 'ENOENT' ? undefined : error;

    return path.resolve(options.root);
  });

  if (root === path.parse(root).root) {
    throw new Error('Корень файловой системы нельзя убирать');
  }

  const report: CleanupReport = {
    format: 1,
    root,
    dryRun: options.dryRun ?? false,
    olderThanMs,
    keepGenerations,
    entries: [],
    wouldDeleteBytes: 0,
    freedBytes: 0,
    errorCount: 0,
    interrupted: false,
  };
  const rootStat = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      rootError = error;
    }

    return null;
  });

  if (rootError) {
    report.entries.push({
      path: '',
      bytes: null,
      status: 'error',
      reason: 'io-error',
    });
    report.errorCount = 1;

    return report;
  }

  if (!rootStat) {
    return report;
  }

  if (!rootStat.isDirectory()) {
    throw new Error('Корень артефактов должен быть каталогом');
  }

  const candidates: Candidate[] = [];
  const knownGenerations = new Map<string, Candidate>();
  const themeLocks = new Map<string, LockReason>();
  const held = options.heldLock ? [options.heldLock] : [];
  const cutoff = (options.now ?? Date.now()) - olderThanMs;
  const protectedPaths = options.protectedPaths ?? [];

  function current(directory: string): boolean {
    return protectedPaths.some((protectedPath) => contains(directory, path.resolve(protectedPath)))
      || held.some((own) => contains(directory, own.path));
  }

  /**
   * Каждая запись отчёта относительна выбранному корню и имеет стабильную причину.
   * Ошибки учитываются отдельно, нормальные защиты не превращаются в отказ команды.
   */
  function append(directory: string, bytes: number | null, reason: CleanupReason): void {
    const error = reason === 'io-error';

    report.entries.push({
      path: path.relative(root, directory),
      bytes,
      status: error ? 'error' : 'skipped',
      reason,
    });
    report.errorCount += Number(error);
  }

  /**
   * Структурные контейнеры раскрываются без выбора самого контейнера для удаления.
   * Автоматический режим принимает только согласованные семейства тестовых результатов.
   */
  async function collect(directory: string, mode: 'root' | 'theme' | 'children' | 'cache' | 'generations') {
    options.signal?.throwIfAborted();

    const stat = await containedStat(root, directory);

    if (!stat.isDirectory()) {
      append(directory, null, stat.isSymbolicLink() ? 'symlink' : 'not-directory');

      return;
    }

    for (const name of (await fs.readdir(directory)).sort()) {
      const child = path.join(directory, name);

      try {
        options.signal?.throwIfAborted();

        const childStat = await containedStat(root, child);

        if (lockName(name) || name === '.locks') {
          append(child, null, 'locked');
        } else if (!childStat.isDirectory()) {
          append(child, null, childStat.isSymbolicLink() ? 'symlink' : 'not-directory');
        } else if (mode === 'root' && name === 'deepseek-binary') {
          await collect(child, 'theme');
        } else if (mode === 'theme' && name === 'node-cache') {
          await collect(child, 'cache');
        } else if (mode === 'cache') {
          if (name === 'generations') {
            await collect(child, 'generations');
          } else {
            append(child, null, 'protected-cache');
          }
        } else if (mode === 'theme' && ['test-builds', 'gates', 'build-input-tests',
          'explicit-cache'].includes(name)) {
          await collect(child, 'children');
        } else if (options.scope !== 'deepseek-tests' || mode === 'generations'
          || mode === 'children' && (path.basename(directory) === 'test-builds'
            || path.basename(directory) === 'explicit-cache'
            || path.basename(directory) === 'gates' && /^(candidate-|reports-)/u.test(name)
            || path.basename(directory) === 'build-input-tests' && name.startsWith('standalone-'))) {
          if (current(child)) {
            append(child, null, 'current');

            continue;
          }

          const candidate: Candidate = {
            directory: child,
            stat: childStat,
            ...await measure(root, child, options.signal),
            generation: mode === 'generations' && !lockSidecar(name) && !cleanupStaging(name)
              ? directory : undefined,
            theme: mode === 'generations' && !lockSidecar(name) && !cleanupStaging(name)
              ? path.dirname(path.dirname(directory)) : undefined,
          };

          candidates.push(candidate);

          if (candidate.generation) {
            knownGenerations.set(child, candidate);
          }
        }
      } catch (error) {
        options.signal?.throwIfAborted();
        append(child, null, errorReason(error));
      }
    }
  }

  /**
   * Повторная проверка сохраняет свежие данные и current независимо от старого preview.
   * Исходный inode и цепочка предков защищают от замены пути между выбором и эффектом.
   */
  async function eligible(candidate: Candidate, locks: readonly HeldLock[]): Promise<CleanupReason | null> {
    const stat = await containedStat(root, candidate.directory);
    const currentRoot = await fs.lstat(root);

    if (currentRoot.ino !== rootStat!.ino || currentRoot.dev !== rootStat!.dev
      || !stat.isDirectory() || stat.ino !== candidate.stat.ino || stat.dev !== candidate.stat.dev) {
      return stat.isSymbolicLink() ? 'symlink' : 'disappeared';
    }

    if (current(candidate.directory)) {
      return 'current';
    }

    const busy = await candidateLocks(root, candidate, locks, themeLocks, options.signal);

    if (busy) {
      return busy;
    }

    const measured = await measure(root, candidate.directory, options.signal);

    candidate.bytes = measured.bytes;
    candidate.newest = measured.newest;

    if (measured.newest >= cutoff) {
      return 'young';
    }

    if (candidate.generation && (await latestGenerations(
      root, candidate.generation, keepGenerations, knownGenerations,
    ))
      .has(candidate.directory)) {
      return 'keep-latest';
    }

    const finalStat = await containedStat(root, candidate.directory);
    const finalRoot = await fs.lstat(root);

    if (!finalStat.isDirectory() || finalStat.ino !== candidate.stat.ino
      || finalStat.dev !== candidate.stat.dev
      || finalRoot.ino !== rootStat!.ino || finalRoot.dev !== rootStat!.dev) {
      return finalStat.isSymbolicLink() ? 'symlink' : 'disappeared';
    }

    return null;
  }

  try {
    await collect(root, options.scope === 'artifacts' ? 'root' : 'theme');
  } catch (error) {
    if (options.signal?.aborted) {
      report.interrupted = true;

      return report;
    }

    append(root, null, errorReason(error));
  }

  let barrier;
  const barrierPath = directoryCleanupLockPath(root);

  if (!report.dryRun && candidates.length) {
    try {
      options.signal?.throwIfAborted();
      barrier = await acquireDirectoryLock(barrierPath, { waitMs: 0 });
    } catch (error) {
      if (options.signal?.aborted) {
        report.interrupted = true;

        return report;
      }

      const reason = (error as NodeJS.ErrnoException).code === 'directory_lock_busy'
        ? await lockReason(barrierPath, held) ?? 'locked' : errorReason(error);

      for (const candidate of candidates) {
        append(candidate.directory, candidate.bytes, reason);
      }

      return report;
    }
  }

  try {
    for (const candidate of candidates) {
      if (options.signal?.aborted) {
        report.interrupted = true;

        break;
      }

      let lock;
      let anchored;

      try {
        let reason = await eligible(candidate, held);

        if (!reason && !report.dryRun) {
          anchored = await openArtifactDirectory({
            root,
            directory: candidate.directory,
            rootStat,
            stat: candidate.stat,
            signal: options.signal,
          });
          lock = await acquireDirectoryLock(`${anchored.path}.lock`, {
            waitMs: 0,
            cleanupBarrier: barrier ? { path: barrierPath, owner: barrier.owner } : undefined,
          });
          reason = await eligible(candidate, [...held, {
            path: `${candidate.directory}.lock`,
            owner: lock.owner,
          }]);
        }

        if (reason) {
          append(candidate.directory, candidate.bytes, reason);

          continue;
        }

        if (!report.dryRun) {
          await anchored!.remove();
          report.freedBytes += candidate.bytes;
        } else {
          report.wouldDeleteBytes += candidate.bytes;
        }

        report.entries.push({
          path: path.relative(root, candidate.directory),
          bytes: candidate.bytes,
          status: report.dryRun ? 'would-delete' : 'deleted',
          reason: null,
        });
      } catch (error) {
        if (options.signal?.aborted) {
          report.interrupted = true;

          break;
        }

        const reason = (error as NodeJS.ErrnoException).code === 'directory_lock_busy'
          ? await lockReason(`${candidate.directory}.lock`, held) ?? 'locked' : errorReason(error);

        append(candidate.directory, candidate.bytes, reason);
      } finally {
        try {
          await lock?.release();
        } catch {
          append(`${candidate.directory}.lock`, null, 'io-error');
        } finally {
          try {
            await anchored?.close();
          } catch {
            append(candidate.directory, null, 'io-error');
          }
        }
      }
    }
  } finally {
    try {
      await barrier?.release();
    } catch {
      append(root, null, 'io-error');
    }
  }

  report.interrupted ||= options.signal?.aborted ?? false;

  return report;
}
