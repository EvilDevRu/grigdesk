import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

import { canonicalJson } from '../lib/canonicalJson.ts';
import { assertInstallationReleaseTrust } from './bundleLayout.ts';
import {
  acquireInstalledUpdateLock, readInstallation, readInstallationJson, writeInstallationJson,
} from './installedLayout.ts';
import type { InstallationReceipt } from './installedLayout.ts';
import { readInstalledUpdate } from './installedUpdateState.ts';
import type { InstalledUpdateJob } from './installedUpdateState.ts';
import { verifyReleaseEnvelope } from './releaseTrust.ts';
import { readUpdateProcess } from './updateProcessOwner.ts';

export const rollbackAttemptPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const requestedPath = 'update/rollback-attempt.json';
const statusPath = 'update/rollback-result.json';
const workerPath = 'update/worker-process.json';

interface RollbackAttempt {
  format: 1;
  id: string;
  jobId: string;
  nonce: string;
  installationId: string;
  manifestDigest: string;
}

type RollbackState = 'accepted' | 'rolled_back' | 'failed';

/**
 * Явный rollback допускается только для проверенного persisted intent этого режима.
 * После restart пропавший desktop или старый journal не образуют новую цель.
 */
function boundAttempt(receipt: InstallationReceipt, job: InstalledUpdateJob | null,
  jobId: string, id: string): RollbackAttempt {
  const allowed = ['stopping', 'applying', 'starting', 'manual_recovery_required',
    ...(receipt.mode === 'server' ? ['applied_not_started'] : [])];
  const scope = receipt.mode === 'local' ? 'pair' : receipt.mode === 'remote' ? 'desktop' : 'server';

  if (process.platform !== 'darwin' || !rollbackAttemptPattern.test(id)
    || !job?.intent || job.id !== jobId || job.scope !== scope || !allowed.includes(job.stage)
    || verifyReleaseEnvelope(job.envelope) !== job.manifestDigest) {
    throw new Error('release_recovery_not_available');
  }

  return {
    format: 1,
    id,
    jobId,
    nonce: job.intent.nonce,
    installationId: receipt.installationId,
    manifestDigest: job.manifestDigest,
  };
}

/**
 * Только подтверждённое завершение или переиспользование PID снимает
 * прежнее владение. Неизвестный процесс остаётся препятствием для нового rollback.
 */
async function assertNoWorker(receipt: InstallationReceipt, jobId: string) {
  const marker = await readInstallationJson(receipt.root, workerPath)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null;
      }

      throw error;
    }) as { jobId: string; process: Awaited<ReturnType<typeof readUpdateProcess>> } | null;

  if (!marker || marker.jobId !== jobId) {
    return;
  }

  const selected = await readUpdateProcess(marker.process.pid, path.join(receipt.root, 'update/maintenance'))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ESRCH') {
        return null;
      }

      throw error;
    });

  if (selected && selected.starttime === marker.process.starttime) {
    throw new Error('release_worker_active');
  }
}

/**
 * CLI публикует новую попытку только под offline lock. Предыдущий ACK
 * не содержит этот ID и не влияет на ожидание.
 */
export async function requestDarwinRollback(root: string, jobId: string) {
  const lock = await acquireInstalledUpdateLock(root);

  try {
    const receipt = await readInstallation(root);

    assertInstallationReleaseTrust(receipt);
    await assertNoWorker(receipt, jobId);

    const attempt = boundAttempt(receipt, await readInstalledUpdate(receipt), jobId, randomUUID());

    await writeInstallationJson(root, requestedPath, attempt);

    return attempt;
  } finally {
    await lock.release();
  }
}

/**
 * Worker сверяет новый attempt с receipt/intent под lock и публикует
 * собственную incarnation до ACK. Запускающий повтор больше не может её заменить.
 */
export async function acceptDarwinRollback(
  receipt: InstallationReceipt, jobId: string, id: string,
  processIdentity: Awaited<ReturnType<typeof readUpdateProcess>>,
): Promise<RollbackAttempt> {
  const lock = await acquireInstalledUpdateLock(receipt.root);

  try {
    const attempt = boundAttempt(receipt, await readInstalledUpdate(receipt), jobId, id);
    const saved = await readInstallationJson(receipt.root, requestedPath);

    if (canonicalJson(attempt) !== canonicalJson(saved)) {
      throw new Error('release_rollback_attempt_invalid');
    }

    await assertNoWorker(receipt, jobId);
    await writeInstallationJson(receipt.root, workerPath, { jobId, process: processIdentity });
    await markDarwinRollback(receipt.root, attempt, 'accepted');

    return attempt;
  } finally {
    await lock.release();
  }
}

/**
 * Принятие и терминальный результат относятся к одному durable attempt.
 * Терминальный результат также подтверждает, что ACK уже был опубликован.
 */
export async function markDarwinRollback(
  root: string, attempt: RollbackAttempt, state: RollbackState, error?: string,
) {
  await writeInstallationJson(root, statusPath, {
    attempt,
    state,
    error: error ?? null,
  });
}

/**
 * Сначала ожидает ACK именно новой попытки, затем её конечный исход.
 * Старый journal, старая ошибка и предыдущий ID не завершают ожидание.
 */
export async function waitDarwinRollback(root: string, attempt: RollbackAttempt): Promise<void> {
  let deadline = Date.now() + 90_000;
  let accepted = false;

  while (Date.now() < deadline) {
    const status = await readInstallationJson(root, statusPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null;
      }

      throw error;
    }) as {
      attempt: RollbackAttempt;
      state: RollbackState;
      error: string | null;
    } | null;

    if (status && canonicalJson(attempt) === canonicalJson(status.attempt)) {
      if (status.state === 'rolled_back') {
        return;
      }

      if (status.state === 'failed') {
        throw new Error(status.error ?? 'release_apply_failed');
      }

      if (!accepted && status.state === 'accepted') {
        accepted = true;
        deadline = Date.now() + 240_000;
      }
    }

    await pause(200);
  }

  throw new Error(accepted ? 'release_apply_pending_check_status' : 'release_handoff_timeout');
}
