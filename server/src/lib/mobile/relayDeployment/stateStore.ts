import path from 'node:path';

import type { DeploymentJob } from '../../../../../shared/mobile/relayDeploymentContracts.ts';
import { privateRead, privateWrite, serialized } from '../files.ts';
import type { UpdateRecovery } from './installer.ts';
import type { ReleaseFloor } from './remoteState.ts';

export interface DeploymentRecord {
  job: DeploymentJob;
  receipts: Record<string, {
    input: string;
    result: DeploymentJob;
    status: number;
  }>;
  before?: Pick<import('../store.ts').Relay, 'id' | 'host' | 'port' | 'enabled'>;
  updateRecovery?: UpdateRecovery;
  activeRelease?: ReleaseFloor;
}

/**
 * Снимок и квитанции доступны через job. Пин пакета и ключ proof остаются в private state.
 * Секреты SSH принадлежат только worker.
 */
export class DeploymentStateStore {
  readonly file: string;

  constructor(directory: string) {
    this.file = path.join(directory, 'relay-deployments.json');
  }

  /**
   * Повреждение журнала закрывает мастер, сохраняя прежний мобильный вход.
   * Отсутствие файла означает первый запуск и не создаёт запись само по себе.
   */
  async read(): Promise<DeploymentRecord[]> {
    const raw = await privateRead(this.file) as { version: number; jobs: DeploymentRecord[] } | null;

    if (!raw) {
      return [];
    }

    if (raw.version !== 1 || !Array.isArray(raw.jobs)
      || raw.jobs.some((record) => !record.job?.id || !Number.isSafeInteger(record.job.revision)
        || record.updateRecovery && !validPin(record.job, record.updateRecovery))) {
      throw new Error('deployment_store_corrupt');
    }

    return raw.jobs;
  }

  /**
   * Каждая транзакция перечитывает durable снимок под общей файловой очередью.
   * Ответ возвращается после fsync и rename, поэтому потеря ACK не повторяет эффект.
   */
  mutate<T>(action: (records: DeploymentRecord[]) => T | Promise<T>): Promise<T> {
    return serialized(this.file, async () => {
      const records = await this.read();
      const result = await action(records);

      await privateWrite(this.file, JSON.stringify({ version: 1, jobs: records }));

      return structuredClone(result);
    });
  }

  readLocked<T>(action: (records: DeploymentRecord[]) => T | Promise<T>): Promise<T> {
    return serialized(this.file, async () => action(await this.read()));
  }
}

function validPin(job: DeploymentJob, pin: UpdateRecovery): boolean {
  return pin.schema === 1 && pin.jobId === job.id && pin.relayId === job.relayId
    && pin.hostKey?.host === job.ssh.host && pin.hostKey?.port === job.ssh.port
    && typeof pin.hostKey.algorithm === 'string' && typeof pin.hostKey.fingerprint === 'string'
    && pin.endpoint?.host === job.public.host && pin.endpoint?.port === job.public.port
    && Number.isSafeInteger(pin.revision) && pin.revision <= job.revision
    && pin.proof?.relayId === job.relayId && /^[A-Za-z0-9_-]{43}$/.test(pin.proof?.secret ?? '')
    && pin.proof?.artifactSha === pin.binding?.artifactSha && pin.proof?.releaseId === pin.binding?.releaseId
    && [pin.old?.inodes?.binary, pin.old?.inodes?.env, pin.old?.inodes?.unit]
      .every((id) => /^(absent|\d+:\d+)$/.test(id ?? ''))
    && [pin.old?.binary, pin.old?.env, pin.old?.unit].every((hash) => /^(absent|[a-f0-9]{64})$/.test(hash));
}
