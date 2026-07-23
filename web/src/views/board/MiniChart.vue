<script setup>
import { computed } from 'vue';

// Компактный линейный график: «Вы» (сплошная) + «Коллеги» (пунктир). SVG, без библиотек.
const props = defineProps({
  title: { type: String, default: '' },
  labels: { type: Array, default: () => [] },
  you: { type: Array, default: () => [] },
  dept: { type: Array, default: () => [] },
});

const W = 320;
const H = 90;
const PAD = 6;

const max = computed(() => {
  const all = [...props.you, ...props.dept].map(Number).filter((n) => !Number.isNaN(n));
  return Math.max(1, ...all);
});

function pointsFor(arr) {
  const n = arr.length;
  if (!n) return '';
  return arr.map((v, i) => {
    const x = n === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (n - 1);
    const y = H - PAD - ((Number(v) || 0) / max.value) * (H - 2 * PAD);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

const youPts = computed(() => pointsFor(props.you));
const deptPts = computed(() => pointsFor(props.dept));
const lastYou = computed(() => props.you.length ? props.you[props.you.length - 1] : null);
</script>

<template>
  <div class="chart">
    <div class="chart-head">
      <span class="title">{{ title }}</span>
      <span class="last mono" v-if="lastYou !== null">{{ lastYou }}</span>
    </div>
    <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="svg">
      <line :x1="PAD" :y1="H - PAD" :x2="W - PAD" :y2="H - PAD" class="axis" />
      <polyline v-if="deptPts" :points="deptPts" class="dept" />
      <polyline v-if="youPts" :points="youPts" class="you" />
    </svg>
  </div>
</template>

<style scoped>
.chart { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; }
.chart-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; }
.title { font-size: 13px; font-weight: 600; }
.last { font-size: 13px; color: var(--accent); }
.svg { width: 100%; height: 90px; display: block; }
.axis { stroke: var(--line); stroke-width: 1; }
.you { fill: none; stroke: var(--accent); stroke-width: 2; vector-effect: non-scaling-stroke; }
.dept { fill: none; stroke: var(--ink-mid); stroke-width: 1.5; stroke-dasharray: 4 3; opacity: .6; vector-effect: non-scaling-stroke; }
</style>
