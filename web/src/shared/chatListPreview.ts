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
 * LRU ограничивает память; поиск по истории выполняется отдельно и не обрезается.
 */
export function createChatListPreviewCache(renderText = mdToText) {
  const entries = new Map<string, PreviewEntry>();

  return {
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

      if (entries.size > CACHE_LIMIT) {
        entries.delete(entries.keys().next().value!);
      }

      return entry.text;
    },
    remove(chatId: string): void {
      entries.delete(chatId);
    },
    clear(): void {
      entries.clear();
    },
    get size(): number {
      return entries.size;
    },
  };
}
