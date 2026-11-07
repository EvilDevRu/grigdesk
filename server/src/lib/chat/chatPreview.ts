import type { StoredChat } from './historyStore.ts';

/**
 * Превью вычисляется вместе с кэшированной шапкой, без повторного чтения истории.
 * Только последняя непустая реплика входит в ограниченный текст списка.
 */
export function chatPreview(chat: StoredChat): string {
  const messages = Array.isArray(chat.messages) ? chat.messages : [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const value = typeof message.text === 'string' ? message.text.trim() : '';

    if (value) {
      const prefix = message.role === 'user' ? 'Ты: ' : '';

      return `${prefix}${value.slice(0, 600).replace(/\s+/g, ' ')}`.slice(0, 300);
    }
    if (Array.isArray(message.attachments) && message.attachments.length) {
      return message.role === 'user' ? 'Ты: вложение' : 'Вложение';
    }
  }

  return '';
}
