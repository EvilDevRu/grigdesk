import { mdToText } from './md.ts';

const SOURCE_LIMIT = 1024;
const PREVIEW_LIMIT = 240;
const CACHE_LIMIT = 256;

interface PreviewEntry {
  source: string;
  text: string;
}

/**
 * Превью хранит только короткий исходный фрагмент и результат для одного чата.
 * LRU ограничивает память; владелец может удержать весь текущий список без вытеснения по кругу.
 */
export function createChatListPreviewCache(renderText = mdToText) {
  const entries = new Map<string, PreviewEntry>();
  let limit = CACHE_LIMIT;

  return {
    /**
     * Последовательный обход списка больше LRU не должен вытеснять собственное начало.
     * Смена списка освобождает прежние записи, поэтому память ограничена текущими id.
     */
    retain(chatIds: Iterable<string>): void {
      const alive = new Set(chatIds);

      limit = Math.max(CACHE_LIMIT, alive.size);

      for (const id of entries.keys()) {
        if (!alive.has(id)) {
          entries.delete(id);
        }
      }
    },
    /**
     * Попадание обновляет LRU без разбора Markdown; изменение заменяет одну запись.
     * До разбора и после него действуют независимые пределы исходника и результата.
     */
    get(chatId: string, sourceText: string): string {
      const source = String(sourceText || '').slice(0, SOURCE_LIMIT);
      const previous = entries.get(chatId);

      entries.delete(chatId);

      const entry = previous?.source === source ?
        previous :
        {
          source,
          text: renderText(source).slice(0, PREVIEW_LIMIT)
        };

      entries.set(chatId, entry);

      if (entries.size > limit) {
        entries.delete(entries.keys().next().value!);
      }

      return entry.text;
    },
    remove(chatId: string): void {
      entries.delete(chatId);
    },
    clear(): void {
      entries.clear();
      limit = CACHE_LIMIT;
    },
    get size(): number {
      return entries.size;
    },
  };
}
