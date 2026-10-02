import { toRaw } from 'vue';

export interface ChatHistorySnapshot {
  id?: string;
  revision?: number;
  messages?: Record<string, unknown>[];
  [field: string]: unknown;
}

/**
 * Копируются JSON-метаданные, включая вложенные proxy receipt и attachments.
 * Тяжёлые steps исключает вызывающий код; здесь нет сериализации всей истории.
 */
function copyMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(copyMetadata);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyMetadata(item)]));
  }

  return value;
}

/**
 * Новая завершённая лента получает собственные массивы и элементы ровно на границе истории.
 * Поздние живые SSE и fallback незавершённого PUT не могут изменить её прежнее тело.
 */
export function ownHistorySteps(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map(copyMetadata) : [];
}

/**
 * Логический снимок запроса отделяет все изменяемые метаданные до первого await.
 * Исторические steps неизменяемы и разделяют raw-ссылки без обхода их элементов.
 */
export function captureChatHistorySnapshot(chat: ChatHistorySnapshot): ChatHistorySnapshot {
  const snapshot: ChatHistorySnapshot = {};

  for (const [field, metadata] of Object.entries(chat)) {
    if (field !== 'messages' || !Array.isArray(chat.messages)) {
      snapshot[field] = copyMetadata(metadata);

      continue;
    }

    snapshot.messages = chat.messages.map((message) => {
      const result: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(message)) {
        result[key] = key === 'steps' && Array.isArray(value) ? toRaw(value) : copyMetadata(value);
      }

      return result;
    });
  }

  return snapshot;
}
