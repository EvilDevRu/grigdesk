<template>
  <div class="chart">
    <div class="chart-head">
      <h3 class="title">{{ title }}</h3>
      <span class="head-val">
        <b class="val mono">{{ headVal }}</b>
        <span v-if="labels[activeIdx]" class="hday">{{ labels[activeIdx] }}</span>
      </span>
    </div>
    <div ref="wrap" class="plot" @mousemove="onMove" @mouseleave="onLeave">
      <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="svg">
        <line :x1="PAD" :y1="H - PAD" :x2="W - PAD" :y2="H - PAD" class="axis" />
        <polyline v-for="(row, index) in rows" :key="row.id" :points="row.points"
                  class="series-line" :class="{ secondary: index > 0 }" :style="row.style" />
      </svg>
      <!-- Направляющая и точки не растягиваются вместе с SVG. -->
      <div class="guide" :class="{ hot: hoverIdx !== null }" :style="{ left: hx + '%' }"></div>
      <span v-for="row in rows" :key="row.id" class="pt"
            :style="[row.style, { left: hx + '%', top: pointTop(row.values[activeIdx]) + '%' }]"></span>
      <div v-if="hoverIdx !== null" class="tip" :style="{ left: tipLeft + '%' }">
        <div class="tday">{{ labels[activeIdx] }}</div>
        <div v-for="row in rows" :key="row.id" class="trow">
          <span class="tk" :style="row.style">{{ row.label }}</span>
          <b>{{ fmt(row.values[activeIdx], row.format) }}</b>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';

import type { TrackerChartPeriod, TrackerNumberFormat } from '../../../../shared/trackers/contracts.ts';
import { hoursToHM } from '../../shared/format.ts';

type ChartSeries = Omit<TrackerChartPeriod['series'][number], 'label'> & { label: string };

const props = defineProps<{
  title: string;
  labels: string[];
  series: ChartSeries[];
}>();

const W = 320;
const H = 90;
const PAD = 6;
const colors = ['var(--accent)', 'var(--ink-mid)', 'var(--good)', 'var(--warn)'];

const n = computed(() => props.labels.length);
const max = computed(() => Math.max(1, ...props.series.flatMap((row) => row.values)));
const rows = computed(() => props.series.map((row, index) => ({
  ...row,
  points: pointsFor(row.values),
  style: { '--series-color': colors[index % colors.length] },
})));

function xOf(i: number) {
  return n.value <= 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (n.value - 1);
}

function yOf(value = 0) {
  return H - PAD - (value / max.value) * (H - 2 * PAD);
}

function pointsFor(values: number[]) {
  return values.map((value, index) => `${xOf(index).toFixed(1)},${yOf(value).toFixed(1)}`).join(' ');
}

function pointTop(value = 0) {
  return (yOf(value) / H) * 100;
}

/**
 * Формат объявляется отдельно для каждого ряда и сохраняет дробные значения decimal.
 * Продолжительность приходит в часах и отображается тем же правилом, что KPI виджета.
 */
function fmt(value = 0, format: TrackerNumberFormat = 'count') {
  return format === 'duration' ? hoursToHM(value) : String(format === 'count' ? Math.round(value) : value);
}

// Будущие пустые дни не подменяют последний день с данными ни одного из рядов.
// Заголовок сохраняет значение первого ряда, а подсказка показывает все объявленные ряды.
const defaultIdx = computed(() => {
  for (let index = n.value - 1; index >= 0; index -= 1) {
    if (props.series.some((row) => (row.values[index] ?? 0) > 0)) {
      return index;
    }
  }

  return Math.max(0, n.value - 1);
});

const hoverIdx = ref<number | null>(null);
const activeIdx = computed(() => hoverIdx.value ?? defaultIdx.value);
const headVal = computed(() => {
  const row = props.series[0];

  return row ? fmt(row.values[activeIdx.value], row.format) : '';
});
const hx = computed(() => n.value <= 1 ? 50 : (activeIdx.value / (n.value - 1)) * 100);
const tipLeft = computed(() => Math.min(85, Math.max(15, hx.value)));

const wrap = ref<HTMLElement | null>(null);

/**
 * Положение курсора выбирает общий день для всех рядов виджета.
 * Пустой график и ещё не смонтированный контейнер не меняют выбор.
 */
function onMove(event: MouseEvent) {
  if (!n.value || !wrap.value) {
    return;
  }

  const bounds = wrap.value.getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));

  hoverIdx.value = Math.round(fraction * (n.value - 1));
}

function onLeave() {
  hoverIdx.value = null;
}
</script>

<style scoped>
.chart {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 12px;
}
.chart-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.title { margin: 0; font-size: 13px; font-weight: 600; }
.head-val { display: inline-flex; align-items: baseline; gap: 7px; min-width: 0; }
.val { font-size: 14px; color: var(--accent); font-weight: 650; }
.hday { font-size: 11px; color: var(--ink-mid); }

.plot { position: relative; height: 90px; }
.svg { width: 100%; height: 90px; display: block; }
.axis { stroke: var(--line); stroke-width: 1; }
.series-line {
  fill: none;
  stroke: var(--series-color);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}
.series-line.secondary { stroke-width: 1.5; stroke-dasharray: 4 3; opacity: .6; }
.guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--line-2);
  transform: translateX(-.5px);
  opacity: 0;
  transition: opacity .1s;
  pointer-events: none;
}
.guide.hot { opacity: 1; }
.pt {
  position: absolute;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
  border: 1.5px solid var(--surface);
  background: var(--series-color);
}
.tip {
  position: absolute;
  bottom: calc(100% + 6px);
  transform: translateX(-50%);
  z-index: 5;
  background: var(--ground);
  border: 1px solid var(--line-2);
  border-radius: 8px;
  padding: 7px 9px;
  box-shadow: 0 8px 22px #000a;
  pointer-events: none;
  white-space: nowrap;
  min-width: 108px;
}
.tday { font-size: 11px; color: var(--ink-mid); margin-bottom: 4px; }
.trow { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12.5px; }
.trow b { font-family: var(--mono); }
.tk { display: inline-flex; align-items: center; gap: 5px; color: var(--ink-mid); }
.tk::before { content: ''; width: 8px; height: 2px; border-radius: 2px; background: var(--series-color); }
</style>
