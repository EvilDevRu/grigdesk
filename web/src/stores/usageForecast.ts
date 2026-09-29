// Прогноз лимитов исполнителей: снимок с `GET /api/usage-forecast`, который дальше
// обновляет SSE `usage-forecast`. Стор хранит только снимок; запросы и подписка живут
// в операциях раздела (web/src/actions/usageForecast/). Раздел выпиливаемый — см.
// заголовок shared/usageForecastContracts.ts.
import { defineStore } from 'pinia';

import type {
  UsageBarForecast,
  UsageForecastSnapshot,
} from '../../../shared/usageForecastContracts.ts';

export interface UsageForecastState {
  snapshot: UsageForecastSnapshot | null;
  error: string;
}

export const useUsageForecastStore = defineStore('usageForecast', {
  state: (): UsageForecastState => ({
    snapshot: null,
    error: '',
  }),

  getters: {
    // Полосы одного исполнителя — всплывашка показывает только своего.
    barsOf: (state) => (providerId: string): UsageBarForecast[] => (
      (state.snapshot?.bars ?? []).filter((bar) => bar.providerId === providerId)
    ),
  },

  actions: {
    setSnapshot(snapshot: UsageForecastSnapshot): void {
      this.snapshot = snapshot;
      this.error = '';
    },

    setError(message: string): void {
      this.error = message;
    },
  },
});
