import { createHash } from 'node:crypto';

import type { ChatWindowBase } from '../../../../shared/chat/chatPaging.ts';
import type { StoredChat } from './historyStore.ts';
import { ChatHistoryError } from './historyError.ts';

/**
 * Полный digest связывает границу с содержимым, включая сохранённые steps.
 * Метаданные разговора не инвалидируют курсор истории.
 */
export function historyPrefixHash(messages: unknown[], end: number): string {
  return createHash('sha256').update(JSON.stringify(messages.slice(0, end))).digest('hex');
}

/**
 * Cursor связывает нижнюю границу с неизменённой верхней частью истории.
 * ACK записи создаёт новое основание, не заставляя окно скачивать сообщения снова.
 */
export function historyWindowCursor(chat: StoredChat, end: number, baseEnd = chat.messages?.length || 0) {
  return end > 0 ? Buffer.from(JSON.stringify({
    id: chat.id,
    end,
    baseEnd,
    hash: historyPrefixHash(chat.messages || [], baseEnd),
    epoch: Number(chat.mobileHistoryEpoch || 0),
  })).toString('base64url') : null;
}

/**
 * Последующая страница принадлежит тому же неизменённому префиксу.
 * Добавление новых сообщений после верхней границы остаётся допустимым.
 */
export function historyWindow(chat: StoredChat, before = '', limit = 40) {
  const messages = chat.messages || [];
  const epoch = Number(chat.mobileHistoryEpoch || 0);
  let end = messages.length;
  let baseEnd = end;

  if (before) {
    let cursor;

    try {
      if (before.length > 768) {
        throw new Error('cursor');
      }

      cursor = JSON.parse(Buffer.from(before, 'base64url').toString('utf8'));

      if (cursor.id !== chat.id || !Number.isSafeInteger(cursor.end) || cursor.end < 0
        || !Number.isSafeInteger(cursor.baseEnd) || cursor.baseEnd < cursor.end
        || typeof cursor.hash !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.hash)) {
        throw new Error('cursor');
      }
    } catch {
      throw new ChatHistoryError('bad_chat_cursor', 'Некорректный курсор истории.', { statusCode: 400 });
    }

    if (cursor.baseEnd > messages.length || cursor.epoch !== epoch
      || historyPrefixHash(messages, cursor.baseEnd) !== cursor.hash) {
      throw new ChatHistoryError('chat_window_changed', 'История изменилась. Обновите её.');
    }

    end = cursor.end;
    baseEnd = cursor.baseEnd;
  }

  let offset = end;
  let bytes = 0;

  while (offset > 0 && end - offset < limit) {
    const size = Buffer.byteLength(JSON.stringify(messages[offset - 1]));

    if (offset < end && bytes + size > 256 * 1024) {
      break;
    }

    bytes += size;
    offset -= 1;
  }

  const baseHash = historyPrefixHash(messages, baseEnd);
  const cursor = historyWindowCursor(chat, offset, baseEnd);

  return {
    chat: { ...chat, messages: messages.slice(offset, end) },
    window: {
      offset,
      end,
      total: messages.length,
      baseEnd,
      baseHash,
      historyEpoch: epoch,
      prefixHash: historyPrefixHash(messages, offset),
      hasOlder: offset > 0,
      before: cursor,
    },
  };
}

/**
 * Проверяется только форма DTO, до входа под общую блокировку записи.
 * Содержимое префикса проверяется заново по свежему файлу внутри saveOne.
 */
export function decodeWindowBase(value: unknown): ChatWindowBase | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const base = value as Record<string, unknown>;

  if (!Number.isSafeInteger(base.offset) || Number(base.offset) < 0
    || typeof base.prefixHash !== 'string' || !/^[a-f0-9]{64}$/.test(base.prefixHash)
    || (base.historyEpoch !== undefined && (!Number.isSafeInteger(base.historyEpoch)
      || Number(base.historyEpoch) < 0))
    || (base.baseEnd !== undefined && (!Number.isSafeInteger(base.baseEnd)
      || Number(base.baseEnd) < Number(base.offset)))
    || (base.baseHash !== undefined && (typeof base.baseHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(base.baseHash)))
    || (base.baseEnd === undefined) !== (base.baseHash === undefined)) {
    return null;
  }

  return base as unknown as ChatWindowBase;
}

/**
 * Невидимый префикс реконструируется из диска под withChatLock.
 * Изменённая база и явная очистка никогда не подменяются частичной лентой.
 */
export function inflateHistoryWindow(
  base: StoredChat | null, incoming: StoredChat, window: ChatWindowBase,
): StoredChat {
  const messages = base?.messages || [];

  if (!base || window.offset > messages.length
    || historyPrefixHash(messages, window.offset) !== window.prefixHash
    || (window.historyEpoch !== undefined && window.historyEpoch !== Number(base.mobileHistoryEpoch || 0))
    || (window.baseEnd !== undefined && (window.baseEnd > messages.length
      || historyPrefixHash(messages, window.baseEnd) !== window.baseHash))) {
    throw new ChatHistoryError('chat_window_changed', 'История изменилась. Повторите загрузку.');
  }

  const { historyWindow: _window, windowRefs: _refs, ...clean } = incoming;

  return { ...clean, messages: [...messages.slice(0, window.offset), ...(incoming.messages || [])] };
}
