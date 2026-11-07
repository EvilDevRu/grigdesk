import type { ChatHistoryStore } from './historyStore.ts';
import { PROFILE_RE } from '../profiles.ts';

interface OwnerRow {
  owner: string;
  label: string;
}

/** Ключ принадлежит сохранённому чату, а не аргументам model tool. */
function chatKey(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value) ? value : null;
}

/**
 * Canonical owner использует ту же закрытую форму, что native и server ledger.
 * Ключ чата и trusted project проверяются до выдачи scope инструмента.
 */
export function canonicalChatBrowserOwner(projectId: string | null, key: string): string {
  if (!chatKey(key) || !(projectId === null || PROFILE_RE.test(projectId))) {
    throw new Error('browser_owner_forbidden');
  }

  return JSON.stringify(['chat', projectId, key, null]);
}

/**
 * Проект заново проверяется в рамках каждого catalog refresh/command. null создаёт
 * иной canonical owner; grants прежнего проекта ему не наследуются.
 */
export function createChatBrowserOwnerSource(options: {
  history: Pick<ChatHistoryStore, 'heads' | 'readOne'>;
  trustedProject(taskId: string | null | undefined): Promise<string | null>;
}) {
  /**
   * Свободный чат не получает проект из контекста или рабочей папки.
   * Непустая task identity разрешается только существующим trusted resolver.
   */
  const project = async (taskId: unknown): Promise<string | null> => {
    if (taskId === null || taskId === undefined || taskId === '') {
      return null;
    }

    if (typeof taskId !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(taskId)) {
      throw new Error('browser_owner_forbidden');
    }

    return options.trustedProject(taskId);
  };

  return {
    /**
     * Прямой вызов перечитывает durable запись и её актуальную архивность.
     * Ошибка task/project authority снимает доступ вместо выбора запасного scope.
     */
    async owner(key: string): Promise<string | null> {
      if (!chatKey(key)) {
        return null;
      }

      const record = await options.history.readOne(key);

      if (!record || record.id !== key || record.archived) {
        return null;
      }

      try {
        return canonicalChatBrowserOwner(await project(record.taskId), key);
      } catch {
        return null;
      }
    },
    /**
     * Каталог читает только heads без текста сообщений сохранённых чатов.
     * Trusted project кешируется лишь внутри одного refresh, без переноса полномочий.
     */
    async list(): Promise<OwnerRow[]> {
      const rows: OwnerRow[] = [];
      // Проверки одной задачи объединяются только в рамках текущего refresh.
      // Между вызовами task/project authority не кешируется.
      const projects = new Map<string, Promise<string | null | undefined>>();

      for (const head of await options.history.heads()) {
        const key = chatKey(head.id);

        if (!key || head.archived) {
          continue;
        }

        const taskId = typeof head.taskId === 'string' ? head.taskId : head.taskId == null ? '' : '!';
        let pending = projects.get(taskId);

        if (!pending) {
          pending = project(taskId).catch(() => undefined);
          // undefined означает отказ authority, null — корректный свободный чат.
          // Отказ не превращается в разрешение с другим project scope.
          projects.set(taskId, pending);
        }

        const projectId = await pending;

        if (projectId !== undefined) {
          rows.push({ owner: canonicalChatBrowserOwner(projectId, key), label: `Чат ${key}`.slice(0, 160) });
        }
      }

      return rows;
    },
  };
}
