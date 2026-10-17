import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { computePayloadDigest } from './payloadDigest.ts';
import type {
  CleanupEntry,
  DirectoryIdentity,
  PluginApplyIntent,
  PluginInstallStateStore,
} from './stateStore.ts';
import { summarizeInstallJob } from './stateStore.ts';
import { errorInfo, installError } from './errors.ts';
import { decodeInstallState } from './stateValidation.ts';
import type { PluginInstallErrorInfo } from '../../../../shared/plugins/pluginInstallContracts.ts';

export interface ApplyRoots {
  pluginsDir: string;
  workDir: string;
}

export interface ApplyFs {
  roots: ApplyRoots;
  lstatIdentity(file: string, npmDirs?: string[]): Promise<DirectoryIdentity | null>;
  rename(from: string, to: string): Promise<void>;
  ensureDir(directory: string): Promise<void>;
  syncDir(directory: string): Promise<void>;
  removeCleanup(entry: CleanupEntry): Promise<void>;
}

export interface ApplyOutcome {
  outcome: 'none' | 'completed' | 'reverted' | 'blocked';
  jobId: string | null;
  error?: PluginInstallErrorInfo;
}

/**
 * Native filesystem вычисляет identity по inode и полному managed payload.
 * Пути задаются доверенной конфигурацией, а не persisted JSON.
 */
export function createApplyFs(roots: ApplyRoots): ApplyFs {
  const native: ApplyFs = {
    roots,
    lstatIdentity: async (file, npmDirs) => {
      await assertNativePath(roots, file);

      const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return null;
        }

        throw error;
      });

      if (!info) {
        return null;
      }

      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw installError('recovery_required');
      }

      return {
        dev: info.dev,
        ino: info.ino,
        ...(npmDirs ? { payloadDigest: await computePayloadDigest(file, npmDirs) } : {}),
      };
    },
    rename: async (from, to) => {
      await assertNativePath(roots, from);
      await assertNativePath(roots, to);

      if (await lstat(to).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return null;
        }

        throw error;
      })) {
        throw installError('recovery_required');
      }

      await rename(from, to);
    },
    ensureDir: async (directory) => {
      await assertNativePath(roots, directory);
      await mkdir(directory, { recursive: true, mode: 0o700 });
    },
    syncDir: async (directory) => {
      await assertNativePath(roots, directory);

      const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);

      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    removeCleanup: async (entry) => {
      const directory = entry.kind === 'job' ? path.join(roots.workDir, 'jobs', entry.jobId)
        : path.join(roots.workDir, 'transactions', entry.transactionId);

      await assertNativePath(roots, directory);

      const info = await native.lstatIdentity(directory);

      if (!info) {
        return;
      }

      if (entry.kind === 'job') {
        const candidate = await native.lstatIdentity(path.join(directory, 'package'));

        if (candidate && (!entry.package || !matchesIdentity(candidate, entry.package))) {
          throw installError('recovery_required');
        }
      } else {
        const contents = await readdir(directory);

        if (contents.some((name) => name !== 'retired')) {
          throw installError('recovery_required');
        }

        const retired = await native.lstatIdentity(path.join(directory, 'retired'), entry.npmDirs);

        if (entry.retired ? retired !== null && !matchesIdentity(retired, entry.retired) : retired !== null) {
          throw installError('recovery_required');
        }
      }

      await rm(directory, { recursive: true, force: true });
    },
  };

  return native;
}

/**
 * Каждый path component проверяется lstat внутри разрешённых config roots.
 * Missing tail допустим для будущего mkdir, но существующая ссылка не допустима нигде.
 */
async function assertNativePath(roots: ApplyRoots, file: string): Promise<void> {
  const absolute = path.resolve(file);
  const allowed = [roots.pluginsDir, roots.workDir].some((root) => {
    const relative = path.relative(path.resolve(root), absolute);

    return relative === '' || !path.isAbsolute(relative) && relative !== '..'
      && !relative.startsWith(`..${path.sep}`);
  });

  if (!allowed) {
    throw installError('recovery_required');
  }

  let current = path.parse(absolute).root;

  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);

    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null;
      }

      throw error;
    });

    if (!info) {
      return;
    }

    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw installError('recovery_required');
    }
  }
}

/**
 * Config roots и все ожидаемые участники должны находиться на одной filesystem.
 * Ошибка layout отвергается до первого rename, copying fallback отсутствует.
 */
async function verifyLayout(fs: ApplyFs, intent: PluginApplyIntent): Promise<void> {
  const plugins = await fs.lstatIdentity(fs.roots.pluginsDir);
  const work = await fs.lstatIdentity(fs.roots.workDir);
  const relative = path.relative(fs.roots.pluginsDir, fs.roots.workDir);
  const inverse = path.relative(fs.roots.workDir, fs.roots.pluginsDir);
  const disjoint = [relative, inverse].every((value) => value === '..' || value.startsWith(`..${path.sep}`));
  const permitted = relative === '.cockpit-install' || disjoint;

  if (!plugins || !work || !permitted || plugins.dev !== work.dev
    || [intent.current, intent.candidate, intent.previous]
      .some((identity) => identity && identity.dev !== work.dev)) {
    throw installError('recovery_required');
  }
}

/**
 * Публикация связывает filesystem переход с одним durable outcome.
 * До первой замены должен существовать полный intent.
 */
export async function applyIntent(
  input: PluginApplyIntent,
  store: PluginInstallStateStore,
  fs: ApplyFs,
): Promise<ApplyOutcome> {
  const intent = structuredClone(input);

  try {
    const state = await store.read();

    if (!state.job || Object.keys(state.workers).length > 0
      || state.apply && state.apply.transactionId !== intent.transactionId) {
      throw installError('recovery_required');
    }

    decodeInstallState({
      ...state,
      apply: intent,
      job: {
        ...state.job,
        status: 'applying',
        stage: null,
        percent: null,
      },
    });

    const paths = intentPaths(fs.roots, intent);

    await verifyLayout(fs, intent);
    await requireIdentity(fs, paths.candidate, intent.candidate, intent.targetRecord.npmDirs);

    if (intent.current) {
      await requireIdentity(fs, paths.current, intent.current, intent.baseRecord?.npmDirs);
    } else if (await fs.lstatIdentity(paths.current)) {
      throw installError('preview_stale');
    }

    if (intent.previous) {
      await requireIdentity(fs, paths.previous, intent.previous, intent.baseRecord?.previous?.npmDirs);
    }

    if (await fs.lstatIdentity(paths.parked)) {
      throw installError('recovery_required');
    }

    await assertUnstartedArchive(fs, paths, intent);

    await store.mutate((state) => {
      state.apply = structuredClone(intent);

      if (state.job?.id !== intent.jobId || !['ready', 'applying'].includes(state.job.status)) {
        throw installError('job_not_ready');
      }

      state.job.status = 'applying';
      state.job.stage = null;
      state.job.percent = null;
      state.job.revision = state.nextRevision++;
      state.job.updatedAt = new Date().toISOString();
    });
    await fs.ensureDir(paths.transaction);

    if (intent.current) {
      await moveDirectory(fs, paths.current, paths.parked);
    }

    await moveDirectory(fs, paths.candidate, paths.current);
    await requireIdentity(fs, paths.current, intent.candidate, intent.targetRecord.npmDirs);
    await writePhase(store, intent, 'installed');
    await archiveCurrent(intent, fs, paths);
    await writePhase(store, intent, 'archived');
    await commitIntent(store, intent);
    await cleanupCommitted(store, fs);

    return { outcome: 'completed', jobId: intent.jobId };
  } catch {
    return recoverFailedApply(intent, store, fs);
  }
}

/**
 * Старая managed копия становится previous после сохранения вытесняемого previous.
 * Никакая старая копия не удаляется до атомарной публикации outcome.
 */
async function archiveCurrent(intent: PluginApplyIntent, fs: ApplyFs, paths: IntentPaths): Promise<void> {
  const parked = await readKnownIdentity(fs, paths.parked, intent);
  const previous = await readKnownIdentity(fs, paths.previous, intent);
  const retired = await readKnownIdentity(fs, paths.retired, intent);

  if (intent.destination === 'previous' && intent.current) {
    if (matchesIdentity(previous, intent.current) && !parked) {
      const retiredValid = intent.previous && intent.kind !== 'rollback'
        ? matchesIdentity(retired, intent.previous) : retired === null;

      if (!retiredValid) {
        throw installError('recovery_required');
      }

      return;
    }

    if (!matchesIdentity(parked, intent.current)) {
      throw installError('recovery_required');
    }

    if (intent.previous && intent.kind !== 'rollback') {
      if (!retired && matchesIdentity(previous, intent.previous)) {
        await moveDirectory(fs, paths.previous, paths.retired);
      } else if (!matchesIdentity(retired, intent.previous) || previous) {
        throw installError('recovery_required');
      }
    } else if (previous || retired) {
      throw installError('recovery_required');
    }

    await moveDirectory(fs, paths.parked, paths.previous);
    await requireIdentity(fs, paths.previous, intent.current, intent.baseRecord?.npmDirs);
  } else if (intent.destination === 'replaced' && paths.replaced && intent.current) {
    const replaced = await readKnownIdentity(fs, paths.replaced, intent);

    if (retired || (intent.previous ? !matchesIdentity(previous, intent.previous) : previous !== null)) {
      throw installError('recovery_required');
    }

    if (matchesIdentity(replaced, intent.current) && !parked) {
      return;
    }

    if (replaced || !matchesIdentity(parked, intent.current)) {
      throw installError('recovery_required');
    }

    await moveDirectory(fs, paths.parked, paths.replaced);
  }

}

/**
 * Разрешённая durable очередь cleanup обрабатывается только после завершённого commit.
 * Удаление и снятие entry допускают повтор при следующем процессе.
 */
async function cleanupCommitted(store: PluginInstallStateStore, fs: ApplyFs): Promise<void> {
  const state = await store.read();

  if (state.apply !== null || Object.keys(state.workers).length > 0) {
    throw installError('recovery_required');
  }

  for (const entry of state.cleanup) {
    await fs.removeCleanup(entry);
    await store.mutate((next) => {
      next.cleanup = next.cleanup.filter((candidate) => JSON.stringify(candidate) !== JSON.stringify(entry));
    });
  }
}

/**
 * Ошибка эффекта не доказывает отсутствие публикации: сначала перечитывается диск.
 * Durable intent до rename остаётся единственным основанием resolver.
 */
async function recoverFailedApply(
  intent: PluginApplyIntent,
  store: PluginInstallStateStore,
  fs: ApplyFs,
): Promise<ApplyOutcome> {
  try {
    const state = await store.read();

    if (state.apply === null && state.job?.id === intent.jobId && state.job.status === 'done'
      && isDeepStrictEqual(state.plugins[intent.pluginId], intent.targetRecord)) {
      return { outcome: 'completed', jobId: intent.jobId };
    }

    if (state.apply === null) {
      const pending = { ...state, apply: structuredClone(intent) };

      decodeInstallState(pending);
      await store.mutate((next) => {
        next.apply = pending.apply;
      });
    }

    return await recoverApply(store, fs);
  } catch {
    return {
      outcome: 'blocked',
      jobId: intent.jobId,
      error: errorInfo(installError('recovery_required')),
    };
  }
}

/**
 * Recovery сохраняет intent при отказе чтения, обратного rename или writer.
 * Неопределённый исход блокирует новые операции и не разрешает cleanup.
 */
export async function recoverApply(store: PluginInstallStateStore, fs: ApplyFs): Promise<ApplyOutcome> {
  let intent: PluginApplyIntent | null = null;

  try {
    intent = (await store.read()).apply;

    return await resolveApply(store, fs);
  } catch (error) {
    if (intent) {
      const blockedIntent = intent;

      await store.mutate((state) => {
        if (state.apply?.transactionId === blockedIntent.transactionId
          && state.job?.id === blockedIntent.jobId
          && (state.job.status !== 'recovery_required' || state.job.error?.code !== 'recovery_required')) {
          state.job.status = 'recovery_required';
          state.job.error = errorInfo(installError('recovery_required'));
          state.job.revision = state.nextRevision++;
          state.job.updatedAt = new Date().toISOString();
        }
      }).catch(() => {});
    }

    return {
      outcome: 'blocked',
      jobId: intent?.jobId ?? null,
      error: errorInfo(installError(
        errorInfo(error).code === 'state_invalid' ? 'state_invalid' : 'recovery_required',
      )),
    };
  }
}

/**
 * Новый процесс восстанавливает переход только из проверенного disk state.
 * Тот же resolver используется при ошибке выполняющего apply процесса.
 */
async function resolveApply(store: PluginInstallStateStore, fs: ApplyFs): Promise<ApplyOutcome> {
  const state = await store.read();
  const intent = state.apply;

  if (Object.keys(state.workers).length > 0) {
    throw installError('recovery_required');
  }

  if (!intent) {
    await cleanupCommitted(store, fs).catch(() => {});

    return { outcome: 'none', jobId: null };
  }

  const paths = intentPaths(fs.roots, intent);

  await verifyLayout(fs, intent);

  const current = await readKnownIdentity(fs, paths.current, intent);
  const parked = await readKnownIdentity(fs, paths.parked, intent);
  const candidate = await readKnownIdentity(fs, paths.candidate, intent);

  if (!parked && matchesIdentity(candidate, intent.candidate)
    && (intent.current ? matchesIdentity(current, intent.current) : current === null)) {
    await assertUnstartedArchive(fs, paths, intent);
    await revertIntent(store, intent);

    return {
      outcome: 'reverted',
      jobId: intent.jobId,
      error: errorInfo(installError('apply_failed')),
    };
  }

  if (matchesIdentity(current, intent.candidate)
    && (!candidate || intent.kind === 'rollback' && intent.current
      && matchesIdentity(candidate, intent.current))) {
    await archiveCurrent(intent, fs, paths);
    await writePhase(store, intent, 'archived');
    await commitIntent(store, intent);
    await cleanupCommitted(store, fs).catch(() => {});

    return { outcome: 'completed', jobId: intent.jobId };
  }

  if (!current && intent.current && matchesIdentity(parked, intent.current)
    && matchesIdentity(candidate, intent.candidate)) {
    await assertUnstartedArchive(fs, paths, intent);
    await moveDirectory(fs, paths.parked, paths.current);
    await requireIdentity(fs, paths.current, intent.current, intent.baseRecord?.npmDirs);
    await revertIntent(store, intent);

    return {
      outcome: 'reverted',
      jobId: intent.jobId,
      error: errorInfo(installError('apply_failed')),
    };
  }

  throw installError('recovery_required');
}

/**
 * Ещё не выполненный archive не может иметь retired/replaced или чужой previous.
 * Даже reverted outcome требует доказательства, что эти копии не изменены.
 */
async function assertUnstartedArchive(
  fs: ApplyFs,
  paths: IntentPaths,
  intent: PluginApplyIntent,
): Promise<void> {
  const retired = await fs.lstatIdentity(paths.retired);
  const replaced = paths.replaced ? await fs.lstatIdentity(paths.replaced) : null;
  const previous = await readKnownIdentity(fs, paths.previous, intent);

  if (retired || replaced
    || (intent.previous ? !matchesIdentity(previous, intent.previous) : previous !== null)) {
    throw installError('recovery_required');
  }
}

/**
 * Digest читается только для узнаваемого inode и соответствующих ему npmDirs.
 * Неизвестная копия не интерпретируется как package и остаётся спорным участником.
 */
async function readKnownIdentity(
  fs: ApplyFs,
  file: string,
  intent: PluginApplyIntent,
): Promise<DirectoryIdentity | null> {
  const actual = await fs.lstatIdentity(file);
  const expected = [
    { identity: intent.candidate, npmDirs: intent.targetRecord.npmDirs },
    { identity: intent.current, npmDirs: intent.baseRecord?.npmDirs },
    { identity: intent.previous, npmDirs: intent.baseRecord?.previous?.npmDirs },
  ].find((entry) => entry.identity && actual?.dev === entry.identity.dev
    && actual.ino === entry.identity.ino);

  return expected?.identity?.payloadDigest ? fs.lstatIdentity(file, expected.npmDirs ?? []) : actual;
}

/**
 * Reverted outcome допускается лишь после доказанного восстановления старой identity.
 * Исходный record не меняется; failed и summary публикуются устойчиво вместе.
 */
async function revertIntent(store: PluginInstallStateStore, intent: PluginApplyIntent): Promise<void> {
  await store.mutate((state) => {
    if (state.apply?.transactionId !== intent.transactionId || state.job?.id !== intent.jobId) {
      throw installError('recovery_required');
    }

    const time = new Date().toISOString();

    state.job.status = 'failed';
    state.job.stage = null;
    state.job.percent = null;
    state.job.error = errorInfo(installError('apply_failed'));
    state.job.updatedAt = time;
    state.job.finishedAt = time;
    state.job.revision = state.nextRevision++;
    state.completedJobs[intent.jobId] = summarizeInstallJob(state.job);
    state.prepared = null;
    state.apply = null;
  });
}

interface IntentPaths {
  current: string;
  candidate: string;
  previous: string;
  transaction: string;
  parked: string;
  retired: string;
  replaced: string | null;
}

/**
 * Все filesystem участники вычисляются из config и проверенных id/UUID.
 * Rollback берёт candidate из previous, а не из нового staging.
 */
function intentPaths(roots: ApplyRoots, intent: PluginApplyIntent): IntentPaths {
  const previous = path.join(roots.workDir, 'previous', intent.pluginId);
  const transaction = path.join(roots.workDir, 'transactions', intent.transactionId);

  return {
    current: path.join(roots.pluginsDir, intent.pluginId),
    candidate: intent.kind === 'rollback' ? previous
      : path.join(roots.workDir, 'jobs', intent.jobId, 'package'),
    previous,
    transaction,
    parked: path.join(transaction, 'parked'),
    retired: path.join(transaction, 'retired'),
    replaced: intent.archiveKey ? path.join(roots.workDir, 'replaced', intent.archiveKey) : null,
  };
}

/**
 * Каждый rename синхронизирует оба родительских каталога до следующей фазы.
 * Recovery узнаёт эффект по identity, даже если запись фазы ещё не произошла.
 */
async function moveDirectory(fs: ApplyFs, from: string, to: string): Promise<void> {
  await fs.rename(from, to);
  await fs.syncDir(path.dirname(from));
  await fs.syncDir(path.dirname(to));
}

/**
 * Ожидаемая managed копия сравнивается по inode и полному digest.
 * Несовпадение не даёт права перемещать или удалить спорный каталог.
 */
async function requireIdentity(
  fs: ApplyFs,
  file: string,
  expected: DirectoryIdentity,
  npmDirs?: string[],
): Promise<void> {
  const actual = await fs.lstatIdentity(file, npmDirs);

  if (!matchesIdentity(actual, expected)) {
    throw installError('preview_stale');
  }
}

/**
 * Identity без digest допустима только для целиком сохраняемой ручной копии.
 * Managed snapshot всегда сравнивает весь подготовленный payload.
 */
function matchesIdentity(actual: DirectoryIdentity | null, expected: DirectoryIdentity): boolean {
  return actual !== null && actual.dev === expected.dev && actual.ino === expected.ino
    && (expected.payloadDigest === undefined || actual.payloadDigest === expected.payloadDigest);
}

/**
 * Фаза обновляет только существующий intent той же транзакции.
 * Поздний callback не может записаться поверх другой операции.
 */
async function writePhase(
  store: PluginInstallStateStore,
  intent: PluginApplyIntent,
  phase: PluginApplyIntent['phase'],
): Promise<void> {
  await store.mutate((state) => {
    if (state.apply?.transactionId !== intent.transactionId) {
      throw installError('recovery_required');
    }

    state.apply.phase = phase;
  });
}

/**
 * Одна durable запись публикует record, done и terminal summary вместе.
 * До этой точки никакой cleanup не получает разрешение удалить старые копии.
 */
async function commitIntent(store: PluginInstallStateStore, intent: PluginApplyIntent): Promise<void> {
  await store.mutate((state) => {
    if (state.apply?.transactionId !== intent.transactionId || state.job?.id !== intent.jobId) {
      throw installError('recovery_required');
    }

    const time = new Date().toISOString();

    state.plugins[intent.pluginId] = structuredClone(intent.targetRecord);
    state.job.status = 'done';
    state.job.stage = null;
    state.job.percent = null;
    state.job.error = null;
    state.job.updatedAt = time;
    state.job.finishedAt = time;
    state.job.revision = state.nextRevision++;
    state.job.backupRef = intent.archiveKey;
    state.completedJobs[intent.jobId] = summarizeInstallJob(state.job);

    if (intent.rollbackReceiptInput) {
      state.lastRollback[intent.pluginId] = {
        ...intent.rollbackReceiptInput,
        job: summarizeInstallJob(state.job),
      };
    }

    state.cleanup.push({ kind: 'job', jobId: intent.jobId });
    state.cleanup.push({
      kind: 'transaction',
      transactionId: intent.transactionId,
      retired: intent.destination === 'previous' && intent.kind !== 'rollback' ? intent.previous : null,
      npmDirs: intent.baseRecord?.previous?.npmDirs ?? [],
    });
    state.prepared = null;
    state.apply = null;
  });
}
