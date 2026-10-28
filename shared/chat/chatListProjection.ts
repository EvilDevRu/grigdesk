import { stableMessageKey } from './chatMessageIdentity.ts';

type Message = Record<string, unknown>;

export interface WebChatHead extends Record<string, unknown> {
  id: string;
  version: string;
  previewSource: string;
  hasDraft: boolean;
  hasContent: boolean;
  pendingDelivery: boolean;
  lastReply: { key: string; text: string } | null;
}

/**
 * Короткий ключ сохраняет идентичность окончательного ответа во всех путях доставки.
 * Старые сообщения без id используют позицию и digest, не удерживающий текст истории.
 */
export function chatReplyKey(chatId: string, message: Message, index: number): string {
  let digest = 2166136261;

  for (const char of String(message.text || '')) {
    digest = Math.imul(digest ^ char.charCodeAt(0), 16777619);
  }

  return `${chatId}:${stableMessageKey(message) || `legacy:${index}:${digest >>> 0}`}`;
}

/**
 * Web-строка повторяет приоритет черновика, вложений и именно последней реплики.
 * Проекция отделена от mobile и никогда не содержит тела сообщений или вложений.
 */
export function projectWebChatHead(chat: Record<string, unknown>, version: string): WebChatHead {
  const messages = Array.isArray(chat.messages) ? chat.messages as Message[] : [];
  const attachments = Array.isArray(chat.draftAttachments) ? chat.draftAttachments as Message[] : [];
  const draft = String(chat.draft || '');
  const last = messages.at(-1);
  const preview = draft.trim() ? draft : attachments.length
    ? `📎 ${attachments.map((entry) => entry.name).join(', ')}`
    : last ? `${last.role === 'user' ? 'Ты: ' : last.role === 'error' ? '⚠ ' : ''}${last.text || ''}` : '';
  const head: WebChatHead = {
    id: String(chat.id),
    version,
    previewSource: preview.slice(0, 1024),
    hasDraft: !!draft.trim() || attachments.length > 0,
    hasContent: messages.length > 0 || !!draft.trim() || attachments.length > 0,
    pendingDelivery: messages.some((message) => message.delivery === 'sending'),
    lastReply: null,
  };

  for (const key of ['title', 'purpose', 'taskId', 'logicalIdentity', 'model', 'modelRef',
    'unread', 'archived', 'createdAt', 'updatedAt', 'closedAt', 'revision']) {
    if (chat[key] !== undefined) {
      head[key] = chat[key];
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;

    if (message.role !== 'assistant' || (message.kind === 'assistant-block'
      && !message.finalAssistantMessageId && !Array.isArray(message.steps))) {
      continue;
    }

    head.lastReply = {
      key: chatReplyKey(head.id, message, index),
      text: String(message.text || '').slice(0, 120),
    };
    break;
  }

  head.model ??= (chat.modelRef as Message | undefined)?.model || '';

  return head;
}

/**
 * Поиск проверяет полный текст, возвращая прежнее окно вокруг первого совпадения.
 * Пустой фрагмент означает совпадение только названия, null — отсутствие совпадений.
 */
export function chatSearchSnippet(chat: Record<string, unknown>, query: string): string | null {
  const title = String(chat.title || (chat.taskId ? `#${chat.taskId}` : 'Новый чат'));
  const messages = Array.isArray(chat.messages) ? chat.messages as Message[] : [];

  for (const message of messages) {
    const text = String(message.text || '');
    const index = text.toLowerCase().indexOf(query);

    if (index >= 0) {
      return (index > 24 ? '…' : '') + text.slice(Math.max(0, index - 24), index + 72);
    }
  }

  return title.toLowerCase().includes(query) ? '' : null;
}
