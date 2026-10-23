import type { ChatBackgroundTask } from '../../../../shared/chat/chatBackgroundTasks.ts';
import { isRecord } from '../../../../shared/lib/objects.ts';

interface ClaudeTask {
  id: string;
  type: string;
  description: string;
}

// Связи могут прийти до снимка. Ограничение защищает долгоживущий процесс от накопления
// метаданных вызовов, которые вообще не стали фоновыми задачами.
const MAX_PENDING_LINKS = 512;

/**
 * Хранит полный снимок одного CLI и уточняет Monitor по идентификатору инструмента.
 * Событие запуска меняет категорию существующей задачи, но никогда не создаёт задачу.
 */
export function createClaudeBackgroundTasks(onTasks: (tasks: ChatBackgroundTask[]) => void) {
  let tasks: ClaudeTask[] = [];
  let published = '';
  const tools = new Map<string, boolean>();
  const links = new Map<string, string>();

  /**
   * Ранние связи сохраняются в ограниченной очереди до полного снимка.
   * Старейшая запись удаляется, если CLI долго не сообщает состав задач.
   */
  function remember<T>(map: Map<string, T>, id: string, value: T, active: Set<string>): void {
    map.delete(id);
    map.set(id, value);

    const pending = [...map.keys()].filter((key) => !active.has(key));

    if (pending.length > MAX_PENDING_LINKS) {
      map.delete(pending[0]!);
    }
  }

  /**
   * Категория зависит от протокола, а описание остаётся исходным текстом.
   * Связь Monitor уточняет только local_bash, не подменяя другие типы CLI.
   */
  function project(task: ClaudeTask): ChatBackgroundTask {
    let kind: ChatBackgroundTask['kind'] = 'other';

    if (task.type === 'local_agent') {
      kind = 'subagent';
    } else if (task.type === 'monitor_mcp' || task.type === 'monitor_ws') {
      kind = 'monitor';
    } else if (task.type === 'local_bash') {
      kind = tools.get(links.get(task.id) || '') ? 'monitor' : 'command';
    }

    return {
      id: task.id,
      kind,
      description: task.description,
    };
  }

  /**
   * Позднее уточнение отправляет только изменившуюся нейтральную проекцию.
   * Пустой снимок остаётся явным событием очистки даже после завершения хода.
   */
  function publish(): void {
    const projected = tasks.map(project);
    const fingerprint = JSON.stringify(projected);

    if (fingerprint !== published) {
      published = fingerprint;
      onTasks(projected);
    }
  }

  /**
   * Наблюдает кадр до маршрутизации ходов; поглощает только полный снимок задач.
   * Неверный снимок сохраняет прежнее состояние, а неверные элементы пропускаются.
   */
  function observe(value: unknown): boolean {
    if (!isRecord(value)) {
      return false;
    }

    if (value.type === 'system' && value.subtype === 'background_tasks_changed') {
      if (!Array.isArray(value.tasks)) {
        return true;
      }

      const previous = tasks;

      tasks = value.tasks.flatMap((raw): ClaudeTask[] => {
        if (!isRecord(raw) || typeof raw.task_id !== 'string' || !raw.task_id
          || typeof raw.task_type !== 'string' || !raw.task_type
          || raw.ambient === true || raw.awaited === true) {
          return [];
        }

        return [{
          id: raw.task_id,
          type: raw.task_type,
          description: typeof raw.description === 'string' ? raw.description : '',
        }];
      });

      const active = new Set(tasks.map((task) => task.id));

      for (const task of previous) {
        if (!active.has(task.id)) {
          const toolId = links.get(task.id);

          links.delete(task.id);

          if (toolId) {
            tools.delete(toolId);
          }
        }
      }

      publish();

      return true;
    }

    if (value.type === 'assistant' && isRecord(value.message)
      && Array.isArray(value.message.content)) {
      const activeTools = new Set(tasks.map((task) => links.get(task.id) || ''));

      for (const tool of value.message.content) {
        if (isRecord(tool) && tool.type === 'tool_use' && typeof tool.id === 'string'
          && tool.name === 'Monitor') {
          remember(tools, tool.id, true, activeTools);
        }
      }

      if (tasks.length) {
        publish();
      }
    }

    if (value.type === 'system' && value.subtype === 'task_started'
      && typeof value.task_id === 'string' && typeof value.tool_use_id === 'string') {
      const activeTasks = new Set(tasks.map((task) => task.id));

      remember(links, value.task_id, value.tool_use_id, activeTasks);

      if (tasks.length) {
        publish();
      }
    }

    return false;
  }

  function dispose(): void {
    tasks = [];
    tools.clear();
    links.clear();
  }

  return { observe, dispose };
}
