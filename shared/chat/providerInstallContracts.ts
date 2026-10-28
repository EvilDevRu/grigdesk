import { isRecord } from '../lib/objects.ts';
import { isExternalCliInventory } from './providerInstallationInventory.ts';
import type { ExternalCliInventory } from './providerInstallationInventory.ts';

export type ProviderInstallOperation = 'install' | 'update';
export type ProviderInstallStage = 'download-install' | 'version' | 'terminal' | 'models';
export type ProviderInstallStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';
export type ProviderInstallOutcome = 'installed' | 'updated' | 'current';
export type ProviderInstallTerminalSetup = 'none' | 'bash' | 'manual';
export type ProviderInstallShellAction = 'create' | 'update';

export interface ProviderInstallNotice {
  code: string;
  message: string;
}

/**
 * Итог внешней оболочки отделён от успеха CLI: установленная копия может работать
 * в GrigDesk и не находиться по имени в обычном терминале. `reason` — код причины,
 * а каталог и оболочка передаются отдельными данными.
 */
export interface ProviderInstallTerminal {
  status: 'ready' | 'needs_setup' | 'conflict';
  reason: string | null;
  binDirectory: string;
  shell: 'bash' | 'other';
}

/**
 * Перенос при равной версии показывает человеку смену пути исполняемого файла.
 * Оба пути относятся к одной npm-копии и не являются настройкой окружения.
 */
export interface ProviderInstallMigration {
  from: string;
  to: string;
}

/**
 * Подготовка — это уже выбранный сервером результат, а не запрос параметров.
 * Token непрозрачен и связывает preview с единственным стартом; env и argv
 * остаются на сервере и в этот DTO не попадают.
 */
export interface ProviderInstallShellChange {
  file: string;
  action: ProviderInstallShellAction;
  block: string;
}

export interface ProviderInstallPreparation {
  token: string;
  expiresAt: number;
  providerId: string;
  operation: ProviderInstallOperation;
  command: string;
  prefix: string | null;
  shellChanges: ProviderInstallShellChange[];
  terminalSetup: ProviderInstallTerminalSetup;
  warnings: ProviderInstallNotice[];
}

export interface ProviderInstallationMetadata {
  lifecycleProtocol?: 2;
  canReinstall?: boolean;
  canUninstall?: boolean;
  inventory?: ExternalCliInventory;
  manualInstallCommand?: string;
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
  terminal?: ProviderInstallTerminal;
  migration?: ProviderInstallMigration;
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

/**
 * Строгое поле контракта не принимает лишних ключей: иначе новая серверная
 * настройка могла бы проехать в старое окно и остаться незамеченной.
 */
function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(value);

  return keys.length === required.length && required.every((key) => Object.hasOwn(value, key));
}

const isTerminal = (value: unknown): value is ProviderInstallTerminal => {
  if (!isRecord(value) || !exactKeys(value, ['status', 'reason', 'binDirectory', 'shell'])) {
    return false;
  }

  return ['ready', 'needs_setup', 'conflict'].includes(String(value.status))
    && (value.reason === null || typeof value.reason === 'string')
    && typeof value.binDirectory === 'string' && value.binDirectory.startsWith('/')
    && ['bash', 'other'].includes(String(value.shell));
};

const isMigration = (value: unknown): value is ProviderInstallMigration => isRecord(value)
  && exactKeys(value, ['from', 'to'])
  && typeof value.from === 'string' && value.from.startsWith('/')
  && typeof value.to === 'string' && value.to.startsWith('/');

const isShellChange = (value: unknown): value is ProviderInstallShellChange => isRecord(value)
  && exactKeys(value, ['file', 'action', 'block'])
  && typeof value.file === 'string' && value.file.startsWith('/')
  && ['create', 'update'].includes(String(value.action))
  && typeof value.block === 'string' && value.block.length > 0;

/**
 * Подготовка проверяется целиком: неполный preview не должен превращаться
 * в подтверждение другого каталога или другой команды.
 */
export function isProviderInstallPreparation(value: unknown): value is ProviderInstallPreparation {
  if (!isRecord(value) || !exactKeys(value, ['token', 'expiresAt', 'providerId', 'operation',
    'command', 'prefix', 'shellChanges', 'terminalSetup', 'warnings'])) {
    return false;
  }

  return typeof value.token === 'string' && value.token.length > 0
    && finite(value.expiresAt)
    && typeof value.providerId === 'string' && value.providerId.length > 0
    && ['install', 'update'].includes(String(value.operation))
    && typeof value.command === 'string' && value.command.length > 0
    && (value.prefix === null
      || (typeof value.prefix === 'string' && value.prefix.startsWith('/')))
    && Array.isArray(value.shellChanges) && value.shellChanges.every(isShellChange)
    && ['none', 'bash', 'manual'].includes(String(value.terminalSetup))
    && Array.isArray(value.warnings) && value.warnings.every(isNotice);
}

/**
 * Транспорт не исправляет подготовку догадками о каталоге или файлах.
 * Неверный DTO требует нового preview, а не запуска с частичными данными.
 */
export function decodeProviderInstallPreparation(value: unknown): ProviderInstallPreparation {
  if (!isProviderInstallPreparation(value)) {
    throw new Error('Некорректная подготовка установки исполнителя');
  }

  return value;
}

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
    && typeof value.canInstall === 'boolean' && typeof value.canUpdate === 'boolean'
    && (value.manualInstallCommand === undefined || typeof value.manualInstallCommand === 'string')
    && (value.inventory === undefined || isExternalCliInventory(value.inventory))
    && (value.lifecycleProtocol === undefined || value.lifecycleProtocol === 2)
    && ['canReinstall', 'canUninstall'].every((key) => value[key] === undefined
      || typeof value[key] === 'boolean');
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
    && ['download-install', 'version', 'terminal', 'models'].includes(String(value.stage))
    && (value.outcome === null || ['installed', 'updated', 'current'].includes(String(value.outcome)))
    && (value.error === null || isNotice(value.error))
    && Array.isArray(value.warnings)
    && value.warnings.every((item) => typeof item === 'string' || isNotice(item))
    && (value.retry === undefined || isRetry(value.retry))
    && (value.terminal === undefined || isTerminal(value.terminal))
    && (value.migration === undefined || isMigration(value.migration))
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
