import { computed, isReactive } from 'vue';
import type { ComputedRef } from 'vue';

interface ChatSource {
  id?: string;
  [field: string]: unknown;
}

interface ProjectionOptions {
  active: (chat: ChatSource) => Record<string, unknown>;
  archived: (chat: ChatSource) => Record<string, unknown>;
  fingerprint: (chat: Record<string, unknown>) => string;
  snapshot: (chat: Record<string, unknown>) => Record<string, unknown>;
}

interface PersistenceProjection {
  source: ChatSource;
  archived: boolean;
  fingerprint: ComputedRef<string>;
  snapshot: ComputedRef<string>;
}

/**
 * Проекции одного стора отслеживают все поля записи через Vue, включая вложенные receipt.
 * Неизменённые чаты не сериализуются на каждый debounce; тела steps исключают контрактные helpers.
 */
export function createChatPersistenceProjectionCache(options: ProjectionOptions) {
  const entries = new Map<string | ChatSource, PersistenceProjection>();

  return {
    /**
     * Замена объекта или перенос в архив меняет владельца проекции, мутации отслеживает computed.
     * Нереактивный источник пересчитывается при каждом обращении и не получает ложный cache hit.
     */
    get(source: ChatSource, archived = false): PersistenceProjection {
      const key = source.id || source;
      const previous = entries.get(key);
      const reactive = isReactive(source);

      if (reactive && previous?.source === source && previous.archived === archived) {
        return previous;
      }

      const project = archived ? options.archived : options.active;
      const entry = {
        source,
        archived,
        fingerprint: computed(() => options.fingerprint(project(source))),
        snapshot: computed(() => JSON.stringify(options.snapshot(project(source)))),
      };

      if (reactive) {
        entries.set(key, entry);
      } else {
        entries.delete(key);
      }

      return entry;
    },
    /**
     * Один набор на живой чат: удаление и принятый remote-drop освобождают прежние зависимости.
     * Кэш не удерживает исчезнувшие сессии и не накапливает историю предыдущих снимков.
     */
    prune(sources: ChatSource[]): void {
      const alive = new Set(sources.map((source) => source.id || source));

      for (const key of entries.keys()) {
        if (!alive.has(key)) {
          entries.delete(key);
        }
      }
    },
    remove(id: string): void {
      entries.delete(id);
    },
    clear(): void {
      entries.clear();
    },
    get size(): number {
      return entries.size;
    },
  };
}

/**
 * Снимок сохраняет прежнюю JSON-форму, объединяя уже сериализованные записи без повторного обхода.
 * Метаданные окна сериализуются заново, поэтому activeId и настройки остаются актуальными.
 */
export function stringifyChatStoreSnapshot(
  payload: Record<string, unknown>,
  sessions: string[],
  archived: string[],
): string {
  const { sessions: ignoredSessions, archived: ignoredArchived, ...metadata } = payload;
  const header = JSON.stringify(metadata).slice(0, -1);
  const separator = header.length > 1 ? ',' : '';

  return `${header}${separator}"sessions":[${sessions.join(',')}],"archived":[${archived.join(',')}]}`;
}
