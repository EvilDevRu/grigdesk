import { isRecord } from '../lib/objects.ts';
import {
  isProviderInstallJob,
  type ProviderInstallJob, type ProviderInstallNotice, type ProviderInstallSnapshot,
} from './providerInstallContracts.ts';

export type ProviderLifecycleOperation = 'install' | 'update' | 'reinstall' | 'uninstall' | 'migrate';
export type ProviderLifecyclePhase = 'preparing' | 'backup' | 'download-install' | 'version'
  | 'terminal' | 'models' | 'activation' | 'cleanup';
export type ProviderLifecycleStatus = 'running' | 'succeeded' | 'failed' | 'interrupted' | 'needs_attention';
export type ProviderLifecycleOutcome = 'installed' | 'updated' | 'current' | 'reinstalled' | 'uninstalled'
  | 'migrated' | 'activated_with_cleanup_pending';

export interface ProviderLifecycleTarget {
  providerId: string;
  installationId: string | null;
  phase: ProviderLifecyclePhase;
  outcome: ProviderLifecycleOutcome | null;
  error: ProviderInstallNotice | null;
}

export interface ProviderLifecycleJob
  extends Omit<ProviderInstallJob, 'operation' | 'stage' | 'status' | 'outcome'> {
  operation: ProviderLifecycleOperation;
  stage: ProviderLifecyclePhase;
  status: ProviderLifecycleStatus;
  outcome: ProviderLifecycleOutcome | null;
  affectedProviderIds: string[];
  targets: ProviderLifecycleTarget[];
  migrationPhase?: string;
}

export interface ProviderLifecycleSnapshot {
  schemaVersion: 2;
  revision: number;
  active: ProviderLifecycleJob | null;
  recent: Record<string, ProviderLifecycleJob>;
  blockedReason: string | ProviderInstallNotice | null;
}

export interface ProviderLifecycleFootprint {
  path: string;
  action: 'install' | 'replace' | 'remove' | 'rename' | 'cleanup';
  reason: string;
}

export interface ProviderLifecycleShellChange {
  file: string;
  action: 'remove';
  block: string;
}

export interface ProviderSessionHolder {
  ownerPid: number;
  childPid: number | null;
  sessionId: number | null;
  chatKey: string | null;
  ageSeconds: number;
}

export interface ProviderLifecyclePreparation {
  schemaVersion: 2;
  token: string;
  expiresAt: number;
  providerId: string;
  affectedProviderIds: string[];
  operation: ProviderLifecycleOperation;
  installationId: string | null;
  method: 'npm' | 'native';
  fromVersion: string | null;
  targetVersion: string | null;
  command: string;
  prefix: string | null;
  footprint: ProviderLifecycleFootprint[];
  shellChanges: ProviderLifecycleShellChange[];
  warnings: ProviderInstallNotice[];
  holders?: ProviderSessionHolder[];
}

export interface ProviderMigrationEntry {
  providerId: string;
  sourceIds: string[];
  targetMethod: 'npm';
  removeIds: string[];
}

export interface ProviderMigrationTarget {
  providerId: string;
  sourceIds: string[];
  removeIds: string[];
  targetMethod: 'npm';
  fromVersion: string | null;
  targetVersion: string;
  command: string;
  prefix: string;
  footprint: ProviderLifecycleFootprint[];
  warnings: ProviderInstallNotice[];
}

export interface ProviderLifecycleMigrationPreparation {
  schemaVersion: 2;
  token: string;
  expiresAt: number;
  operation: 'migrate';
  affectedProviderIds: string[];
  targets: ProviderMigrationTarget[];
  cleanupOwnedShell: boolean;
  shellChanges: ProviderLifecycleShellChange[];
  warnings: ProviderInstallNotice[];
}

/**
 * Версия транспорта отделяет новые действия и aggregate jobs от frozen v1 decoder.
 * Проверка принадлежности recent не позволяет приписать соседнему провайдеру чужую операцию.
 */
export function isProviderLifecycleSnapshot(value: unknown): value is ProviderLifecycleSnapshot {
  return isRecord(value) && value.schemaVersion === 2
    && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision >= 0
    && (value.active === null || isProviderLifecycleJob(value.active) && value.active.status === 'running')
    && isRecord(value.recent) && Object.keys(value.recent).length <= 64
    && Object.entries(value.recent).every(([id, job]) => isProviderLifecycleJob(job)
      && job.status !== 'running' && job.affectedProviderIds.includes(id))
    && (value.blockedReason === null || typeof value.blockedReason === 'string'
      || notice(value.blockedReason));
}

const OPERATIONS = ['install', 'update', 'reinstall', 'uninstall', 'migrate'];
const PHASES = ['preparing', 'backup', 'download-install', 'version', 'terminal', 'models',
  'activation', 'cleanup'];
const OUTCOMES = ['installed', 'updated', 'current', 'reinstalled', 'uninstalled', 'migrated',
  'activated_with_cleanup_pending'];
const notice = (value: unknown): value is ProviderInstallNotice => isRecord(value)
  && typeof value.code === 'string' && typeof value.message === 'string';
const providerId = (value: unknown): value is string => typeof value === 'string'
  && /^[a-zA-Z0-9_-]{1,64}$/u.test(value);
const outcome = (value: unknown): boolean => value === null || OUTCOMES.includes(String(value));
const identity = (value: unknown): boolean => value === null
  || typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);

/**
 * Общие поля проверяются прежним validator, enum v2 — отдельно, без вывода подставленных значений.
 * Многоцелевая операция перечисляет каждый затронутый provider ровно один раз.
 */
export function isProviderLifecycleJob(value: unknown): value is ProviderLifecycleJob {
  if (!isRecord(value) || !OPERATIONS.includes(String(value.operation))
    || !PHASES.includes(String(value.stage)) || !outcome(value.outcome)
    || !['running', 'succeeded', 'failed', 'interrupted', 'needs_attention'].includes(String(value.status))
    || !isProviderInstallJob({
      ...value,
      operation: 'install',
      stage: 'models',
      status: value.status === 'needs_attention' ? 'failed' : value.status,
      outcome: null,
    })
    || !Array.isArray(value.affectedProviderIds) || !value.affectedProviderIds.length
    || value.affectedProviderIds.length > 3 || !value.affectedProviderIds.every(providerId)
    || new Set(value.affectedProviderIds).size !== value.affectedProviderIds.length
    || !value.affectedProviderIds.includes(String(value.providerId))
    || !Array.isArray(value.targets) || value.targets.length !== value.affectedProviderIds.length
    || (value.status === 'running' ? value.finishedAt !== null : value.finishedAt === null)) {
    return false;
  }

  const seen = new Set<string>();

  for (const target of value.targets) {
    if (!isRecord(target) || !providerId(target.providerId) || seen.has(target.providerId)
      || !value.affectedProviderIds.includes(target.providerId) || !identity(target.installationId)
      || !PHASES.includes(String(target.phase)) || !outcome(target.outcome)
      || !(target.error === null || notice(target.error))) {
      return false;
    }

    seen.add(target.providerId);
  }

  return value.migrationPhase === undefined || typeof value.migrationPhase === 'string';
}

/**
 * Старый клиент получает только представимые jobs; новое обслуживание имеет явный busy-ответ.
 * Удаление и миграция никогда не переименовываются в update ради старого decoder.
 */
export function projectLifecycleV1(snapshot: ProviderLifecycleSnapshot): ProviderInstallSnapshot {
  const active = snapshot.active && isProviderInstallJob(snapshot.active) ? snapshot.active : null;

  return {
    revision: snapshot.revision,
    active,
    recent: Object.fromEntries(Object.entries(snapshot.recent).filter(([id, job]) =>
      id === job.providerId && isProviderInstallJob(job))) as Record<string, ProviderInstallJob>,
    blockedReason: snapshot.active && !active
      ? { code: 'maintenance', message: 'Идёт обслуживание исполнителя' } : snapshot.blockedReason,
  };
}

/**
 * Живой holder — процесс исполнителя с доказанным владельцем в lease-журнале.
 * Поле необязательное: сервер без инспекции сессий остаётся читаемым клиентом.
 */
export function isProviderSessionHolder(value: unknown): value is ProviderSessionHolder {
  return isRecord(value) && Number.isSafeInteger(value.ownerPid) && Number(value.ownerPid) > 0
    && (value.childPid === null || Number.isSafeInteger(value.childPid) && Number(value.childPid) > 0)
    && (value.sessionId === null || Number.isSafeInteger(value.sessionId)
      && Number(value.sessionId) > 0)
    && (value.chatKey === null || typeof value.chatKey === 'string' && value.chatKey.length <= 64)
    && typeof value.ageSeconds === 'number' && Number.isFinite(value.ageSeconds)
    && Number(value.ageSeconds) >= 0;
}

/**
 * В preview клиент получает только объяснение подтверждаемого эффекта и непрозрачный token.
 * Пути не становятся командами: start использует серверную подготовку, не возвращённые поля.
 */
export function isProviderLifecyclePreparation(value: unknown): value is ProviderLifecyclePreparation {
  if (!isRecord(value) || value.schemaVersion !== 2 || typeof value.token !== 'string' || !value.token
    || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= 0
    || !providerId(value.providerId) || !OPERATIONS.includes(String(value.operation))
    || !identity(value.installationId) || !['npm', 'native'].includes(String(value.method))
    || !['fromVersion', 'targetVersion'].every((key) => value[key] === null || typeof value[key] === 'string')
    || typeof value.command !== 'string' || !value.command
    || !(value.prefix === null || typeof value.prefix === 'string' && value.prefix.startsWith('/'))
    || !Array.isArray(value.affectedProviderIds) || !value.affectedProviderIds.every(providerId)
    || !value.affectedProviderIds.includes(String(value.providerId)) || value.affectedProviderIds.length > 3
    || new Set(value.affectedProviderIds).size !== value.affectedProviderIds.length
    || !Array.isArray(value.footprint) || value.footprint.length > 512
    || !Array.isArray(value.shellChanges) || !Array.isArray(value.warnings)
    || !value.warnings.every(notice)
    || value.holders !== undefined && (!Array.isArray(value.holders) || value.holders.length > 64
      || !value.holders.every(isProviderSessionHolder))) {
    return false;
  }

  return value.footprint.every((item) => isRecord(item) && typeof item.path === 'string'
    && item.path.startsWith('/')
    && ['install', 'replace', 'remove', 'rename', 'cleanup'].includes(String(item.action))
    && typeof item.reason === 'string')
    && value.shellChanges.every((item) => isRecord(item) && typeof item.file === 'string'
      && item.file.startsWith('/') && item.action === 'remove' && typeof item.block === 'string');
}

const absolutePath = (value: unknown): value is string => typeof value === 'string'
  && value.startsWith('/') && value.length <= 4096 && !value.includes('\0');
const identityList = (value: unknown): value is string[] => Array.isArray(value)
  && value.length > 0 && value.length <= 64 && new Set(value).size === value.length
  && value.every((item) => identity(item));

/**
 * Migration preview перечисляет конкретные старые копии и строки, которые исчезнут.
 * Клиент не может прислать пути или команды: только identity из inventory.
 */
export function isProviderLifecycleMigrationPreparation(value: unknown):
  value is ProviderLifecycleMigrationPreparation {
  if (!isRecord(value) || value.schemaVersion !== 2 || typeof value.token !== 'string' || !value.token
    || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= 0
    || value.operation !== 'migrate' || typeof value.cleanupOwnedShell !== 'boolean'
    || !Array.isArray(value.targets) || !value.targets.length || value.targets.length > 3
    || !Array.isArray(value.affectedProviderIds) || !Array.isArray(value.shellChanges)
    || !Array.isArray(value.warnings) || !value.warnings.every(notice)) {
    return false;
  }

  const providers = new Set<string>();

  for (const target of value.targets) {
    if (!isRecord(target) || !providerId(target.providerId) || providers.has(target.providerId)
      || target.targetMethod !== 'npm' || !identityList(target.sourceIds)
      || !Array.isArray(target.removeIds) || target.removeIds.length > 64
      || new Set(target.removeIds).size !== target.removeIds.length
      || !target.removeIds.every((id) => identity(id) && Array.isArray(target.sourceIds)
        && target.sourceIds.includes(id))
      || !(target.fromVersion === null || typeof target.fromVersion === 'string')
      || typeof target.targetVersion !== 'string' || !target.targetVersion
      || typeof target.command !== 'string' || !target.command
      || !absolutePath(target.prefix)
      || !Array.isArray(target.footprint) || target.footprint.length > 512
      || !Array.isArray(target.warnings) || !target.warnings.every(notice)) {
      return false;
    }

    providers.add(target.providerId);
  }

  return value.affectedProviderIds.length === providers.size
    && new Set(value.affectedProviderIds).size === providers.size
    && value.affectedProviderIds.every((provider) => providers.has(provider))
    && value.shellChanges.every((item) => isRecord(item) && absolutePath(item.file)
      && item.action === 'remove' && typeof item.block === 'string' && item.block.length > 0);
}
