import { analysisApi } from '../../shared/analysisApi.ts';
import { useAnalysisStore } from '../../stores/analysis.ts';
import type { AnalysisDetail } from '../../../../shared/pipeline/analysisContracts.ts';

/**
 * Полная оценка одной задачи: чипы, разведнота и протухание. Читается каждый раз
 * заново и в кеш доски не кладётся — карточку открывают, чтобы свериться с текущим
 * состоянием, а не с тем, что успело осесть в бейдже.
 */
export async function readAnalysisDetail(id: string | number, source?: string): Promise<AnalysisDetail> {
  const store = useAnalysisStore();

  if (store.disabled) {
    return {
      task: Number(id),
      analysis: null,
      note: null,
      stale: null,
      status: null,
    };
  }

  return analysisApi.detail(id, source);
}
