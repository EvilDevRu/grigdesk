<script setup>
import { ref, computed } from 'vue';
import { hoursToHM } from '../../shared/format.js';

// Компактный линейный график: «Вы» (сплошная) + «Коллеги» (пунктир). SVG, без библиотек.
// Наведение — тултип с чтением конкретного дня; заголовок — последний день С ДАННЫМИ
// (хвост массива = будущие дни месяца с нулями, их брать нельзя).
const props = defineProps({
  title: { type: String, default: '' },
  labels: { type: Array, default: () => [] },
  you: { type: Array, default: () => [] },
  dept: { type: Array, default: () => [] },
  kind: { type: String, default: 'count' }, // 'hours' | 'count'
});

const W = 320;
const H = 90;
const PAD = 6;

const n = computed(() => props.you.length);
const max = computed(() => {
  const all = [...props.you, ...props.dept].map(Number).filter((x) => !Number.isNaN(x));
  return Math.max(1, ...all);
});

function xOf(i) { return n.value === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (n.value - 1); }
function yOf(v) { return H - PAD - ((Number(v) || 0) / max.value) * (H - 2 * PAD); }
function pointsFor(arr) { return arr.map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' '); }

const youPts = computed(() => pointsFor(props.you));
const deptPts = computed(() => pointsFor(props.dept));

const fmt = (v) => (props.kind === 'hours' ? hoursToHM(Number(v) || 0) : String(Math.round(Number(v) || 0)));

// Индекс по умолчанию — последний день, где есть хоть какие-то данные.
const defaultIdx = computed(() => {
  for (let i = n.value - 1; i >= 0; i -= 1) {
    if ((Number(props.you[i]) || 0) > 0 || (Number(props.dept[i]) || 0) > 0) return i;
  }
  return Math.max(0, n.value - 1);
});
const hoverIdx = ref(null);
const activeIdx = computed(() => (hoverIdx.value !== null ? hoverIdx.value : defaultIdx.value));
const headVal = computed(() => fmt(props.you[activeIdx.value]));

const wrap = ref(null);
function onMove(e) {
  if (!n.value || !wrap.value) return;
  const r = wrap.value.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  hoverIdx.value = Math.round(frac * (n.value - 1));
}
function onLeave() { hoverIdx.value = null; }

// Позиции оверлея (направляющая, точки, тултип) в процентах контейнера.
const hx = computed(() => (n.value <= 1 ? 50 : (activeIdx.value / (n.value - 1)) * 100));
const hyYou = computed(() => (yOf(props.you[activeIdx.value]) / H) * 100);
const hyDept = computed(() => (yOf(props.dept[activeIdx.value]) / H) * 100);
const tipLeft = computed(() => Math.min(85, Math.max(15, hx.value)));
</script>

<template>
  <div class="chart">
    <div class="chart-head">
      <span class="title">{{ title }}</span>
      <span class="head-val">
        <b class="val mono">{{ headVal }}</b>
        <span v-if="labels[activeIdx]" class="hday">{{ labels[activeIdx] }}</span>
      </span>
    </div>
    <div ref="wrap" class="plot" @mousemove="onMove" @mouseleave="onLeave">
      <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="svg">
        <line :x1="PAD" :y1="H - PAD" :x2="W - PAD" :y2="H - PAD" class="axis" />
        <polyline v-if="deptPts" :points="deptPts" class="dept" />
        <polyline v-if="youPts" :points="youPts" class="you" />
      </svg>
      <!-- Направляющая + точки (HTML — чтобы не растягивались non-uniform-масштабом SVG) -->
      <div class="guide" :class="{ hot: hoverIdx !== null }" :style="{ left: hx + '%' }"></div>
      <span class="pt dept" :style="{ left: hx + '%', top: hyDept + '%' }"></span>
      <span class="pt you" :style="{ left: hx + '%', top: hyYou + '%' }"></span>
      <!-- Тултип: чтение выбранного дня -->
      <div v-if="hoverIdx !== null" class="tip" :style="{ left: tipLeft + '%' }">
        <div class="tday">{{ labels[activeIdx] }}</div>
        <div class="trow"><span class="tk you">Вы</span><b>{{ fmt(you[activeIdx]) }}</b></div>
        <div class="trow"><span class="tk dept">Коллеги</span><b>{{ fmt(dept[activeIdx]) }}</b></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chart { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; }
.chart-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.title { font-size: 13px; font-weight: 600; }
.head-val { display: inline-flex; align-items: baseline; gap: 7px; min-width: 0; }
.val { font-size: 14px; color: var(--accent); font-weight: 650; }
.hday { font-size: 11px; color: var(--ink-mid); }

.plot { position: relative; height: 90px; }
.svg { width: 100%; height: 90px; display: block; }
.axis { stroke: var(--line); stroke-width: 1; }
.you { fill: none; stroke: var(--accent); stroke-width: 2; vector-effect: non-scaling-stroke; }
.dept { fill: none; stroke: var(--ink-mid); stroke-width: 1.5; stroke-dasharray: 4 3; opacity: .6; vector-effect: non-scaling-stroke; }

.guide { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--line-2);
  transform: translateX(-.5px); opacity: 0; transition: opacity .1s; pointer-events: none; }
.guide.hot { opacity: 1; }
.pt { position: absolute; width: 7px; height: 7px; border-radius: 50%; transform: translate(-50%, -50%);
  pointer-events: none; border: 1.5px solid var(--surface); }
.pt.you { background: var(--accent); }
.pt.dept { background: var(--ink-mid); }

.tip { position: absolute; bottom: calc(100% + 6px); transform: translateX(-50%); z-index: 5;
  background: var(--ground); border: 1px solid var(--line-2); border-radius: 8px; padding: 7px 9px;
  box-shadow: 0 8px 22px #000a; pointer-events: none; white-space: nowrap; min-width: 108px; }
.tday { font-size: 11px; color: var(--ink-mid); margin-bottom: 4px; }
.trow { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12.5px; }
.trow b { font-family: var(--mono); }
.tk { display: inline-flex; align-items: center; gap: 5px; color: var(--ink-mid); }
.tk::before { content: ''; width: 8px; height: 2px; border-radius: 2px; }
.tk.you::before { background: var(--accent); }
.tk.dept::before { background: var(--ink-mid); }
</style>
