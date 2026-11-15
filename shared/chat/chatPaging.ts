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

// Набор фильтров списка чатов. Пустые значения означают «фильтр выключен»;
// формат один для серверного запроса, ключа страницы и восстановления из localStorage.
export interface ChatListFilters {
  unread: boolean;
  waiting: boolean;
  working: boolean;
  task: string;
  provider: string;
  fresh: '' | 'day' | 'week' | 'month';
}

export const EMPTY_CHAT_FILTERS: ChatListFilters = Object.freeze({
  unread: false,
  waiting: false,
  working: false,
  task: '',
  provider: '',
  fresh: '',
});

/**
 * Восстановленный фильтр принимает только подтверждённые значения.
 * Повреждённый JSON и неизвестные поля откатываются к пустым фильтрам.
 */

export function normalizeChatFilters(value: unknown): ChatListFilters {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

  const flag = (entry: unknown) => entry === true || entry === '1';

  const task = typeof source.task === 'string' && /^(any|none|[0-9]{1,12})$/.test(source.task)
    ? source.task : '';

  const provider = typeof source.provider === 'string'
    && /^[A-Za-z0-9_-]{1,40}$/.test(source.provider) ? source.provider : '';

  const fresh = source.fresh === 'day' || source.fresh === 'week' || source.fresh === 'month'
    ? source.fresh : '';

  return {
    unread: flag(source.unread),
    waiting: flag(source.waiting),
    working: flag(source.working),
    task,
    provider,
    fresh,
  };
}

/**
 * Непустой набор определяет отдельную серверную выборку.
 * Область и текст поиска учитываются отдельно в ключе страницы.
 */

export function hasChatFilters(filters: ChatListFilters): boolean {
  return filters.unread || filters.waiting || filters.working
    || filters.task !== '' || filters.provider !== '' || filters.fresh !== '';
}

/**
 * В запрос уходят только включённые фильтры: пустой набор не меняет URL.
 * Формат общий для страницы списка и top-сверки после reconnect.
 */

export function chatFiltersQuery(filters: ChatListFilters): Record<string, string> {
  const query: Record<string, string> = {};

  if (filters.unread) {
    query.unread = '1';
  }

  if (filters.waiting) {
    query.waiting = '1';
  }

  if (filters.working) {
    query.working = '1';
  }

  if (filters.task) {
    query.task = filters.task;
  }

  if (filters.provider) {
    query.provider = filters.provider;
  }

  if (filters.fresh) {
    query.fresh = filters.fresh;
  }

  return query;
}

/**
 * Сырые значения запроса проверяются до чтения каталога.
 * Ошибка означает 400 всей страницы, а не молчаливое игнорирование фильтра.
 */

export function chatFilterQueryError(query: Record<string, unknown>): boolean {
  for (const key of ['unread', 'waiting', 'working']) {
    const value = query[key];

    if (value !== undefined && value !== '0' && value !== '1') {
      return true;
    }
  }

  const task = query.task;

  if (task !== undefined && task !== ''
    && (typeof task !== 'string' || !/^(any|none|[0-9]{1,12})$/.test(task))) {
    return true;
  }

  const provider = query.provider;

  if (provider !== undefined && provider !== ''
    && (typeof provider !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(provider))) {
    return true;
  }

  const fresh = query.fresh;

  if (fresh !== undefined && fresh !== ''
    && fresh !== 'day' && fresh !== 'week' && fresh !== 'month') {
    return true;
  }

  return false;
}

/**
 * Scope одинаков на сервере и в окне, включая регистр, пустой запрос и фильтры.
 * Пустые фильтры сохраняют прежний двухэлементный ключ и совместимость снимков.
 */

export function chatPageKey(
  query = '',
  archived = false,
  filters: ChatListFilters = EMPTY_CHAT_FILTERS,
): string {
  const normalized = normalizeChatFilters(filters);

  const scope = [archived, query.trim().toLowerCase()];

  return hasChatFilters(normalized) ? JSON.stringify([...scope, normalized]) : JSON.stringify(scope);
}
