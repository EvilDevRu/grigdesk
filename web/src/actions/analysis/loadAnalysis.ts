import {
  analysisApi,
  analysisDisabledFailure,
  analysisErrorMessage,
} from '../../shared/analysisApi.ts';
import { useAnalysisStore } from '../../stores/analysis.ts';
import { scheduleAnalysisPolling, stopAnalysisPolling } from './pollAnalysis.ts';

/**
 * Сводка триажа для бейджей доски. Временный отказ сети НЕ стирает прошлый снимок:
 * оценки живут на сервере, а исчезнувший с экрана бейдж читался бы как «оценки нет».
 * Выключенный плагин гасит цикл и ошибкой не считается.
 */
export async function loadAnalysis(): Promise<void> {
  const store = useAnalysisStore();

  if (store.disabled) {
    store.setError(null);
    stopAnalysisPolling();

    return;
  }

  try {
    store.setRows(await analysisApi.rows());
  } catch (error) {
    if (analysisDisabledFailure(error)) {
      store.setError(null);
      stopAnalysisPolling();

      return;
    }

    store.setError(analysisErrorMessage(error));
  }

  scheduleAnalysisPolling();
}
