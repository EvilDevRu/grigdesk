import { isTaskSourceId } from '../../../../shared/tasks/taskReference.ts';
import type { TaskSourceId } from '../../../../shared/tasks/taskReference.ts';
import { resolveTrackerTarget } from '../../shared/trackerTarget.ts';
import { analysisApi } from '../../shared/analysisApi.ts';
import { useAnalysisStore } from '../../stores/analysis.ts';
import { usePluginsStore } from '../../stores/plugins.ts';
import { useTaskShelfStore } from '../../stores/taskShelf.ts';
import { scheduleAnalysisPolling } from './pollAnalysis.ts';
import type { AnalysisQueueResponse } from '../../../../shared/pipeline/analysisContracts.ts';

interface AnalysisPluginsSource {
  enabled(id: string): boolean;
  byId(id: string): { values?: Record<string, unknown> } | null | undefined;
}

/**
 * Задача с оценкой сама ложится на полку: за оценкой человек идёт тогда, когда
 * собирается за неё браться, и следить за ней он всё равно будет. Настройка полки
 * это отключает, а её отказ не отменяет уже принятую очередью оценку.
 */
async function shelveAnalyzed(id: string | number, source: 'b24' | 'tracker' | TaskSourceId): Promise<void> {
  const plugins = usePluginsStore() as unknown as AnalysisPluginsSource;

  if (!plugins.enabled('shelf') || plugins.byId('shelf')?.values?.autoAddOnAnalysis === false) {
    return;
  }

  try {
    const shelf = useTaskShelfStore();
    const branch = isTaskSourceId(source) ? shelf.forSource(source) : shelf;

    await branch.autoAdd(id, { source: 'tracker' });
  } catch {
    /* запуск оценки уже принят */
  }
}

/**
 * Ставит задачу в очередь триажа. Дедуп живёт на сервере: повторное нажатие вернёт
 * already_queued, а не заведёт вторую оценку. Собственные задачи не получают
 * account-scoped меток полки; источник передаёт уже загруженная карточка.
 */
export async function analyzeTask(
  id: string | number,
  { source = 'b24' }: { source?: 'b24' | 'tracker' | TaskSourceId } = {},
): Promise<AnalysisQueueResponse> {
  const store = useAnalysisStore();

  if (store.disabled) {
    store.setError(null);

    return { outcome: 'plugin_disabled', position: null };
  }

  const target = isTaskSourceId(source)
    ? await resolveTrackerTarget(source) : null;
  const result = await analysisApi.enqueue(id, isTaskSourceId(source) ? source : undefined, target?.options);

  store.markQueued(id);

  await shelveAnalyzed(id, source);

  scheduleAnalysisPolling();

  return result;
}
