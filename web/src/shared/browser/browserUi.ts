import { isPlainRecord } from '../../../../shared/lib/objects.ts';
import { normalizeBrowserPreferences } from '../../../../shared/browser/browserContract.ts';
import type { BrowserPreferences } from '../../../../shared/browser/browserContract.ts';

export interface BrowserApp {
  id: string;
  name: string;
}

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  creator: 'human' | 'agent';
  owner: string | null;
  grantee: string | null;
  grantOrigin: string | null;
  grantEpoch: number;
  pageEpoch: number;
  paused: boolean;
  loading: boolean;
  error: string;
  canBack: boolean;
  canForward: boolean;
  zoom: number;
}

export interface BrowserSnapshot {
  revision: number;
  preferences: BrowserPreferences;
  active: string | null;
  tabs: BrowserTab[];
  grants: {
    tabId: string;
    grantEpoch: number;
    pageEpoch: number;
    paused: boolean
  }[];
}

export interface BrowserGrantInput {
  tabId: string;
  ownerId: string;
  pageEpoch: number;
  grantEpoch: number;
}

export interface BrowserOwnerChoice {
  id: string;
  label: string;
}

export interface BrowserHostStatus {
  phase: 'off' | 'starting' | 'online' | 'conflict' | 'error';
  error: string;
}

export interface BrowserHostControls {
  retry(takeover?: boolean): void;
  sync(): Promise<void>;
  owners(): Promise<BrowserOwnerChoice[]>;
  grant(input: BrowserGrantInput): Promise<unknown>;
  revoke(tabId: string): Promise<void>;
  disablePreference(): Promise<void>;
}

/**
 * Canonical scope используется только для подписи владельца в интерфейсе.
 * Декодер не выдаёт разрешения и отклоняет некорректную форму identity.
 */
export function browserOwnerScope(value: unknown): { kind: 'chat' | 'task'; key: string } | null {
  if (typeof value !== 'string' || value.length > 1024) {
    return null;
  }

  try {
    const row: unknown = JSON.parse(value);

    if (!Array.isArray(row) || row.length !== 4 || JSON.stringify(row) !== value
      || !['chat', 'task'].includes(String(row[0]))
      || !(row[1] === null || typeof row[1] === 'string' && row[1].length <= 200)
      || typeof row[2] !== 'string' || !row[2] || row[2].length > 200
      || /[\u0000-\u001f]/u.test(row[2])
      || (row[0] === 'chat' ? row[3] !== null
        : typeof row[1] !== 'string' || !row[1] || typeof row[3] !== 'string'
          || !/^a_[a-f0-9]{32}$/u.test(row[3]))) {
      return null;
    }

    return { kind: row[0] as 'chat' | 'task', key: row[2] };
  } catch {
    return null;
  }
}

/**
 * Native metadata не является произвольным объектом для публичного Pinia state.
 * Декодер копирует только объявленные поля и ограничивает размер каталога вкладок.
 */
export function decodeBrowserSnapshot(value: unknown): BrowserSnapshot {
  if (!isPlainRecord(value) || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 0 || !Array.isArray(value.tabs) || value.tabs.length > 20
    || !(value.active === null || typeof value.active === 'string')) {
    throw new Error('browser_snapshot_invalid');
  }

  const tabs = value.tabs.map((item): BrowserTab => {
    if (!isPlainRecord(item) || typeof item.id !== 'string' || item.id.length > 160
      || typeof item.url !== 'string' || item.url.length > 8192
      || !Number.isSafeInteger(item.grantEpoch) || Number(item.grantEpoch) < 1
      || !Number.isSafeInteger(item.pageEpoch) || Number(item.pageEpoch) < 1
      || !['human', 'agent'].includes(String(item.creator))
      || !(item.owner === null || browserOwnerScope(item.owner))
      || !(item.grantee === null || browserOwnerScope(item.grantee))) {
      throw new Error('browser_snapshot_invalid');
    }

    return {
      id: item.id,
      url: item.url,
      title: String(item.title ?? '').slice(0, 500),
      creator: item.creator as BrowserTab['creator'],
      owner: item.owner as string | null,
      grantee: item.grantee as string | null,
      grantOrigin: typeof item.grantOrigin === 'string' ? item.grantOrigin : null,
      grantEpoch: Number(item.grantEpoch),
      pageEpoch: Number(item.pageEpoch),
      paused: item.paused === true,
      loading: item.loading === true,
      error: typeof item.error === 'string' ? item.error.slice(0, 160) : '',
      canBack: item.canBack === true,
      canForward: item.canForward === true,
      zoom: typeof item.zoom === 'number' && Number.isFinite(item.zoom)
        ? Math.max(25, Math.min(300, item.zoom)) : 100,
    };
  });

  if (new Set(tabs.map((tab) => tab.id)).size !== tabs.length
    || value.active !== null && !tabs.some((tab) => tab.id === value.active)) {
    throw new Error('browser_snapshot_invalid');
  }

  return {
    revision: Number(value.revision),
    preferences: normalizeBrowserPreferences(value.preferences),
    active: value.active as string | null,
    tabs,
    grants: Array.isArray(value.grants) ? value.grants.map((item) => {
      if (!isPlainRecord(item) || typeof item.tabId !== 'string'
        || !Number.isSafeInteger(item.grantEpoch) || !Number.isSafeInteger(item.pageEpoch)
        || typeof item.paused !== 'boolean' || !tabs.some((tab) => tab.id === item.tabId)) {
        throw new Error('browser_snapshot_invalid');
      }

      return {
        tabId: item.tabId,
        grantEpoch: Number(item.grantEpoch),
        pageEpoch: Number(item.pageEpoch),
        paused: item.paused,
      };
    }) : [],
  };
}
