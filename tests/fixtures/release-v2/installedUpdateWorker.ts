import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

import { canonicalJson } from '../../../shared/lib/canonicalJson.ts';
import { verifyReleaseEnvelope } from '../../../shared/node/releaseTrust.ts';
import { launchInstalledProcess } from '../../../shared/node/installedProcess.ts';
import { assertInstallationReleaseTrust } from '../../../shared/node/bundleLayout.ts';
import { acceptDarwinRollback, markDarwinRollback } from '../../../shared/node/darwinRollbackAttempt.ts';
import {
  launchDarwinUpdatedDesktop, matchesDarwinDesktopBoot, stopDarwinUpdatedDesktop,
} from './darwinDesktopUpdate.ts';
import { API_VERSION } from '../../../shared/client/apiVersion.ts';
import { checkReleaseCompatibility } from '../../../shared/runtime/releaseCompatibility.ts';
import type { ServerApi } from '../../../shared/runtime/releaseCompatibility.ts';
import { pruneCompletedUpdate } from './installedUpdateCleanup.ts';
import { acquireInstalledUpdateLock, readInstallation, readInstalledPointer, readInstallationJson,
  writeInstallationJson } from '../../../shared/node/installedLayout.ts';
import type { InstallationReceipt } from '../../../shared/node/installedLayout.ts';
import { readInstalledUpdate } from '../../../shared/node/installedUpdateState.ts';
import type { InstalledUpdateJob } from '../../../shared/node/installedUpdateState.ts';
import { confirmInstalledUpdate, applyInstalledUpdate, recoverInstalledUpdate,
  preflightInstalledUpdate } from './installedUpdateApply.ts';
import { verifyInstalledGeneration } from './installedUpdateApply.ts';
import { installedControl } from '../../../shared/node/installedControl.ts';
import { readUpdateProcess } from '../../../shared/node/updateProcessOwner.ts';
import { inspectInstalledServer, stopInstalledServer,
  startInstalledServer, proveInstalledServer, updateProcessAlive,
  inspectUpdateActivity, stopUpdatePipelines, installedServerRequest }
  from '../../../shared/node/installedServer.ts';
import type { InstalledServerOwner, UpdateProcess } from '../../../shared/node/installedServer.ts';

import type { UpdateHandoff, WorkerSignal } from '../../../shared/node/installedUpdateProcess.ts';

export { launchUpdateWorker, waitUpdateWorker } from '../../../shared/node/installedUpdateProcess.ts';
export type { UpdateHandoff } from '../../../shared/node/installedUpdateProcess.ts';

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
  const lock = await acquireInstalledUpdateLock(root);

  try {
    const job = await readInstalledUpdate(receipt);

    if (!job || job.id !== jobId || job.scope === 'server'
      || !['stopping', 'applying', 'starting', 'manual_recovery_required'].includes(job.stage)
      || verifyReleaseEnvelope(job.envelope) !== job.manifestDigest) {
      throw new Error('release_recovery_not_available');
    }

    const handoff = await readHandoff(receipt, job);

    handoff.desktop = await readUpdateProcess(process.pid, path.join(root, 'update/maintenance'));
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
    || job.scope === 'pair' && !handoff.server
    || process.platform === 'darwin' && receipt.mode === 'remote' && handoff.server !== null) {
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

  const processIdentity = await readUpdateProcess(process.pid, path.join(root, 'update/maintenance'));

  if (job.format === 2) {
    await installedControl(root, 'boot-proof', {
      jobId: job.id,
      nonce: job.intent.nonce,
      ...identity,
      process: processIdentity,
    });

    return;
  }

  await writeInstallationJson(root, 'update/desktop-boot.json', {
    jobId: job.id,
    nonce: job.intent.nonce,
    installationId: receipt.installationId,
    ...identity,
    process: processIdentity,
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
 * На Mac новые ходы закрыты от повторного осмотра до dispatch выключения.
 * При откате новой программе нельзя передавать разрешение от прежнего запуска.
 */
async function stopDarwinUpdateServer(input: {
  receipt: InstallationReceipt;
  owner: InstalledServerOwner;
  job: InstalledUpdateJob;
  handoff: UpdateHandoff;
  worker: UpdateProcess;
  expectOriginal: boolean;
  markStopDispatched?: () => void;
}): Promise<void> {
  const { receipt, owner, job, handoff, worker, expectOriginal, markStopDispatched } = input;
  const original = owner.instanceId === handoff.server?.instanceId
    && canonicalJson(owner.process) === canonicalJson(handoff.server?.process ?? null);

  if (!owner.instanceId || !job.intent || expectOriginal && !original) {
    throw new Error('release_server_owner_changed');
  }

  const body = {
    jobId: job.id,
    nonce: job.intent.nonce,
    installationId: receipt.installationId,
    instanceId: owner.instanceId,
    manifestDigest: job.manifestDigest,
    workerPid: worker.pid,
    workerStart: worker.starttime,
  };
  const route = '/api/system/factory-drain-admission';
  const response = await installedServerRequest(receipt, route,
    { ...body, action: 'acquire' }, undefined, 'admission') as { admissionId?: unknown } | null;
  const admissionId = response?.admissionId;

  if (typeof admissionId !== 'string' || !/^[a-f0-9-]{36}$/u.test(admissionId)) {
    throw new Error('release_activity_unknown');
  }

  let dispatched = false;

  try {
    const activity = await inspectUpdateActivity(receipt);
    const allowed = original ? handoff.activity : null;

    if (allowed
      ? activity.active > allowed.active || activity.queued > allowed.queued
        || activity.tasks.some((task) => !allowed.tasks.includes(task))
      : activity.active + activity.queued + activity.tasks.length > 0) {
      throw new Error('release_activity_changed_confirm_again');
    }

    await stopUpdatePipelines(receipt);
    await installedServerRequest(receipt, route, {
      ...body,
      action: 'confirm',
      admissionId,
    }, undefined, 'admission');
    await stopInstalledServer(receipt, owner, job, admissionId, () => {
      dispatched = true;
      markStopDispatched?.();
    });
  } finally {
    if (!dispatched) {
      await installedServerRequest(receipt, route, {
        ...body,
        action: 'release',
        admissionId,
      }, undefined, 'admission').catch(() => {});
    }
  }
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
  attemptId?: string,
): Promise<void> {
  const receipt = await readInstallation(root);

  assertInstallationReleaseTrust(receipt);

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
  const worker = await readUpdateProcess(process.pid);
  const nativeRollback = process.platform === 'darwin' && action === 'rollback';

  if (nativeRollback !== Boolean(attemptId)) {
    throw new Error('release_rollback_attempt_invalid');
  }

  const rollback = attemptId ? await acceptDarwinRollback(receipt, jobId, attemptId, worker) : null;

  if (!rollback) {
    await writeInstallationJson(root, 'update/worker-process.json', {
      jobId,
      process: worker,
    });
  }

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
    async stop(job: InstalledUpdateJob, markStopDispatched?: () => void) {
      if (handoff.server) {
        const owner = await inspectInstalledServer(receipt);

        if (owner.running) {
          if (process.platform === 'darwin') {
            await stopDarwinUpdateServer({
              receipt,
              owner,
              job,
              handoff,
              worker,
              expectOriginal: action === 'apply' && job.stage === 'stopping' && !serverStopped,
              markStopDispatched,
            });
          } else {
            await stopUpdatePipelines(receipt);
            await stopInstalledServer(receipt, owner, job);
          }
        } else if (process.platform === 'darwin' && handoff.server.running) {
          markStopDispatched?.();
        }

        serverStopped = true;
      }

      const previouslyStopped = desktopStopped;

      if (handoff.desktop && !previouslyStopped) {
        if (process.platform === 'darwin') {
          markStopDispatched?.();
        }

        await signal('drained');

        const deadline = Date.now() + 30000;

        while (await updateProcessAlive(handoff.desktop)) {
          if (Date.now() >= deadline) {
            throw new Error('release_desktop_exit_timeout');
          }

          await pause(100);
        }

        desktopStopped = true;
      }

      if (handoff.desktop && process.platform === 'darwin') {
        const current = await readInstalledPointer(receipt);

        if (current.desktop === job.target.desktop || action !== 'apply') {
          await stopDarwinUpdatedDesktop(receipt, job);
        }
      } else if (handoff.desktop && previouslyStopped) {
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

      if (handoff.desktop && process.platform === 'darwin') {
        await launchDarwinUpdatedDesktop(receipt, job, rollback);
      } else if (handoff.desktop) {
        await launchDesktop(receipt);
      }
    },
    /**
     * Две живые identity подтверждают пару; prepared/current и --version не считаются ACK.
     * Server-only stopped получает отдельный исход без ложного сообщения о работающем обновлении.
     */
    async prove(job: InstalledUpdateJob, rollback: boolean): Promise<'running' | 'stopped'> {
      if (handoff.desktop) {
        const relative = (rollback ? job.previous : job.target).desktop!;
        const expected = relative.split('/')[1];
        const releaseId = process.platform === 'darwin' && rollback
          ? (await verifyInstalledGeneration(receipt, relative, 'desktop')).payload.releaseId
          : job.envelope.payload.releaseId;
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
              && (rollback && process.platform !== 'darwin' || proof.releaseId === releaseId)
              && (process.platform !== 'darwin'
                || await matchesDarwinDesktopBoot(receipt, job, proof.process))
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

    if (rollback) {
      if (finished?.stage !== 'rolled_back') {
        throw new Error(finished?.error?.code ?? 'release_recovery_not_available');
      }

      await markDarwinRollback(root, rollback, 'rolled_back');
    }
  } catch (error) {
    if (rollback) {
      await markDarwinRollback(root, rollback, 'failed',
        error instanceof Error ? error.message : 'release_apply_failed');
    }

    if (acknowledged) {
      await signal('failed', error instanceof Error ? error.message : 'release_apply_failed');
    }

    throw error;
  }
}
