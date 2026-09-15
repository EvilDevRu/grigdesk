// Прогноз лимитов исполнителей: снимок с `GET /api/usage-forecast`, который дальше
// обновляет SSE `usage-forecast`. Стор хранит только снимок; запросы и подписка живут
// в операциях раздела (web/src/actions/usageForecast/). Раздел выпиливаемый — см.
// заголовок shared/usageForecastContracts.ts.
import { defineStore } from 'pinia';

import type {
  ExternalResetSignal,
  ObservedReset,
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

    // Последний сброс окна у исполнителя. Истечение окна по расписанию — штатное дело
    // (5-часовое окно истекает пять раз в сутки), поэтому вперёд идёт сброс чужими или
    // своими руками, и только без таких — последнее истечение. Журнал сервер уже
    // отсортировал от свежего к старому.
    lastResetOf: (state) => (providerId: string): ObservedReset | null => {
      const own = (state.snapshot?.resets ?? []).filter((reset) => reset.providerId === providerId);

      return own.find((reset) => reset.origin !== 'scheduled') ?? own[0] ?? null;
    },

    // Внешний сигнал принадлежит тому исполнителю, которого назвал сам источник.
    externalOf: (state) => (providerId: string): ExternalResetSignal | null => {
      const external = state.snapshot?.external ?? null;

      return external && external.providerId === providerId ? external : null;
    },
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
