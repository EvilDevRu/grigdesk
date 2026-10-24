import { isRecord } from '../lib/objects.ts';

export type ProviderInstallOperation = 'install' | 'update';
export type ProviderInstallStage = 'download-install' | 'version' | 'models';
export type ProviderInstallStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';
export type ProviderInstallOutcome = 'installed' | 'updated' | 'current';

export interface ProviderInstallNotice {
  code: string;
  message: string;
}

export interface ProviderInstallationMetadata {
  installCommand: string;
  updateCommand: string | null;
  fallbackInstallCommand: string;
  fallbackUpdateCommand: string | null;
  loginCommand: string;
  canInstall: boolean;
  canUpdate: boolean;
}

export interface ProviderInstallJob {
  id: string;
  providerId: string;
  operation: ProviderInstallOperation;
  status: ProviderInstallStatus;
  stage: ProviderInstallStage;
  before: string;
  after: string;
  outcome: ProviderInstallOutcome | null;
  error: ProviderInstallNotice | null;
  warnings: (string | ProviderInstallNotice)[];
  retry?: {
    attempt: number;
    attempts: number;
  };
  outputTail: string;
  command: string;
  fallbackCommand: string;
  loginCommand: string;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface ProviderInstallSnapshot {
  revision: number;
  active: ProviderInstallJob | null;
  recent: Record<string, ProviderInstallJob>;
  blockedReason: string | ProviderInstallNotice | null;
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isNotice = (value: unknown): value is ProviderInstallNotice =>
  isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string';

const isRetry = (value: unknown): boolean => isRecord(value)
  && typeof value.attempt === 'number' && Number.isInteger(value.attempt) && value.attempt >= 2
  && typeof value.attempts === 'number' && Number.isInteger(value.attempts)
  && value.attempts >= value.attempt && value.attempts <= 3;

/**
 * Команды публичной карточки служат только для объяснения действия человеку.
 * Аргументы процесса и окружение остаются в серверной декларации адаптера.
 */
export function isProviderInstallationMetadata(value: unknown): value is ProviderInstallationMetadata {
  return isRecord(value)
    && ['installCommand', 'fallbackInstallCommand', 'loginCommand']
      .every((key) => typeof value[key] === 'string')
    && ['updateCommand', 'fallbackUpdateCommand']
      .every((key) => value[key] === null || typeof value[key] === 'string')
    && typeof value.canInstall === 'boolean' && typeof value.canUpdate === 'boolean';
}

/**
 * Снимок принимается целиком: неверная фаза или хвост не попадает в проекцию UI.
 * Ограничение байтов считается по UTF-8 и действует также на незавершённую строку.
 */
export function isProviderInstallJob(value: unknown): value is ProviderInstallJob {
  if (!isRecord(value)) {
    return false;
  }

  return ['id', 'providerId', 'before', 'after', 'outputTail', 'command',
    'fallbackCommand', 'loginCommand'].every((key) => typeof value[key] === 'string')
    && ['install', 'update'].includes(String(value.operation))
    && ['running', 'succeeded', 'failed', 'interrupted'].includes(String(value.status))
    && ['download-install', 'version', 'models'].includes(String(value.stage))
    && (value.outcome === null || ['installed', 'updated', 'current'].includes(String(value.outcome)))
    && (value.error === null || isNotice(value.error))
    && Array.isArray(value.warnings)
    && value.warnings.every((item) => typeof item === 'string' || isNotice(item))
    && (value.retry === undefined || isRetry(value.retry))
    && finite(value.startedAt) && finite(value.updatedAt)
    && (value.finishedAt === null || finite(value.finishedAt))
    && typeof value.outputTail === 'string' && value.outputTail.split('\n').length <= 200
    && new TextEncoder().encode(value.outputTail).length <= 32 * 1024;
}

/**
 * Revision защищает атомарный серверный снимок от поздних GET и SSE.
 * История ограничена последним результатом каждого исполнителя, без приватной identity.
 */
export function isProviderInstallSnapshot(value: unknown): value is ProviderInstallSnapshot {
  return isRecord(value) && finite(value.revision)
    && (value.active === null || (isProviderInstallJob(value.active) && value.active.status === 'running'))
    && isRecord(value.recent) && Object.keys(value.recent).length <= 3
    && Object.entries(value.recent).every(([id, job]) => isProviderInstallJob(job)
      && job.providerId === id && job.status !== 'running')
    && (value.blockedReason === null || typeof value.blockedReason === 'string'
      || isNotice(value.blockedReason));
}

/**
 * Транспорт не исправляет повреждённый снимок догадками о результате операции.
 * Ошибка оставляет клиенту возможность перечитать состояние с сервера.
 */
export function decodeProviderInstallSnapshot(value: unknown): ProviderInstallSnapshot {
  if (!isProviderInstallSnapshot(value)) {
    throw new Error('Некорректный снимок установки исполнителя');
  }

  return value;
}
