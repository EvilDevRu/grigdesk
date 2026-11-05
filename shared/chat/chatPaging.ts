export const CHAT_PAGE_SIZE = 40;

export interface ChatWindowBase {
  offset: number;
  prefixHash: string;
  historyEpoch?: number;
  baseEnd?: number;
  baseHash?: string;
}

export interface ChatHistoryWindow extends ChatWindowBase {
  end: number;
  total: number;
  before: string | null;
  hasOlder: boolean;
  stale?: boolean;
  confirmedKeys?: string[];
}

export interface ChatCatalogSummary {
  active: number;
  archived: number;
  unread: number;
  waiting: number;
  epoch: string;
  sequence: number;
}

export interface ChatCatalogPage {
  ids: string[];
  overlayIds: string[];
  nextCursor: string | null;
  hasMore: boolean;
  loaded: boolean;
  loading: boolean;
  error: string;
  needsRefresh: boolean;
  scrollTop: number;
}

/**
 * Scope одинаков на сервере и в окне, включая регистр и пустой запрос.
 * Сам ключ не запускает загрузку и не означает полноту каталога.
 */
export function chatPageKey(query = '', archived = false): string {
  return JSON.stringify([archived, query.trim().toLowerCase()]);
}
