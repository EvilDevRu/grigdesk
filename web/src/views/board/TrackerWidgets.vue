<template>
  <div v-if="widgets.length" class="tracker-widgets">
    <section v-for="widget in kpis" :key="widget.id" class="stats" :aria-label="label(widget.title)">
      <h3>{{ label(widget.title) }}</h3>
      <div v-for="item in widget.items" :key="item.id" class="tile">
        <div :data-stat="item.id" :aria-label="metricLabel(widget.title, item)">
          <span>{{ label(item.label) }}</span>
          <strong class="tval mono">{{ format(item.value, item.format) }}</strong>
        </div>
        <span v-if="item.delta !== undefined">{{ item.delta > 0 ? '+' : '' }}{{ item.delta }}</span>
        <UiProgress v-if="item.progress" :value="item.progress.value" :max="item.progress.max"
                    :label="label(item.label)" />
        <div v-for="secondary in item.secondaryItems" :key="secondary.id">
          {{ label(secondary.label) }} {{ format(secondary.value, secondary.format) }}
        </div>
      </div>
    </section>
    <section v-if="charts.length" class="charts">
      <UiSegmentedControl v-model="period" :label="t('core.trackerPeriod')" :options="periods" />
      <div class="charts-grid">
        <div v-for="widget in charts" :key="widget.id">
          <MiniChart v-if="widget.periods[period]" :title="label(widget.title)"
                     :labels="widget.periods[period]!.labels"
                     :series="chartSeries(widget.periods[period]!)" />
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import type {
  TrackerChartPeriod, TrackerLabel, TrackerNumberFormat, TrackerWidget, TrackerWidgetValue,
} from '../../../../shared/trackers/contracts.ts';
import { hoursToHM } from '../../shared/format.ts';
import { t, resolveUiText, messageRef, UiProgress, UiSegmentedControl } from '../../ui.ts';
import MiniChart from './MiniChart.vue';

const props = defineProps<{ widgets: TrackerWidget[] }>();

const period = ref<'day' | 'week' | 'month'>('day');
const periods = computed(() => [
  { value: 'day', label: t('core.trackerDay') },
  { value: 'week', label: t('core.trackerWeek') },
  { value: 'month', label: t('core.trackerMonth') },
]);
const kpis = computed(() => props.widgets.filter((widget) => widget.kind === 'kpi'));
const charts = computed(() => props.widgets.filter((widget) => widget.kind === 'chart'));

function label(value: TrackerLabel): string {
  return 'text' in value ? value.text : resolveUiText(messageRef(value.key, value.params));
}

function format(value: number, kind: TrackerNumberFormat): string {
  return kind === 'duration' ? hoursToHM(value) : String(value);
}

/**
 * Каждый объявленный ряд сохраняет значения, формат и собственную подпись драйвера.
 * Перевод descriptor выполняется до передачи числовых данных общему графику.
 */
function chartSeries(value: TrackerChartPeriod) {
  return value.series.map((series) => ({ ...series, label: label(series.label) }));
}

/**
 * Доступная подпись объединяет название показателя и его числовое значение.
 * Одинаковое правило работает для любого драйвера, включая прежнюю месячную плитку.
 */
function metricLabel(title: TrackerLabel, item: TrackerWidgetValue): string {
  const text = t('core.trackerMetricLabel', {
    label: label(item.label),
    title: label(title).toLocaleLowerCase(),
    value: format(item.value, item.format),
  });

  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}
</script>

<style scoped>
.tracker-widgets { min-width: 0; }
.stats, .charts-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.stats h3 { grid-column: 1 / -1; }
.tile { min-width: 0; padding: 12px; border: 1px solid var(--line); border-radius: 8px; }
.tval { display: block; font-size: 1.5rem; }
@media (max-width: 400px) {
  .stats, .charts-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
