// Нереактивная обвязка операций триажа: таймер поллинга. В состоянии ему не место —
// подписка на сохранение состояния будилась бы собственным таймером, а привязка к
// экземпляру стора нужна, чтобы свежий стор (например, в тесте) начинал с чистой обвязки.
import type { useAnalysisStore } from '../../stores/analysis.ts';

export type AnalysisStore = ReturnType<typeof useAnalysisStore>;

interface AnalysisRuntime {
  timer: ReturnType<typeof setTimeout> | null;
}

const runtimes = new WeakMap<object, AnalysisRuntime>();

/**
 * Обвязка своего экземпляра стора; заводится при первом обращении к нему. Живёт в
 * WeakMap, поэтому вместе со стором исчезает и она — забытый таймер не переживёт свой
 * стор и не начнёт опрашивать сервер в пустоту.
 */
export function runtimeOf(store: AnalysisStore): AnalysisRuntime {
  let runtime = runtimes.get(store);

  if (!runtime) {
    runtime = { timer: null };
    runtimes.set(store, runtime);
  }

  return runtime;
}
