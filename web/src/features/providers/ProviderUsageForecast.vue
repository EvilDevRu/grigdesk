<template>
  <span v-if="rows.length" class="usage-forecast" data-context="topbar-popover-forecast">
    <span class="usage-forecast-title">Прогноз</span>
    <span v-for="row in rows" :key="row.key" class="usage-forecast-row">
      <span class="usage-forecast-head">
        <span>{{ row.label }}</span>
        <b class="usage-forecast-value" :class="`is-${row.tone}`">{{ row.value }}</b>
      </span>
      <span v-if="row.sub" class="usage-forecast-sub">
        <span>{{ row.sub.label }}</span>
        <span v-if="row.sub.text" class="usage-forecast-value" :class="`is-${row.sub.tone}`">
          {{ row.sub.text }}
        </span>
      </span>
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { useUsageForecastStore } from '../../stores/usageForecast.ts';
import { watchUsageForecast } from '../../actions/usageForecast/watchUsageForecast.ts';
import {
  barRowOf,
  idleRow,
  type ForecastRow,
} from './usageForecastText.ts';

// Блок прогноза под полосами лимитов одного исполнителя. Раздел выпиливаемый:
// компонент монтируется одной строкой в AppShell и читает только свой стор.
const props = defineProps<{ providerId: string }>();

const store = useUsageForecastStore();

/**
 * Ряды блока: полосы с темпом или один общий «расход стоит».
 * Без единого ряда полос у исполнителя блока нет — так он не появляется там, где
 * лимиты вовсе не окна (Ollama).
 */
const rows = computed<ForecastRow[]>(() => {
  const now = Date.now();
  const bars = store.barsOf(props.providerId);
  const result = bars.map((bar) => barRowOf(bar, now)).filter((row): row is ForecastRow => row !== null);

  if (bars.length && !result.length) {
    result.push(idleRow());
  }

  return result;
});

watchUsageForecast();
</script>

<style scoped>
/* Та же сетка, что у полос всплывашки: подпись слева, значение справа, цифры табличные.
   Длинное значение не рвёт ряд, а уходит на свою строку к правому краю. */
.usage-forecast {
  display: flex; flex-direction: column; gap: 6px;
  padding-top: 7px; border-top: 1px solid var(--line);
  font-size: 11px; line-height: 1.45; color: var(--ink-mid);
}
.usage-forecast-title {
  font-size: 10px; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-low);
}
.usage-forecast-row { display: flex; flex-direction: column; gap: 2px; }
.usage-forecast-head,
.usage-forecast-sub {
  display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline;
  gap: 2px 8px; min-width: 0; overflow-wrap: anywhere;
}
.usage-forecast-head { font-size: 11.5px; }
.usage-forecast-head b { color: var(--ink); }
.usage-forecast-sub { font-size: 10.5px; color: var(--ink-mid); }
.usage-forecast-value { margin-left: auto; text-align: right; font-variant-numeric: tabular-nums; }
.usage-forecast .is-bad { color: var(--bad); }
.usage-forecast .is-warn { color: var(--warn); }
.usage-forecast .is-muted { color: var(--ink-mid); }
</style>
