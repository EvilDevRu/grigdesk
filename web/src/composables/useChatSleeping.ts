import { onMounted, onUnmounted, shallowRef, watch } from 'vue';

import type { ChatBackgroundTask, ChatSleepingSession } from '../../../shared/chat/chatBackgroundTasks.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import { api } from '../shared/apiClient.ts';
import { useSse } from './useSse.ts';

/**
 * Старый сервер без полей сна и повреждённые элементы не обещают пробуждения.
 * Список принимает только нейтральный контракт, без знания исполнителя и его CLI.
 */
function readSleeping(value: unknown): Record<string, ChatSleepingSession> {
  const result: Record<string, ChatSleepingSession> = {};

  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    return result;
  }

  for (const session of value.sessions) {
    if (!isRecord(session) || typeof session.chatKey !== 'string'
      || session.alive !== true || session.sleeping !== true || !Array.isArray(session.backgroundTasks)) {
      continue;
    }

    const tasks = session.backgroundTasks.filter((task): task is ChatBackgroundTask =>
      isRecord(task) && typeof task.id === 'string' && typeof task.description === 'string'
      && ['subagent', 'monitor', 'command', 'other'].includes(String(task.kind)));

    if (tasks.length) {
      result[session.chatKey] = {
        chatKey: session.chatKey,
        alive: true,
        sleeping: true,
        backgroundTasks: tasks,
      };
    }
  }

  return result;
}

/**
 * Каждый список читает серверный сон через общую SSE-шину вкладки.
 * Ревизия отбрасывает устаревший GET, а dirty объединяет события без потери последнего.
 */
export function useChatSleeping() {
  const sessions = shallowRef<Record<string, ChatSleepingSession>>({});
  let active = false;
  let loading = false;
  let dirty = false;
  let revision = 0;
  let controller: AbortController | null = null;
  let disconnected = false;

  /**
   * Запрос имеет собственную отмену и публикует только подтверждённую ревизию.
   * Повтор после invalidation выполняется даже при ошибке предыдущего запроса.
   */
  async function load(): Promise<void> {
    const requestRevision = revision;
    const request = new AbortController();

    loading = true;
    controller = request;

    try {
      const response = await api.get('/api/chat/sessions', { signal: request.signal });

      if (active && !disconnected && requestRevision === revision && !request.signal.aborted) {
        sessions.value = readSleeping(response);
      }
    } catch {
      if (active && requestRevision === revision) {
        sessions.value = {};
      }
    } finally {
      loading = false;
      controller = null;

      if (active && dirty && !disconnected) {
        dirty = false;
        void load();
      }
    }
  }

  /**
   * Любое изменение делает старый снимок неподтверждённым до свежего ответа.
   * Несколько событий во время GET требуют ровно одной следующей перечитки.
   */
  function invalidate(): void {
    revision += 1;
    sessions.value = {};

    if (!active || disconnected) {
      return;
    }

    if (loading) {
      dirty = true;

      return;
    }

    void load();
  }

  const { connected } = useSse((name) => {
    if (name === 'hello' || name === 'chat-sessions') {
      invalidate();
    }
  });

  watch(connected, (online) => {
    if (!online) {
      disconnected = true;
      revision += 1;
      dirty = false;
      sessions.value = {};
      controller?.abort();
    } else if (disconnected) {
      disconnected = false;
      invalidate();
    }
  });

  onMounted(() => {
    active = true;
    invalidate();
  });

  onUnmounted(() => {
    active = false;
    revision += 1;
    dirty = false;
    sessions.value = {};
    controller?.abort();
  });

  return { sessions };
}
