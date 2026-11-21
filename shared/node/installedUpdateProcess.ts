import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

import type { ServerApi } from '../runtime/releaseCompatibility.ts';
import { assertInstallationReleaseTrust } from './bundleLayout.ts';
import { readInstallation, readInstallationJson } from './installedLayout.ts';
import { launchInstalledProcess } from './installedProcess.ts';
import type { InstalledServerOwner, UpdateActivity, UpdateProcess } from './installedServer.ts';
import { readInstalledUpdate } from './installedUpdateState.ts';

export interface UpdateHandoff {
  jobId: string;
  nonce: string;
  installationId: string;
  manifestDigest: string;
  desktop: UpdateProcess | null;
  server: InstalledServerOwner | null;
  restartServer: boolean;
  activity: UpdateActivity | null;
  remoteApi: ServerApi | null;
}

export interface WorkerSignal {
  jobId: string;
  nonce: string;
  state: 'accepted' | 'drained' | 'failed';
  error?: string;
}

/**
 * Независимая transient unit выводит helper из app/server cgroup до подтверждения handoff.
 * Без user-systemd используется отдельная сессия и собственный файл вывода.
 */
export async function launchUpdateWorker(
  root: string, jobId: string, action = 'apply', attemptId?: string,
): Promise<void> {
  const receipt = await readInstallation(root);

  assertInstallationReleaseTrust(receipt);

  if (action === 'prepare' && receipt.format === 2) {
    throw new Error('candidate_source_required');
  }

  await launchInstalledProcess(receipt,
    attemptId ? [action, jobId, attemptId] : [action, jobId], `update-${jobId}-${action}`);
}

/**
 * Старый desktop выходит лишь после durable ACK и подтверждения слива своего сервера.
 * Ошибка либо timeout возвращают управление приложению без разрешения pointer switch.
 */
export async function waitUpdateWorker(root: string, handoff: UpdateHandoff,
  desired: WorkerSignal['state'], signal?: AbortSignal): Promise<void> {
  // До accepted worker повторно хеширует все staged-файлы; до drained укладывает
  // stop конвейеров (20с), systemctl stop (65с) и ожидание drain-пруфа (55с).
  // Бюджеты покрывают сумму худших случаев, а не типичный путь.
  const deadline = Date.now() + (desired === 'drained' ? 200000 : 90000);

  while (Date.now() < deadline) {
    signal?.throwIfAborted();

    let marker: WorkerSignal | null = null;

    try {
      marker = await readInstallationJson(root, 'update/worker.json') as WorkerSignal;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    if (marker?.jobId === handoff.jobId && marker.nonce === handoff.nonce) {
      if (marker.state === 'failed') {
        throw new Error(marker.error ?? 'release_handoff_failed');
      }

      if (marker.state === desired || desired === 'accepted' && marker.state === 'drained') {
        return;
      }
    }

    const receipt = await readInstallation(root);
    const job = await readInstalledUpdate(receipt);

    if (job?.id === handoff.jobId && !job.intent && job.error) {
      throw new Error(job.error.code);
    }

    await pause(100, undefined, { signal });
  }

  throw new Error('release_handoff_timeout');
}
