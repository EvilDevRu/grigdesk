import { isRecord } from '../../../shared/lib/objects.ts';
import { delayWithAbort } from '../../../shared/lib/delay.ts';
import type { DesktopExitSnapshot } from '../../../shared/desktop/desktopExitContract.ts';

import { t } from '../ui.ts';
import { api } from './apiClient.ts';
import { decodeChatEnvelope } from './chatContracts.ts';

type ChatTitle = { id: string; title?: string };
type Pipeline = DesktopExitSnapshot['pipelines'][number];

export interface PipelineExitResult {
  task: string;
  state: 'pending' | 'stopped' | 'unknown';
}

/**
 * Список задач читается на границе сети без доверия к произвольному JSON.
 * Публичные поля сохраняют тот же допуск Stop, что карточка конвейера.
 */
function taskRows(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value.tasks) || !value.tasks.every(isRecord)) {
    throw new Error(t('desktop.exitActivityUnavailable'));
  }

  return value.tasks;
}

/**
 * Активность читается свежим снимком, очередь объединяется с ходами по chatKey.
 * Загруженные названия не перечитываются; остальные запросы идут параллельно в общем сроке.
 */
export async function inspectDesktopExitActivity(
  sessions: readonly ChatTitle[],
  signal: AbortSignal,
): Promise<DesktopExitSnapshot | { unavailable: true }> {
  const request = {
    signal,
    retry: false,
    timeoutMs: 0,
  };

  try {
    const [activeValue, tasksValue] = await Promise.all([
      api.get('/api/chat/active', request),
      api.get('/api/tasks', request),
    ]);

    if (!isRecord(activeValue) || !Array.isArray(activeValue.active) || !Array.isArray(activeValue.queued)) {
      return { unavailable: true };
    }

    const keys = new Set<string>();

    for (const row of [...activeValue.active, ...activeValue.queued]) {
      if (!isRecord(row) || typeof row.chatKey !== 'string' || !row.chatKey) {
        return { unavailable: true };
      }

      keys.add(row.chatKey);
    }

    const pipelines: Pipeline[] = taskRows(tasksValue)
      .filter((row) => row.daemonAlive === true && !row.readOnly)
      .map((row) => {
        const task = String(row.task);

        if (!/^\d+$/u.test(task)) {
          throw new Error(t('desktop.exitActivityUnavailable'));
        }

        return {
          task,
          title: typeof row.title === 'string' && row.title.trim()
            ? row.title : t('desktop.exitTaskFallback', { task }),
        };
      });
    const chats = await Promise.all([...keys].map(async (chatKey) => {
      let title = sessions.find((chat) => chat.id === chatKey)?.title;

      if (!title?.trim()) {
        try {
          const response = await api.get(`/api/chat/store/chat/${encodeURIComponent(chatKey)}`, request);

          title = decodeChatEnvelope(response).chat?.title;
        } catch {
          // Отказ названия не скрывает известный идущий ход.
        }
      }

      return { chatKey, title: title?.trim() ? title : t('desktop.exitChatFallback', { id: chatKey }) };
    }));

    return { chats, pipelines };
  } catch {
    return { unavailable: true };
  }
}

/**
 * Stop каждой задачи отправляется один раз, затем stop_sent ждёт исчезновения daemonAlive.
 * Ошибка одной задачи не отменяет остальные; общий signal ограничивает все ожидания вместе.
 */
async function stopPipeline(
  pipeline: Pipeline,
  result: PipelineExitResult,
  signal: AbortSignal,
): Promise<void> {
  const request = {
    signal,
    retry: false,
    timeoutMs: 0,
  };

  try {
    const route = `/api/tasks/${encodeURIComponent(pipeline.task)}/stop`;
    const response = await api.post(route, undefined, request);

    if (isRecord(response) && ['stopped', 'not_running'].includes(String(response.outcome))) {
      result.state = 'stopped';

      return;
    }

    if (!isRecord(response) || response.outcome !== 'stop_sent') {
      result.state = 'unknown';

      return;
    }

    while (!signal.aborted) {
      await delayWithAbort(500, signal);

      const rows = taskRows(await api.get('/api/tasks', request));
      const row = rows.find((entry) => String(entry.task) === pipeline.task);

      if (row?.daemonAlive === false) {
        result.state = 'stopped';

        return;
      }
    }
  } catch {
    result.state = 'unknown';
  }
}

/**
 * Один бюджет в двадцать секунд охватывает POST, чтение ответов и опрос всех задач.
 * Даже транспорт, игнорирующий AbortSignal, не удержит завершение renderer-команды.
 */
export async function stopDesktopExitPipelines(
  pipelines: readonly Pipeline[],
  expiresAt: number,
  parent: AbortSignal,
): Promise<PipelineExitResult[]> {
  const controller = new AbortController();
  const results: PipelineExitResult[] = [...new Set(pipelines.map((pipeline) => pipeline.task))]
    .map((task) => ({ task, state: 'pending' }));
  const cancel = () => controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(cancel, Math.max(0, Math.min(20000, expiresAt - Date.now())));
    controller.signal.addEventListener('abort', resolve.bind(null, undefined), { once: true });
  });

  parent.addEventListener('abort', cancel, { once: true });

  if (parent.aborted) {
    controller.abort();
  }

  try {
    const stopping = results.map((result) => stopPipeline(
      { task: result.task, title: '' }, result, controller.signal,
    ));

    await Promise.race([Promise.all(stopping), deadline]);

    return results.map((result) => ({
      task: result.task,
      state: result.state === 'pending' ? 'unknown' : result.state,
    }));
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', cancel);
    controller.abort();
  }
}
