<script setup>
// Предупреждение в топбаре: что требует внимания человека после рестарта
// сервера/ПК (прерванные и упавшие оценки триажа). Авто-перезапуска нет
// намеренно — только ручные действия отсюда. Новые источники проблем
// (не только триаж) подключать сюда же, добавляя их в items.
import { computed, ref } from 'vue';
import { useAnalysisStore } from '../../stores/analysis.js';
import HelpTip from '../ui/HelpTip.vue';

const analysis = useAnalysisStore();
analysis.startPolling(); // идемпотентно: топбар живёт на всех экранах

const busy = ref(null); // task id действия в полёте

const items = computed(() => analysis.issues.map((r) => ({
  task: r.task,
  reason: r.status?.error || (r.status?.state === 'interrupted' ? 'прерван' : 'упал'),
  state: r.status?.state,
})));

async function restart(id) {
  busy.value = id;
  try { await analysis.analyze(id); } finally { busy.value = null; }
}
async function dismiss(id) {
  busy.value = id;
  try { await analysis.dismiss(id); } finally { busy.value = null; }
}
async function restartAll() {
  busy.value = 'all';
  try {
    for (const i of items.value) await analysis.analyze(i.task);
  } finally { busy.value = null; }
}
async function dismissAll() {
  busy.value = 'all';
  try {
    for (const i of items.value) await analysis.dismiss(i.task);
  } finally { busy.value = null; }
}
</script>

<template>
  <!-- Тултип со списком шире стандартного (270px мало — строки липнут к краям) -->
  <HelpTip v-if="items.length" align="right" class="alerts-tip"
           :tip-style="{ maxWidth: '400px', padding: '14px 16px' }">
    <span class="warnchip mono">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
        <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      {{ items.length }}
    </span>
    <template #tip>
      <span class="alerts">
        <span class="ahead">Оценки триажа прерваны — перезапуск только вручную</span>
        <span class="allrow">
          <button v-if="items.length > 1" class="allbtn" :disabled="busy === 'all'" @click="restartAll">
            {{ busy === 'all' ? 'Запускаю…' : `↻ Перезапустить все (${items.length})` }}
          </button>
          <button class="allbtn dim" :disabled="busy === 'all'" @click="dismissAll">✕ Скрыть все</button>
        </span>
        <span class="alist">
          <span v-for="i in items" :key="i.task" class="arow">
            <b class="mono">#{{ i.task }}</b>
            <span class="why">{{ i.reason }}</span>
            <button class="act" :disabled="busy === i.task" title="Перезапустить оценку" @click="restart(i.task)">↻</button>
            <button class="act" :disabled="busy === i.task" title="Скрыть (не перезапускать)" @click="dismiss(i.task)">✕</button>
          </span>
        </span>
      </span>
    </template>
  </HelpTip>
</template>

<style scoped>
.warnchip {
  display: inline-flex; align-items: center; gap: 5px;
  color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent);
  border-radius: 999px; padding: 3px 10px; font-size: 12px; white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.warnchip svg { width: 13px; height: 13px; }
.alerts { display: flex; flex-direction: column; gap: 9px; min-width: 320px; text-align: left; }
/* Длинный список — скроллом, чтобы тултип не вылезал за экран */
.alist { display: flex; flex-direction: column; gap: 6px; max-height: 45vh; overflow-y: auto; padding-right: 4px; margin-right: -6px; }
.ahead { color: var(--warn); font-weight: 600; padding-right: 6px; }
.allrow { display: flex; gap: 8px; flex-wrap: wrap; }
.allbtn.dim { color: var(--ink-mid); }
.allbtn.dim:hover { color: var(--ink); border-color: var(--line-2); }
.arow { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
.arow .why { flex: 1; color: var(--ink-mid); font-size: 12px; }
.act {
  background: var(--surface-2); border: 1px solid var(--line); border-radius: 6px;
  color: var(--ink-mid); width: 24px; height: 24px; cursor: pointer; flex: none;
}
.act:hover { color: var(--ink); border-color: var(--accent); }
.act:disabled { opacity: .5; cursor: default; }
.allbtn {
  background: none; border: 1px solid var(--line); border-radius: 8px; color: var(--accent);
  font-size: 12px; padding: 5px 10px; cursor: pointer; align-self: flex-start;
}
.allbtn:hover { border-color: var(--accent); }
</style>
