import { promises as fs } from 'node:fs';

import { isProviderLifecycleSnapshot, type ProviderLifecycleSnapshot }
  from '../../../../shared/chat/providerLifecycleContracts.ts';

import { isRecord } from '../../../../shared/lib/objects.ts';
import type { RemovedCliBinding } from './lifecycleBinding.ts';
import { writeDurableFile } from '../durableFile.ts';
import type { CommandWorker } from '../packageInstall/runCommand.ts';
import { isMigrationJournal, type MigrationJournal } from './legacyBinMigration.ts';
import {
  isProviderInstallSnapshot,
  type ProviderInstallSnapshot,
} from '../../../../shared/chat/providerInstallContracts.ts';

export interface LifecycleNpmRecovery {
  kind?: 'npm';
  backup: string;
  packageRoot: string;
  alias: string;
  operation: string;
  targetVersion?: string | null;
  selectedVersion?: string | null;
  removedBinding?: RemovedCliBinding | null;
}

export interface LifecycleNativeRecovery extends Omit<LifecycleNpmRecovery, 'kind'> {
  kind: 'native';
  providerId: string;
}

export interface LifecycleMigrationRecovery {
  kind: 'migration';
  phase: 'installing' | 'activation' | 'terminal' | 'binding' | 'cleanup';
  directory: string;
  envPath: string | null;
  configChanges: Record<string, string>;
  shell: {
    file: string;
    backup: string;
    mode: number;
    afterHash: string;
  }[];
  shims: {
    from: string;
    to: string;
    backup: string;
  }[];
  removeRoots: string[];
  removeAliases: string[];
  newBins: string[];
  providers: string[];
}

export type LifecycleRecovery = LifecycleNpmRecovery | LifecycleNativeRecovery | LifecycleMigrationRecovery;

export interface ProviderInstallState extends ProviderInstallSnapshot {
  worker: CommandWorker | null;
  lifecycle?: ProviderLifecycleSnapshot;
  lifecycleRecovery?: LifecycleRecovery | null;
  // Узкий журнал одной доказанной legacy-ссылки; в публичный снимок не входит.
  migration?: MigrationJournal | null;
}

/**
 * Восстановление после рестарта читает только проверенную форму.
 * Старые npm-записи без kind остаются совместимыми; migration обязана назвать phase.
 */
function isLifecycleRecovery(value: unknown): value is LifecycleRecovery {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === 'migration') {
    const shell = value.shell;
    const shims = value.shims;

    return ['installing', 'activation', 'terminal', 'binding', 'cleanup'].includes(String(value.phase))
      && typeof value.directory === 'string' && value.directory.startsWith('/')
      && (value.envPath === null || typeof value.envPath === 'string' && value.envPath.startsWith('/'))
      && isRecord(value.configChanges)
      && Object.entries(value.configChanges).every(([, item]) => typeof item === 'string')
      && Array.isArray(shell) && shell.every((item) => isRecord(item)
        && typeof item.file === 'string' && item.file.startsWith('/')
        && typeof item.backup === 'string' && item.backup.startsWith('/')
        && Number.isInteger(item.mode) && typeof item.afterHash === 'string')
      && Array.isArray(shims) && shims.every((item) => isRecord(item)
        && typeof item.from === 'string' && typeof item.to === 'string'
        && typeof item.backup === 'string')
      && ['removeRoots', 'removeAliases', 'newBins', 'providers'].every((key) =>
        Array.isArray(value[key]) && value[key].every((item: unknown) => typeof item === 'string'));
  }

  const binding = value.removedBinding;

  return (value.kind === undefined || value.kind === 'npm'
      || value.kind === 'native' && typeof value.providerId === 'string')
    && ['backup', 'packageRoot', 'alias', 'operation'].every((key) => typeof value[key] === 'string')
    && (value.targetVersion === undefined || value.targetVersion === null
      || typeof value.targetVersion === 'string')
    && (value.selectedVersion === undefined || value.selectedVersion === null
      || typeof value.selectedVersion === 'string')
    && (binding == null || isRecord(binding)
      && ['configKey', 'envKey', 'binName', 'value']
        .every((key) => typeof binding[key] === 'string'));
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

  const lifecycle = (parsed as ProviderInstallState).lifecycle;

  if (lifecycle !== undefined && !isProviderLifecycleSnapshot(lifecycle)) {
    throw new Error('Повреждено состояние обслуживания CLI');
  }

  const worker = (parsed as ProviderInstallState).worker;

  if (worker != null && (!Number.isInteger(worker.pid) || worker.pid <= 0
    || !Number.isInteger(worker.supervisorPid) || worker.supervisorPid <= 0
    || !Number.isInteger(worker.pgid) || worker.pgid <= 0
    || !/^\d+$/u.test(worker.startTime) || !/^\d+$/u.test(worker.supervisorStartTime))) {
    throw new Error('Повреждено владение процессом установки');
  }

  const migration = (parsed as ProviderInstallState).migration ?? null;

  if (migration !== null && !isMigrationJournal(migration)) {
    throw new Error('Повреждён журнал миграции bin-ссылки');
  }

  const recovery = (parsed as ProviderInstallState).lifecycleRecovery ?? null;

  if (recovery !== null && !isLifecycleRecovery(recovery)) {
    throw new Error('Повреждено состояние восстановления обслуживания');
  }

  return {
    ...parsed,
    worker: worker ?? null,
    migration,
    lifecycleRecovery: recovery,
  };
}

/**
 * Очередь сервиса сериализует эти записи, включая регистрацию worker до ACK.
 * Общий durable writer обеспечивает fsync и приватные права без второго atomic writer.
 */
export function writeInstallState(file: string, state: ProviderInstallState): Promise<void> {
  return writeDurableFile(file, JSON.stringify(state));
}
