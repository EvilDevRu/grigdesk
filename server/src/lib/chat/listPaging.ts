import { randomUUID } from 'node:crypto';

import type { WebChatHead } from '../../../../shared/chat/chatListProjection.ts';

interface Snapshot {
  ids: string[];
  scope: string;
  until: number;
}

export class ListPagingError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, statusCode: number) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Снимок хранит порядок id, а страницу строит из свежих шапок.
 * Изменение активности не меняет уже выданную последовательность курсора.
 */
export class ChatListPager {
  private snapshots = new Map<string, Snapshot>();

  constructor(privateNow: () => number = Date.now) {
    this.now = privateNow;
  }

  private now: () => number;

  /**
   * Просроченные и вытесненные снимки дают явный 410 без скрытого reset.
   * Один cursor можно повторять: позиция хранится в запросе, а не мутирует на сервере.
   */
  page(heads: WebChatHead[], scope: string, limit: number, cursor = '') {
    for (const [key, value] of this.snapshots) {
      if (value.until <= this.now()) {
        this.snapshots.delete(key);
      }
    }

    let key: string;
    let offset = 0;
    let snapshot: Snapshot;

    if (cursor) {
      const match = /^([a-f0-9-]{36}):([0-9]{1,10})$/.exec(cursor);

      if (!match) {
        throw new ListPagingError('bad_chat_cursor', 400);
      }

      key = match[1]!;
      offset = Number(match[2]);

      const known = this.snapshots.get(key);

      if (!known) {
        throw new ListPagingError('chat_page_expired', 410);
      }
      if (known.scope !== scope || !Number.isSafeInteger(offset) || offset > known.ids.length) {
        throw new ListPagingError('bad_chat_cursor', 400);
      }

      snapshot = known;
    } else {
      while (this.snapshots.size >= 16) {
        this.snapshots.delete(this.snapshots.keys().next().value!);
      }

      key = randomUUID();
      snapshot = {
        ids: heads.map((head) => head.id),
        scope,
        until: this.now() + 600000
      };
      this.snapshots.set(key, snapshot);
    }

    const current = new Map(heads.map((head) => [head.id, head]));
    const items: WebChatHead[] = [];

    while (offset < snapshot.ids.length && items.length < limit) {
      const head = current.get(snapshot.ids[offset++]!);

      if (head) {
        items.push(head);
      }
    }

    return {
      items,
      page: {
        hasMore: offset < snapshot.ids.length,
        nextCursor: offset < snapshot.ids.length ? `${key}:${offset}` : null,
      },
    };
  }
}
