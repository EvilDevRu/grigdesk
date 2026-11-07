import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

import { canonicalJson } from '../lib/canonicalJson.ts';
import { acquireInstallLock } from './binaryInstall.ts';
import { verifyReleaseEnvelope } from './releaseTrust.ts';
import { launchInstalledProcess } from './installedProcess.ts';
import { API_VERSION } from '../client/apiVersion.ts';
import { checkReleaseCompatibility } from '../runtime/releaseCompatibility.ts';
import type { ServerApi } from '../runtime/releaseCompatibility.ts';
import { pruneCompletedUpdate } from './installedUpdateCleanup.ts';
import { readInstallation, readInstallationJson,
  writeInstallationJson } from './installedLayout.ts';
import type { InstallationReceipt } from './installedLayout.ts';
import { readInstalledUpdate } from './installedUpdateState.ts';
import type { InstalledUpdateJob } from './installedUpdateState.ts';
import { confirmInstalledUpdate, applyInstalledUpdate, recoverInstalledUpdate,
  preflightInstalledUpdate } from './installedUpdateApply.ts';
import { verifyInstalledGeneration } from './installedUpdateApply.ts';
import { readUpdateProcess } from './updateProcessOwner.ts';
import { inspectInstalledServer, stopInstalledServer,
  startInstalledServer, proveInstalledServer, updateProcessAlive,
  inspectUpdateActivity, stopUpdatePipelines } from './installedServer.ts';
import type { InstalledServerOwner, UpdateProcess, UpdateActivity } from './installedServer.ts';

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

interface WorkerSignal {
  jobId: string;
  nonce: string;
  state: 'accepted' | 'drained' | 'failed';
  error?: string;
}

/**
 * Handoff сохраняет владельцев и последствия после отдельного согласия пользователя.
 * Remote scope не получает чужой сервер; оставшийся собственный local только останавливается.
 */
export async function createUpdateHandoff(root: string, jobId: string, input: {
  desktop?: UpdateProcess;
  stopLocal: boolean;
  remoteApi?: ServerApi | null;
}): Promise<UpdateHandoff> {
  const receipt = await readInstallation(root);
  const job = await preflightInstalledUpdate(root, jobId);
  const server = input.stopLocal ? await inspectInstalledServer(receipt) : null;
  const activity = server?.running ? await inspectUpdateActivity(receipt) : null;
  const confirmed = await confirmInstalledUpdate(root, job.id);
  const handoff: UpdateHandoff = {
    jobId: job.id,
    nonce: confirmed.intent!.nonce,
    installationId: receipt.installationId,
    manifestDigest: job.manifestDigest,
    desktop: input.desktop ?? null,
    server,
    restartServer: job.scope !== 'desktop' && Boolean(server?.running),
    activity,
    remoteApi: input.remoteApi ?? null,
  };

  await writeInstallationJson(root, 'update/handoff.json', handoff);

  return handoff;
}

/**
 * После прерывания новый main подтверждает собственный выход в прежнем bound задании.
 * Живой worker удерживает lock и не допускает перепривязать handoff посреди применения.
 */
export async function resumeDesktopHandoff(root: string, jobId: string): Promise<UpdateHandoff> {
  const receipt = await readInstallation(root);
  const lock = await acquireInstallLock(path.join(root, 'update/installation'), { waitMs: 0 });

  try {
    const job = await readInstalledUpdate(receipt);

    if (!job || job.id !== jobId || job.scope === 'server'
      || !['stopping', 'applying', 'starting', 'manual_recovery_required'].includes(job.stage)
      || verifyReleaseEnvelope(job.envelope) !== job.manifestDigest) {
      throw new Error('release_recovery_not_available');
    }

    const handoff = await readHandoff(receipt, job);

    handoff.desktop = await readUpdateProcess(process.pid);
    await writeInstallationJson(root, 'update/handoff.json', handoff);

    return handoff;
  } finally {
    await lock.release();
  }
}

/**
 * Worker не принимает команды или executable от renderer: только известный job id.
 * Приватный handoff должен совпадать с intent и полным journal своей установки.
 */
async function readHandoff(receipt: InstallationReceipt, job: InstalledUpdateJob): Promise<UpdateHandoff> {
  const handoff = await readInstallationJson(receipt.root, 'update/handoff.json') as UpdateHandoff;

  if (!job.intent || handoff.jobId !== job.id || handoff.nonce !== job.intent.nonce
    || handoff.installationId !== receipt.installationId || handoff.manifestDigest !== job.manifestDigest
    || (job.scope === 'server') !== (handoff.desktop === null)
    || job.scope === 'pair' && !handoff.server) {
    throw new Error('release_handoff_invalid');
  }

  return handoff;
}

/**
 * Boot ACK подтверждает версию запущенного main, а не прочитанный current.
 * UID, starttime, nonce и releaseId исключают старый файл либо прежний PID.
 */
export async function writeDesktopBootProof(root: string, identity: {
  version: string;
  releaseId: string;
}): Promise<void> {
  const receipt = await readInstallation(root);
  const job = await readInstalledUpdate(receipt);

  if (!job?.intent) {
    return;
  }

  await writeInstallationJson(root, 'update/desktop-boot.json', {
    jobId: job.id,
    nonce: job.intent.nonce,
    installationId: receipt.installationId,
    ...identity,
    process: await readUpdateProcess(process.pid),
  });
}

/**
 * Новый desktop запускается каноническим helper с прежним userData и окружением сессии.
 * Вывод не наследует трубы старого приложения и не удерживает его stdio.
 */
async function launchDesktop(receipt: InstallationReceipt): Promise<void> {
  await launchInstalledProcess(receipt, ['launch', 'desktop'],
    `desktop-${receipt.installationId}-${randomUUID()}`);
}

/**
 * Процессный порт связывает атомарную замену с реальным drain и двумя boot proofs.
 * При повторе после прерывания управляются только процессы подтверждённой установки.
 * Rollback — явный возврат к previous из состояний без штатного пути отката.
 */
export async function runInstalledUpdateWorker(
  root: string,
  jobId: string,
  action: 'apply' | 'recover' | 'rollback' = 'apply',
): Promise<void> {
  const receipt = await readInstallation(root);
  const initial = await readInstalledUpdate(receipt);

  if (!initial || initial.id !== jobId) {
    throw new Error('release_job_mismatch');
  }

  if (action === 'apply' && ['completed', 'applied_not_started'].includes(initial.stage)) {
    return;
  }

  if (action === 'rollback'
    && !['applied_not_started', 'stopping', 'applying', 'starting', 'manual_recovery_required']
      .includes(initial.stage)) {
    throw new Error('release_recovery_not_available');
  }

  const handoff = await readHandoff(receipt, initial);

  await writeInstallationJson(root, 'update/worker-process.json', {
    jobId,
    process: await readUpdateProcess(process.pid),
  });

  let serverStopped = false;
  let desktopStopped = false;
  let acknowledged = false;

  const signal = async (state: WorkerSignal['state'], error?: string) => {
    await writeInstallationJson(root, 'update/worker.json', {
      jobId,
      nonce: handoff.nonce,
      state,
      ...(error ? { error } : {}),
    });
  };
  const ports = {
    /**
     * До остановки сверяются те же владельцы; после остановки запрещён новый посторонний процесс.
     * API remote допускается offline лишь при сохранении всего прежнего диапазона клиента.
     */
    async recheck(job: InstalledUpdateJob) {
      if (job.scope === 'desktop' && !checkReleaseCompatibility({
        candidate: job.envelope.payload,
        scope: 'desktop',
        installedRequirement: { major: API_VERSION.major, minMinor: API_VERSION.minor },
        remoteApi: handoff.remoteApi,
      }).compatible) {
        throw new Error('release_remote_api_check_required');
      }

      if (handoff.server) {
        const now = await inspectInstalledServer(receipt);

        if (!serverStopped && job.stage === 'ready'
          && canonicalJson(now) !== canonicalJson(handoff.server)) {
          throw new Error('release_server_owner_changed');
        }

        if (serverStopped && now.running) {
          throw new Error('release_server_owner_changed');
        }

        if (!serverStopped && job.stage === 'ready' && now.running) {
          const activity = await inspectUpdateActivity(receipt);

          if (!handoff.activity || activity.active > handoff.activity.active
            || activity.queued > handoff.activity.queued
            || activity.tasks.some((task) => !handoff.activity!.tasks.includes(task))) {
            throw new Error('release_activity_changed_confirm_again');
          }
        }
      }

      if (!acknowledged) {
        await signal('accepted');
        acknowledged = true;
      }
    },
    /**
     * После ACK main ждёт drain, сливает stdout и сохраняет настройки до собственного exit.
     * Worker не подменяет этот протокол таймаутом обычного quit.
     */
    async stop(job: InstalledUpdateJob) {
      if (handoff.server) {
        const owner = await inspectInstalledServer(receipt);

        if (owner.running) {
          await stopUpdatePipelines(receipt);
          await stopInstalledServer(receipt, owner, job);
        }

        serverStopped = true;
      }

      if (handoff.desktop && !desktopStopped) {
        await signal('drained');

        const deadline = Date.now() + 30000;

        while (await updateProcessAlive(handoff.desktop)) {
          if (Date.now() >= deadline) {
            throw new Error('release_desktop_exit_timeout');
          }

          await pause(100);
        }

        desktopStopped = true;
      } else if (handoff.desktop) {
        // При rollback новый main завершает только bound apply через защищённый boot ACK.
        const proof = await readInstallationJson(root, 'update/desktop-boot.json') as {
          jobId: string;
          nonce: string;
          process: UpdateProcess;
        };

        if (proof.jobId === job.id && proof.nonce === handoff.nonce
          && await updateProcessAlive(proof.process)) {
          process.kill(proof.process.pid, 'SIGTERM');

          const deadline = Date.now() + 60000;

          while (await updateProcessAlive(proof.process)) {
            if (Date.now() >= deadline) {
              throw new Error('release_desktop_exit_timeout');
            }

            await pause(100);
          }
        }
      }
    },
    /**
     * Stopped server остаётся stopped, remote desktop не запускает local.
     * Local desktop сам поднимет свой child; служба стартует прежним владельцем.
     */
    async start(job: InstalledUpdateJob, rollback: boolean) {
      const pointer = rollback ? job.previous : job.target;

      serverStopped = false;

      for (const component of job.scope === 'pair' ? ['desktop', 'server'] as const : [job.scope]) {
        await verifyInstalledGeneration(receipt, pointer[component]!, component);
      }

      if (handoff.restartServer && (job.scope === 'server' || handoff.server?.kind === 'service')) {
        await startInstalledServer(receipt);
      }

      if (handoff.desktop) {
        await launchDesktop(receipt);
      }
    },
    /**
     * Две живые identity подтверждают пару; prepared/current и --version не считаются ACK.
     * Server-only stopped получает отдельный исход без ложного сообщения о работающем обновлении.
     */
    async prove(job: InstalledUpdateJob, rollback: boolean): Promise<'running' | 'stopped'> {
      if (handoff.desktop) {
        const expected = (rollback ? job.previous : job.target).desktop?.split('/')[1];
        const deadline = Date.now() + 90000;
        let accepted = false;

        while (Date.now() < deadline) {
          try {
            const proof = await readInstallationJson(root, 'update/desktop-boot.json') as {
              jobId: string;
              nonce: string;
              installationId: string;
              version: string;
              releaseId: string;
              process: UpdateProcess;
            };

            if (proof.jobId === job.id && proof.nonce === handoff.nonce
              && proof.installationId === receipt.installationId && proof.version === expected
              && (rollback || proof.releaseId === job.envelope.payload.releaseId)
              && await updateProcessAlive(proof.process)) {
              accepted = true;
              break;
            }
          } catch {
            // ACK может ещё не быть записан; срок остаётся общим.
          }

          await pause(200);
        }

        if (!accepted) {
          throw new Error('release_desktop_boot_proof_missing');
        }
      }

      if (job.scope !== 'desktop' && (handoff.restartServer || job.scope === 'pair')) {
        await proveInstalledServer(receipt, job, rollback);
      }

      if (job.scope === 'server' && !handoff.restartServer) {
        if (!(await inspectInstalledServer(receipt)).running) {
          return 'stopped';
        }

        await proveInstalledServer(receipt, job, rollback);
      }

      return 'running';
    },
  };

  try {
    let finished: InstalledUpdateJob | null = null;

    if (action === 'apply') {
      finished = await applyInstalledUpdate(root, jobId, ports);
    } else {
      await recoverInstalledUpdate(root, ports, action === 'rollback' ? { rollback: true } : undefined);
      finished = await readInstalledUpdate(receipt);
    }

    // Успех убирает архивы и недостижимые поколения; отказ уборки не роняет результат.
    if (finished?.stage === 'completed') {
      await pruneCompletedUpdate(receipt, finished);
    }
  } catch (error) {
    if (acknowledged) {
      await signal('failed', error instanceof Error ? error.message : 'release_apply_failed');
    }

    throw error;
  }
}

/**
 * Независимая transient unit выводит helper из app/server cgroup до подтверждения handoff.
 * Без user-systemd используется отдельная сессия и собственный файл вывода.
 */
export async function launchUpdateWorker(root: string, jobId: string, action = 'apply'): Promise<void> {
  const receipt = await readInstallation(root);

  await launchInstalledProcess(receipt, [action, jobId], `update-${jobId}-${action}`);
}

/**
 * Старый desktop выходит лишь после durable ACK и подтверждения слива своего сервера.
 * Ошибка либо timeout возвращают управление приложению без разрешения pointer switch.
 */
export async function waitUpdateWorker(root: string, handoff: UpdateHandoff,
  desired: WorkerSignal['state']): Promise<void> {
  // До accepted worker повторно хеширует все staged-файлы; до drained укладывает
  // stop конвейеров (20с), systemctl stop (65с) и ожидание drain-пруфа (55с).
  // Бюджеты покрывают сумму худших случаев, а не типичный путь.
  const deadline = Date.now() + (desired === 'drained' ? 200000 : 90000);

  while (Date.now() < deadline) {
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

    await pause(100);
  }

  throw new Error('release_handoff_timeout');
}
