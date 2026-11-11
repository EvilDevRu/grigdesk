import path from 'node:path';

import type { DeploymentJob } from '../../../../../shared/mobile/relayDeploymentContracts.ts';
import { privateRead, privateWrite, serialized } from '../files.ts';

export interface DeploymentRecord {
  job: DeploymentJob;
  receipts: Record<string, {
    input: string;
    result: DeploymentJob;
    status: number;
  }>;
  before?: Pick<import('../store.ts').Relay, 'id' | 'host' | 'port' | 'enabled'>;
}

/**
 * Хранит только разрешённые публичные параметры и квитанции административных действий.
 * Секреты SSH остаются у worker и никогда не передаются этому журналу.
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
      || raw.jobs.some((record) => !record.job?.id || !Number.isSafeInteger(record.job.revision))) {
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
}
