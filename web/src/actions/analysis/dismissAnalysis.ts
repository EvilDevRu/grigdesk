import { analysisApi } from '../../shared/analysisApi.ts';
import { useAnalysisStore } from '../../stores/analysis.ts';
import type { AnalysisQueueResponse } from '../../../../shared/pipeline/analysisContracts.ts';

/**
 * Убирает прерванный или упавший статус с экрана. Сама оценка остаётся: человек решил
 * не перезапускать разбор, а не отказаться от того, что уже посчитано.
 */
export async function dismissAnalysis(id: string | number, source?: string): Promise<AnalysisQueueResponse> {
  const store = useAnalysisStore();

  if (store.disabled) {
    return { outcome: 'plugin_disabled', position: null };
  }

  const result = await analysisApi.dismiss(id, source);

  store.dropStatus(id, source);

  return result;
}
