import { randomUUID } from 'node:crypto';

import { chatPageKey } from '../../../../shared/chat/chatPaging.ts';
import type { WebChatHead } from '../../../../shared/chat/chatListProjection.ts';
import type { ChatHistoryStore } from './historyStore.ts';
import { ChatHistoryError } from './historyError.ts';
import { ChatListPager } from './listPaging.ts';

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

  constructor(history: ChatHistoryStore, waiting: () => Set<string>) {
    this.history = history;
    this.waiting = waiting;
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
   * Поиск проверяет все файлы scope, но наружу попадает только текущая порция.
   * Top-сверка не выделяет snapshot и не вытесняет курсор читаемого списка.
   */
  async page(query: Record<string, string | undefined>, top = false) {
    const allowed = new Set(['page', 'archived', 'limit', 'q', 'cursor']);
    const limit = query.limit === undefined ? 40 : Number(query.limit);

    if (Object.values(query).some((value) => value !== undefined && typeof value !== 'string')
      || Object.keys(query).some((key) => !allowed.has(key))
      || !['0', '1'].includes(query.archived || '0')
      || !/^[0-9]+$/.test(query.limit || '40') || !Number.isSafeInteger(limit)
      || limit < 1 || limit > 100 || (query.q?.length || 0) > 256
      || (query.cursor?.length || 0) > 128) {
      throw new ChatHistoryError('bad_chat_page', 'Некорректная страница списка.', { statusCode: 400 });
    }

    const heads = await this.history.webHeads();
    const summary = this.summary(heads);
    const archived = query.archived === '1';
    const q = (query.q || '').trim();
    const matches = q ? new Map((await this.history.searchWeb(q, archived))
      .map((match) => [match.id, match.snippetSource])) : null;
    const waiting = this.waiting();
    const selected: WebChatHead[] = heads.filter((head) => (
      !!head.archived === archived && (!matches || matches.has(head.id))
    ))
      .map((head) => ({ ...head, ...(matches ? { snippetSource: matches.get(head.id) } : {}) }));

    selected.sort((a, b) => Number(waiting.has(b.id)) - Number(waiting.has(a.id))
      || Number(archived ? b.closedAt || b.updatedAt || 0 : b.updatedAt || 0)
        - Number(archived ? a.closedAt || a.updatedAt || 0 : a.updatedAt || 0)
      || a.id.localeCompare(b.id));

    const page = top ? { items: selected.slice(0, limit), page: null }
      : this.pager.page(selected, chatPageKey(q, archived), limit, query.cursor || '');

    return {
      listProtocol: 2,
      sessions: archived ? [] : page.items,
      archived: archived ? page.items : [],
      page: page.page,
      summary,
    };
  }
}
