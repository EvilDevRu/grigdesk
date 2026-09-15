import { sseSubscribe } from '../../composables/useSse.ts';
import { useUsageForecastStore } from '../../stores/usageForecast.ts';
import { applyUsageForecast, loadUsageForecast } from './loadUsageForecast.ts';

type UsageForecastStore = ReturnType<typeof useUsageForecastStore>;

interface UsageForecastRuntime {
  off: (() => void) | null;
}

// Нереактивная обвязка стора: функция отписки в состоянии Pinia стала бы реактивной,
// а привязка к экземпляру нужна, чтобы свежий стор в тесте начинал с чистой обвязки.
const runtimes = new WeakMap<object, UsageForecastRuntime>();

function runtimeOf(store: UsageForecastStore): UsageForecastRuntime {
  let runtime = runtimes.get(store);

  if (!runtime) {
    runtime = { off: null };
    runtimes.set(store, runtime);
  }

  return runtime;
}

/**
 * Подписка заводится один раз на вкладку: первый снимок читается запросом, дальше
 * его приносит сервер вместе с каждым фоновым тиком лимитов. Повторный вызов —
 * пустая операция, чтобы каждая всплывашка не плодила свою подписку.
 */
export function watchUsageForecast(): void {
  const runtime = runtimeOf(useUsageForecastStore());

  if (runtime.off) {
    return;
  }

  runtime.off = sseSubscribe((name, data) => {
    if (name === 'usage-forecast') {
      applyUsageForecast(data);
    }
  });
  void loadUsageForecast();
}
