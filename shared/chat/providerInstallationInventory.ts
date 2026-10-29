import { isRecord } from '../lib/objects.ts';

export interface ExternalCliInstallation {
  installationId: string;
  resourceKey: string;
  source: 'npm' | 'native' | 'unknown';
  state: 'ready' | 'broken' | 'unverified' | 'missing';
  path: string;
  realpath: string | null;
  root: string | null;
  prefix: string | null;
  version: string | null;
  aliases: string[];
  origin?: 'user' | 'grigdesk';
}

export interface ExternalCliInventory {
  installations: ExternalCliInstallation[];
  selectedId: string | null;
  terminalId: string | null;
  conflict: boolean;
  environment?: { state: 'ready' | 'unavailable'; reason?: string };
}

const identity = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{64}$/u.test(value);
const absolute = (value: unknown): value is string => typeof value === 'string'
  && value.startsWith('/') && value.length <= 4096 && !value.includes('\0');

/**
 * Публичный inventory не принимает пути-команды и незнакомые состояния копии.
 * Идентификаторы выбора должны ссылаться на записи этого же атомарного снимка.
 */
export function isExternalCliInventory(value: unknown): value is ExternalCliInventory {
  if (!isRecord(value) || !Array.isArray(value.installations) || value.installations.length > 512
    || typeof value.conflict !== 'boolean') {
    return false;
  }
  if (value.environment !== undefined && (!isRecord(value.environment)
    || !['ready', 'unavailable'].includes(String(value.environment.state))
    || value.environment.reason !== undefined && typeof value.environment.reason !== 'string')) {
    return false;
  }

  const ids = new Set<string>();

  for (const item of value.installations) {
    if (!isRecord(item) || !identity(item.installationId) || !identity(item.resourceKey)
      || ids.has(item.installationId) || !['npm', 'native', 'unknown'].includes(String(item.source))
      || !['ready', 'broken', 'unverified', 'missing'].includes(String(item.state))
      || !absolute(item.path) || !['realpath', 'root', 'prefix'].every((key) =>
        item[key] === null || absolute(item[key]))
      || !(item.version === null || typeof item.version === 'string' && item.version.length <= 128)
      || !Array.isArray(item.aliases) || !item.aliases.length || item.aliases.length > 512
      || !item.aliases.every(absolute) || !item.aliases.includes(item.path)
      || item.origin !== undefined && !['user', 'grigdesk'].includes(String(item.origin))) {
      return false;
    }

    ids.add(item.installationId);
  }

  return [value.selectedId, value.terminalId].every((id) => id === null
    || typeof id === 'string' && ids.has(id));
}
