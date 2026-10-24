import { promises as fs } from 'node:fs';

import { writeDurableFile } from '../durableFile.ts';
import type { CommandWorker } from '../pluginInstall/runCommand.ts';
import {
  isProviderInstallSnapshot,
  type ProviderInstallSnapshot,
} from '../../../../shared/chat/providerInstallContracts.ts';

export interface ProviderInstallState extends ProviderInstallSnapshot {
  worker: CommandWorker | null;
}

/**
 * Приватное состояние расширяет публичный снимок только ownership процесса.
 * Отсутствующий файл означает первый запуск, повреждённый запрещает новый installer.
 */
export async function readInstallState(file: string): Promise<ProviderInstallState | null> {
  let raw: string;

  try {
    const stat = await fs.stat(file);

    if (stat.size > 256 * 1024) {
      throw new Error('Файл состояния установки слишком большой');
    }

    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }

  const parsed: unknown = JSON.parse(raw);

  if (!isProviderInstallSnapshot(parsed)) {
    throw new Error('Повреждено состояние установки');
  }

  const worker = (parsed as ProviderInstallState).worker;

  if (worker != null && (!Number.isInteger(worker.pid) || worker.pid <= 0
    || !Number.isInteger(worker.supervisorPid) || worker.supervisorPid <= 0
    || !Number.isInteger(worker.pgid) || worker.pgid <= 0
    || !/^\d+$/u.test(worker.startTime) || !/^\d+$/u.test(worker.supervisorStartTime))) {
    throw new Error('Повреждено владение процессом установки');
  }

  return { ...parsed, worker: worker ?? null };
}

/**
 * Очередь сервиса сериализует эти записи, включая регистрацию worker до ACK.
 * Общий durable writer обеспечивает fsync и приватные права без второго atomic writer.
 */
export function writeInstallState(file: string, state: ProviderInstallState): Promise<void> {
  return writeDurableFile(file, JSON.stringify(state));
}
