import { useAnalysisStore } from '../../stores/analysis.ts';
import { runtimeOf } from './analysisRuntime.ts';
import { loadAnalysis } from './loadAnalysis.ts';

// Пока в очереди есть живые задачи — опрашиваем часто, иначе редко: разбор идёт
// минутами, и держать секундный опрос ради неизменного экрана незачем.
const ACTIVE_INTERVAL_MS = 5000;
const IDLE_INTERVAL_MS = 60000;

/**
 * Гасит опрос. Зовётся и при выключении плагина, и при отказе сервера: молотить
 * закрытый API до конца жизни вкладки нельзя.
 */
export function stopAnalysisPolling(): void {
  const runtime = runtimeOf(useAnalysisStore());

  if (runtime.timer) {
    clearTimeout(runtime.timer);
  }

  runtime.timer = null;
}

/**
 * Ставит следующий опрос. Шаг зависит от состояния очереди, а выключенный плагин
 * гасит цикл целиком: спрашивать выключенный раздел не о чем.
 */
export function scheduleAnalysisPolling(): void {
  const store = useAnalysisStore();

  if (store.disabled) {
    stopAnalysisPolling();

    return;
  }

  const runtime = runtimeOf(store);

  if (runtime.timer) {
    clearTimeout(runtime.timer);
  }

  runtime.timer = setTimeout(
    () => {
      void loadAnalysis();
    },
    store.active ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS,
  );
}

/**
 * Первое чтение и запуск цикла. Повторный вызов при живом таймере ничего не делает:
 * шапка живёт на всех экранах и зовёт запуск при каждом монтировании.
 */
export function startAnalysisPolling(): void {
  const store = useAnalysisStore();

  if (store.disabled || runtimeOf(store).timer) {
    return;
  }

  void loadAnalysis();
}

/**
 * Идёт ли опрос прямо сейчас. Нужно тестам и отладке, а не самому разделу: сам он
 * состояние цикла не показывает.
 */
export function analysisPolling(): boolean {
  return Boolean(runtimeOf(useAnalysisStore()).timer);
}
