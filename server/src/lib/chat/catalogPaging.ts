import { randomUUID } from 'node:crypto';

import {
  chatFilterQueryError, chatPageKey, normalizeChatFilters,
} from '../../../../shared/chat/chatPaging.ts';

import type { WebChatHead } from '../../../../shared/chat/chatListProjection.ts';

import type { ChatHistoryStore } from './historyStore.ts';

import { ChatHistoryError } from './historyError.ts';

import { ChatListPager } from './listPaging.ts';

import { normalizeModelRef, resolveLegacyModel } from './modelRef.ts';

import type { ModelRegistry } from './modelRef.ts';

// Окна свежести скользящие (решение владельца 13): «сутки» — 24 часа, «месяц» —
// 30 суток, без календарной арифметики и часовых поясов.

const FRESH_WINDOWS: Record<string, number> = {
  day: 86400e3,
  week: 7 * 86400e3,
  month: 30 * 86400e3,
};

/**
 * Задача фильтра сравнивается строкой: сохранённый taskId бывает числом и строкой.
 * Пустая строка и null означают «без задачи», режимы any/none проверяют наличие.
 */

function headMatchesTask(head: WebChatHead, task: string): boolean {
  if (!task) {
    return true;
  }

  const id = head.taskId === undefined || head.taskId === null ? '' : String(head.taskId).trim();

  if (task === 'any') {
    return id !== '';
  }

  if (task === 'none') {
    return id === '';
  }

  return id === task;
}

/**
 * Исполнитель берётся из versioned-ссылки, legacy-модель резолвится реестром.
 * Неразрешимая модель не совпадает ни с одним исполнителем, а не с первым попавшимся.
 */

function headMatchesProvider(head: WebChatHead, provider: string, registry: ModelRegistry): boolean {
  if (!provider) {
    return true;
  }

  const ref = normalizeModelRef(head.modelRef);

  if (ref) {
    return ref.provider === provider;
  }

  const resolved = resolveLegacyModel(head.model, registry);

  return resolved.ok && resolved.modelRef.provider === provider;
}

/**
 * Все ответы каталога используют одну последовательность агрегата на процесс.
 * Снимки страниц содержат только id и не удерживают историю сообщений.
 */

export class ChatCatalogPaging {
  private pager = new ChatListPager();
  private epoch = randomUUID();
  private sequence = 0;
  private signature = '';
  private history: ChatHistoryStore;
  private waiting: () => Set<string>;
  private working: () => Set<string>;

  constructor(
    history: ChatHistoryStore,
    waiting: () => Set<string>,
    working: () => Set<string> = () => new Set(),
  ) {
    this.history = history;

    this.waiting = waiting;

    this.working = working;
  }

  /**
   * Сводка охватывает весь каталог, а не только загруженную группу.
   * Порядок sequence исключает возврат старой суммы поздним HTTP-ответом.
   */
  summary(heads: WebChatHead[]) {
    const waiting = this.waiting();

    const signature = heads.map((head) => `${head.id}:${head.version}`).sort().join('|')
      + [...waiting].sort().join('|');

    if (signature !== this.signature) {
      this.signature = signature;

      this.sequence += 1;
    }

    return {
      epoch: this.epoch,
      sequence: this.sequence,
      active: heads.filter((head) => !head.archived).length,
      archived: heads.filter((head) => head.archived).length,
      unread: heads.filter((head) => head.unread).length,
      waiting: waiting.size,
    };
  }

  /**
   * Поиск и фильтры сужают один scope до сортировки и снимка курсора.
   * Top-сверка не выделяет snapshot и не вытесняет курсор читаемого списка.
   */
  async page(
    query: Record<string, string | undefined>,
    top = false,
    snapshot?: WebChatHead[],
  ) {
    const allowed = new Set(['page', 'archived', 'limit', 'q', 'cursor',
      'unread', 'waiting', 'working', 'task', 'provider', 'fresh', 'project']);

    const limit = query.limit === undefined ? 40 : Number(query.limit);

    if (Object.values(query).some((value) => value !== undefined && typeof value !== 'string')
      || Object.keys(query).some((key) => !allowed.has(key))
      || !['0', '1'].includes(query.archived || '0')
      || !/^[0-9]+$/.test(query.limit || '40') || !Number.isSafeInteger(limit)
      || limit < 1 || limit > 100 || (query.q?.length || 0) > 256
      || (query.cursor?.length || 0) > 128 || chatFilterQueryError(query)) {
      throw new ChatHistoryError('bad_chat_page', 'Некорректная страница списка.', { statusCode: 400 });
    }

    const heads = snapshot ?? await this.history.webHeads();

    const summary = this.summary(heads);

    const archived = query.archived === '1';

    const filters = normalizeChatFilters(query);

    const q = (query.q || '').trim();

    const matches = q ? new Map((await this.history.searchWeb(q, archived))
      .map((match) => [match.id, match.snippetSource])) : null;

    const waiting = this.waiting();

    const working = this.working();

    const registry = filters.provider ? await this.history.registry() : {};

    const freshWindow = filters.fresh ? FRESH_WINDOWS[filters.fresh] : 0;

    const freshBefore = freshWindow ? Date.now() - freshWindow : 0;

    const selected: WebChatHead[] = heads.filter((head) => {
      if (!!head.archived !== archived || (matches && !matches.has(head.id))) {
        return false;
      }

      if (filters.project && (filters.project === '@none'
        ? head.catalogProjectId != null : head.catalogProjectId !== filters.project)) {
        return false;
      }

      if (filters.unread && !head.unread) {
        return false;
      }

      if (filters.waiting && !waiting.has(head.id)) {
        return false;
      }

      if (filters.working && !working.has(head.id)) {
        return false;
      }

      if (!headMatchesTask(head, filters.task)
        || !headMatchesProvider(head, filters.provider, registry)) {
        return false;
      }

      if (freshWindow) {
        const ts = Number(archived ? head.closedAt || head.updatedAt || 0 : head.updatedAt || 0);

        if (ts < freshBefore) {
          return false;
        }
      }

      return true;
    })
      .map((head) => ({ ...head, ...(matches ? { snippetSource: matches.get(head.id) } : {}) }));

    selected.sort((a, b) => Number(waiting.has(b.id)) - Number(waiting.has(a.id))
      || Number(archived ? b.closedAt || b.updatedAt || 0 : b.updatedAt || 0)
      - Number(archived ? a.closedAt || a.updatedAt || 0 : a.updatedAt || 0)
      || a.id.localeCompare(b.id));

    const page = top ? { items: selected.slice(0, limit), page: null }
      : this.pager.page(selected, chatPageKey(q, archived, filters), limit, query.cursor || '');

    return {
      listProtocol: 2,
      filtersProtocol: 1,
      projectFiltersProtocol: 1,
      sessions: archived ? [] : page.items,
      archived: archived ? page.items : [],
      page: page.page,
      summary,
    };
  }
}
