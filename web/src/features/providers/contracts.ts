import { isProviderInstallationMetadata } from '../../../../shared/chat/providerInstallContracts.ts';
import { isRecord } from '../../../../shared/lib/objects.ts';
import type { ProviderEntry, ProviderModelEntry } from '../../../../shared/chat/providersContracts.ts';

export interface UsageControl {
  [field: string]: unknown;
  id?: string;
  kind?: string;
  scope?: string;
  label?: string;
  href?: string;
  action?: string;
  field?: string;
  unit?: string;
  disabled?: boolean;
  value?: string | number | boolean | null;
  payload?: Record<string, unknown>;
  minExclusive?: number;
  confirm?: {
    text?: string;
    label?: string;
    danger?: boolean;
    on?: {
      text?: string;
      label?: string;
      danger?: boolean;
    };
    off?: {
      text?: string;
      label?: string;
      danger?: boolean;
    };
  };
}

export interface UsageResource {
  key?: string;
  label?: string;
  summary?: string;
  note?: string;
  kind?: string;
  tone?: string;
  percent?: number;
  balance?: { amount: number; currency: string };
  controls?: UsageControl[];
  [field: string]: unknown;
}

export interface UsageBar {
  fresh?: boolean;
  note?: string;
  key?: string;
  pct?: number | null;
  label?: string;
  group?: string;
  windowMinutes?: number | null;
  resetsAt?: string | null;
  [field: string]: unknown;
}

export interface UsageEntry {
  lastSuccessfulAt?: number | null;
  runtimeGeneration?: string;
  pollIntervalMs?: number;
  usageSchema?: string;
  stale?: boolean;
  state?: string;
  bars?: UsageBar[];
  resources?: UsageResource[];
  message?: string;
  measuredAt?: number | string;
  retryAt?: string | number;
  action?: {
    kind: string;
    command?: string;
    label: string;
  } | null;
  vendorStatus?: {
    state?: string;
    summary?: string;
    components?: string[];
    incident?: string;
  };
  [field: string]: unknown;
}

/**
 * Проверяет только переданные поля старых и новых ответов, сохраняя расширения.
 * Одинаковая граница используется HTTP и событиями общего SSE.
 */
function fields(value: unknown, texts: string[] = [], numbers: string[] = [], flags: string[] = []) {
  return isRecord(value)
    && texts.every((key) => value[key] == null || typeof value[key] === 'string')
    && numbers.every((key) => value[key] == null || typeof value[key] === 'number')
    && flags.every((key) => value[key] == null || typeof value[key] === 'boolean');
}

/**
 * Реестр допускает произвольные имена моделей, алиасы и ступени усилия.
 * Повреждённые контейнеры не могут заменить последнюю принятую карточку.
 */
function isModel(value: unknown): value is ProviderModelEntry {
  return isRecord(value) && typeof value.id === 'string'
    && (value.installation == null || isProviderInstallationMetadata(value.installation))
    && fields(value, ['name', 'family'], ['context'],
      ['extra', 'hidden', 'unknown', 'contextRuntimeOnly', 'contextUnverified'])
    && ['efforts', 'aliases', 'modelRefAliases'].every((key) => value[key] == null
      || (Array.isArray(value[key]) && value[key].every((item) => typeof item === 'string')));
}

/**
 * Не достраивает отсутствующие optional-поля старого сервера.
 * Оригинальные объекты и неизвестные расширения остаются у потребителя.
 */
export function isProvider(value: unknown): value is ProviderEntry {
  return isRecord(value) && typeof value.id === 'string'
    && (value.installation == null || isProviderInstallationMetadata(value.installation))
    && fields(value, ['name', 'type', 'vendor', 'kind', 'statusPage', 'version', 'auth', 'authLabel',
      'setupCommand', 'install', 'color', 'latest'], [],
    ['available', 'installed', 'mcp', 'chatEnabled', 'canUpdate',
      'updateAvailable', 'settingsCatalog', 'sessionBinding'])
    && (value.models == null || (Array.isArray(value.models) && value.models.every(isModel)))
    && (value.commands == null || (Array.isArray(value.commands)
      && value.commands.every((command) => isRecord(command) && typeof command.cmd === 'string'
        && fields(command, ['desc', 'run', 'hint'])
        && (command.kind == null || command.kind === 'skill')
        && (command.args == null || ['string', 'boolean'].includes(typeof command.args)))))
    && ['settings', 'credentials', 'modes'].every((key) => value[key] == null
      || (Array.isArray(value[key]) && value[key].every(isRecord)));
}

/**
 * Полосы и ресурсы проверяются до публикации всего снимка usage.
 * Проекция не отбрасывает неизвестные данные будущего адаптера.
 */
function isUsage(value: unknown): value is UsageEntry {
  if (!isRecord(value) || !fields(value, ['state', 'message'], [], ['stale'])
    || (value.lastSuccessfulAt !== undefined && value.lastSuccessfulAt !== null
      && (typeof value.lastSuccessfulAt !== 'number' || !Number.isFinite(value.lastSuccessfulAt)))
    || (value.runtimeGeneration !== undefined && typeof value.runtimeGeneration !== 'string')
    || (value.pollIntervalMs !== undefined
      && (typeof value.pollIntervalMs !== 'number' || !Number.isFinite(value.pollIntervalMs)
        || value.pollIntervalMs <= 0))
    || (value.retryAt != null && !['string', 'number'].includes(typeof value.retryAt))) {
    return false;
  }

  const actionValid = value.action == null || (isRecord(value.action)
    && typeof value.action.kind === 'string' && typeof value.action.label === 'string'
    && fields(value.action, ['command']));
  const statusValid = value.vendorStatus == null || (isRecord(value.vendorStatus)
    && fields(value.vendorStatus, ['state', 'summary', 'incident'])
    && (value.vendorStatus.components == null || (Array.isArray(value.vendorStatus.components)
      && value.vendorStatus.components.every((part) => typeof part === 'string'))));

  return actionValid && statusValid && (value.bars == null || (Array.isArray(value.bars)
    && value.bars.every((bar) => fields(bar, ['key', 'label', 'group', 'resetsAt', 'note'],
      ['pct', 'windowMinutes'], ['fresh']))))
    && (value.resources == null || (Array.isArray(value.resources) && value.resources.every((resource) => (
      isRecord(resource) && fields(resource, ['key', 'label', 'summary', 'note', 'kind', 'tone'], ['percent'])
      && (resource.balance == null || (isRecord(resource.balance)
        && typeof resource.balance.amount === 'number' && typeof resource.balance.currency === 'string'))
      && (resource.controls == null || (Array.isArray(resource.controls)
        && resource.controls.every((control) => (
        fields(control, ['id', 'kind', 'scope', 'label', 'href', 'action', 'field', 'unit'],
          ['minExclusive'], ['disabled'])
      ))))
    ))));
}

/**
 * Событие и HTTP используют общий проверенный словарь исполнителей.
 * Неверная запись отклоняет снимок целиком, сохраняя прежнее состояние.
 */
export function isUsageSnapshot(value: unknown): value is Record<string, UsageEntry> {
  return isRecord(value) && Object.values(value).every(isUsage);
}

/**
 * Подтверждение действия сохраняет исходную форму и неизвестные поля адаптера.
 * Проверка читаемых флагов не превращает malformed ACK в успешную запись.
 */
export function isUsageActionReply(value: unknown): value is {
  ok?: boolean;
  error?: string;
  message?: string;
} {
  return fields(value, ['error', 'message'], [], ['ok']);
}
