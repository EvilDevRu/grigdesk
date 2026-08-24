<template>
  <span v-if="busy" class="tri busy" :title="state === 'running' ? 'триаж идёт' : 'в очереди триажа'"><span class="dot"></span></span>
  <span v-else-if="state === 'failed' && !a" class="tri chip bad" :title="row?.status?.error || 'триаж упал'">!</span>
  <UiTooltip v-else-if="a" placement="top-end">
    <template #trigger>
      <span class="tri" tabindex="0">
        <span class="chip" :class="tone('cx', a.complexity)">сложн {{ a.complexity }}</span>
        <span class="chip" :class="tone('risk', a.risk)">риск {{ a.risk }}</span>
        <span class="chip dim">{{ a.diff_size }}</span>
        <span v-if="needsInfo" class="chip warn">уточнить</span>
        <svg class="total" :class="`t${total}`" viewBox="0 0 20 20">
          <circle class="trk" cx="10" cy="10" r="8" />
          <circle
            class="arc"
            cx="10"
            cy="10"
            r="8"
            :stroke-dasharray="arc"
            transform="rotate(-90 10 10)"
          />
          <text x="10" y="10.5" text-anchor="middle" dominant-baseline="central">
            {{ total }}
          </text>
        </svg>
      </span>
    </template>
    <template #tip>
      <span class="tipbody">
        <span class="trow"><b>Итог {{ total }}/5</b> — максимум из сложности и риска</span>
        <span class="trow"><b>Сложность {{ a.complexity }}/5</b> — {{ CX_DESC[a.complexity] || '' }}</span>
        <span class="trow"><b>Риск {{ a.risk }}/5</b> — {{ RISK_DESC[a.risk] || '' }}</span>
        <span class="trow"><b>Дифф {{ a.diff_size }}</b> — {{ SIZE_DESC[a.diff_size] || '' }}</span>
        <span class="trow muted">маршрут: {{ a.route_guess }} · уверенность: {{ CONF_RU[a.confidence] || a.confidence }}</span>
        <span v-if="a.summary" class="trow sum clamp">{{ a.summary }}</span>
        <span v-for="q in (a.questions || []).slice(0, 2)" :key="q" class="trow q clamp2">? {{ q }}</span>
        <span v-if="(a.questions || []).length > 2" class="trow muted">…ещё {{ (a.questions || []).length - 2 }} — в карточке задачи</span>
      </span>
    </template>
  </UiTooltip>
</template>

<script setup>
// Бейджи триажа в строке задачи: сложность / риск / размер диффа словами.
// Подробности (расшифровка шкал, резюме, вопросы) — в общем тултипе по ховеру.
// Пока анализ в очереди/идёт — пульсирующая точка; упал — красный «!».
import { computed } from 'vue';
import { UiTooltip } from '../../ui';

const props = defineProps({
  row: { type: Object, default: null }, // { analysis?, status? } из стора analysis
});

const a = computed(() => props.row?.analysis || null);
const state = computed(() => props.row?.status?.state || null);
const busy = computed(() => state.value === 'queued' || state.value === 'running');

// Расшифровки шкал — те же формулировки, что в рубрике промпта триажа.
const CX_DESC = {
  1: 'точечная правка одного файла',
  2: 'несколько файлов в одном слое',
  3: 'сквозная фича по готовым паттернам',
  4: 'новая подсистема или схема данных',
  5: 'много точек интеграции, схема/очереди',
};
const RISK_DESC = {
  1: 'косметика, откат тривиален',
  2: 'ограниченный охват',
  3: 'можно сломать заметный сценарий',
  4: 'массовые данные / деньги',
  5: 'порча данных, необратимо',
};
const SIZE_DESC = { S: 'до 50 строк', M: '50–300 строк', L: '300–1000 строк', XL: 'больше 1000 строк' };
const CONF_RU = { high: 'высокая', medium: 'средняя', low: 'низкая' };

function tone(kind, v) {
  if (kind === 'risk') return v >= 4 ? 'bad' : v === 3 ? 'warn' : 'dim';
  return v >= 4 ? 'warn' : v === 3 ? 'acc' : 'dim';
}
const needsInfo = computed(() => a.value && (a.value.needs_clarification || a.value.confidence === 'low'));
// Итог тяжести задачи — осторожная свёртка: максимум из сложности и риска.
const total = computed(() => (a.value ? Math.max(a.value.complexity || 0, a.value.risk || 0) : 0));
// Кольцо-прогресс: дуга = итог/5 от окружности (r=8 во viewBox 20×20).
const CIRC = 2 * Math.PI * 8;
const arc = computed(() => `${(total.value / 5) * CIRC} ${CIRC}`);
</script>

<style scoped>
.tri { display: inline-flex; gap: 3px; align-items: center; flex: none; }
.chip {
  font-size: 10.5px; line-height: 1;
  padding: 3px 6px; border-radius: 4px; border: 1px solid transparent; white-space: nowrap;
}
.chip.dim { color: var(--ink-mid); border-color: color-mix(in srgb, var(--ink-mid) 30%, transparent); }
.chip.acc { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.chip.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
.chip.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, transparent); }
/* Итог: кольцо-прогресс (дуга = тяжесть/5), цвет по тяжести — как индикатор контекста */
.total { width: 18px; height: 18px; flex: none; }
.total .trk { fill: none; stroke: color-mix(in srgb, var(--ink-mid) 30%, transparent); stroke-width: 2.4; }
.total .arc { fill: none; stroke-width: 2.4; stroke-linecap: round; }
.total text { font-size: 9.5px; font-weight: 700; }
.total.t1 .arc, .total.t2 .arc { stroke: var(--good); }
.total.t1 text, .total.t2 text { fill: var(--good); }
.total.t3 .arc { stroke: var(--warn); }
.total.t3 text { fill: var(--warn); }
.total.t4 .arc, .total.t5 .arc { stroke: var(--bad); }
.total.t4 text, .total.t5 text { fill: var(--bad); }
.busy .dot {
  width: 6px; height: 6px; border-radius: 50%; background: var(--accent);
  display: inline-block; animation: tri-pulse 1.2s ease-in-out infinite;
}
@keyframes tri-pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }

/* Содержимое тултипа: строки с расшифровкой */
.tipbody { display: flex; flex-direction: column; gap: 5px; min-width: 220px; max-width: 300px; text-align: left; }
.trow { display: block; }
.trow.muted { color: var(--ink-mid); }
.trow.sum { border-top: 1px solid var(--line); padding-top: 6px; }
.trow.q { color: var(--warn); }
/* Тултип — обзорный: длинные тексты режем, полная карточка — в модалке задачи */
.clamp, .clamp2 { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; }
.clamp { -webkit-line-clamp: 4; }
.clamp2 { -webkit-line-clamp: 2; }
</style>
