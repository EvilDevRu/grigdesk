import path from 'node:path';

import { canonicalJson } from '../../../shared/lib/canonicalJson.ts';
import { readInstallationJson, type InstallationReceipt } from '../../../shared/node/installedLayout.ts';
import { readUpdateProcess } from '../../../shared/node/updateProcessOwner.ts';
import { readDarwinProcessIdentity } from '../../../shared/node/processIdentity.ts';
import type { InstalledUpdateJob } from '../../../shared/node/installedUpdateState.ts';

type WorkerIdentity = Awaited<ReturnType<typeof readUpdateProcess>>;

export interface UpdateDrainOwner {
  key: string;
  process: WorkerIdentity;
}

/**
 * Проверяет запись установленного helper для того же job, nonce и instance.
 * Один CLI-токен не даёт права закрыть допуск обновления.
 */
export async function readFactoryUpdateDrainOwner(receipt: InstallationReceipt, job: InstalledUpdateJob,
  instanceId: string, claimed?: { pid: number; starttime: string }): Promise<UpdateDrainOwner> {
  const marker = await readInstallationJson(receipt.root, 'update/worker-process.json') as {
    jobId?: string;
    process?: WorkerIdentity;
  } | null;
  const expected = marker?.process;

  if (marker?.jobId !== job.id || !job.intent || job.installationId !== receipt.installationId
    || !expected || expected.executable !== path.join(receipt.root, 'update/maintenance')
    || claimed && (claimed.pid !== expected.pid || claimed.starttime !== expected.starttime)) {
    throw new Error('release_activity_unknown');
  }

  const current = await readUpdateProcess(expected.pid);

  if (canonicalJson(current) !== canonicalJson(expected)) {
    throw new Error('release_activity_unknown');
  }

  return {
    key: canonicalJson([
      receipt.installationId, instanceId, job.id, job.manifestDigest, job.intent.nonce, current,
    ]),
    process: current,
  };
}

/**
 * Неизвестная проба оставляет допуск закрытым. Смена поколения PID или
 * исполняемого файла означает выход прежнего проверенного владельца.
 */
export async function factoryUpdateDrainOwnerDead(owner: UpdateDrainOwner): Promise<boolean> {
  const { pid, starttime, executable } = owner.process;
  const result = await readDarwinProcessIdentity(pid);

  return result.state === 'dead'
    || result.state === 'alive'
      && (result.identity.starttime !== starttime || result.identity.executable !== executable);
}
