<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import { hoursToHM, secToHMS, signed } from '../shared/format.js';
import { useBoardStore } from '../stores/board.js';
import { useUiStore } from '../stores/ui.js';
import MiniChart from './board/MiniChart.vue';

const ui = useUiStore();

// Данные — из кеш-стора (мгновенный показ при переходе + фоновое обновление).
const board = useBoardStore();
const { data, error, loading, loadedAt } = storeToRefs(board);
const now = ref(Date.now());
const period = ref('day');

const STATUS_COLOR = {
  running: 'var(--accent)', overdue: 'var(--bad)', my_review: 'var(--warn)',
  waiting: 'var(--warn)', deferred: 'var(--idle)', completed: 'var(--good)', done: 'var(--good)',
};
function statusColor(kind) { return STATUS_COLOR[kind] || 'var(--ink-mid)'; }

// Живой тик таймера: timerElapsed уже включает текущую сессию на момент загрузки,
// поэтому добавляем секунды, прошедшие с момента загрузки.
function liveElapsed(t) {
  const extra = t.timerRunning ? (now.value - loadedAt.value) / 1000 : 0;
  return (t.timerElapsed || 0) + extra;
}

const statTiles = computed(() => {
  const d = data.value; if (!d?.today) return [];
  const dyn = d.dynamics || {};
  const dir = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
  return [
    { label: 'Отработано', value: hoursToHM(d.today.hours), delta: signed(dyn.hours, 'ч'), dir: dir(dyn.hours) },
    { label: 'Выполнено', value: d.today.tasks_count ?? 0, delta: signed(dyn.tasks), dir: dir(dyn.tasks) },
    { label: 'Ср. время', value: hoursToHM(d.today.avg_time), delta: signed(dyn.avg_time, 'ч'), dir: dir(dyn.avg_time) },
  ];
});
const overwork = computed(() => {
  const m = data.value?.month; if (!m?.norm) return 0;
  return Math.max(0, +(m.hours - m.norm).toFixed(1));
});
const activeTask = computed(() => {
  const d = data.value; if (!d?.activeTimer) return null;
  return d.tasks.find((t) => t.id === d.activeTimer.task_id) || null;
});
// Поиск по «Моим задачам» (88 штук — без фильтра неудобно).
const q = ref('');
const myTasks = computed(() => {
  const list = data.value?.tasks || [];
  const s = q.value.trim().toLowerCase();
  return s ? list.filter((t) => (t.title || '').toLowerCase().includes(s)) : list;
});
const chart = computed(() => data.value?.charts?.[period.value] || null);

let ticker = null;
onMounted(() => { board.load(); ticker = setInterval(() => { now.value = Date.now(); }, 1000); });
onUnmounted(() => { if (ticker) clearInterval(ticker); });
</script>

<template>
  <div class="board">
    <p v-if="!data && !error" class="muted"><span class="spin"></span> Загрузка доски…</p>
    <div v-else-if="error" class="err">
      Ошибка B24: {{ error }}
      <router-link to="/settings" class="link">→ Настройки</router-link>
    </div>

    <template v-else-if="data">
      <!-- Показатели + месяц -->
      <section class="stats">
        <div v-for="s in statTiles" :key="s.label" class="tile">
          <div class="tval">{{ s.value }}</div>
          <div class="tlabel muted">{{ s.label }}</div>
          <div class="tdelta mono" :class="s.dir">
            <span class="arrow">{{ s.dir === 'up' ? '↑' : s.dir === 'down' ? '↓' : '' }}</span>{{ s.delta }} vs вчера
          </div>
        </div>
        <div class="tile month">
          <div class="tval">{{ hoursToHM(data.month.hours) }}</div>
          <div class="tlabel muted">Отработано за месяц · норма {{ data.month.norm }}ч</div>
          <div class="bar"><span :style="{ width: Math.min(100, (data.month.hours / data.month.norm) * 100) + '%' }"></span></div>
          <div v-if="overwork" class="tdelta over mono">+{{ overwork }}ч переработки</div>
        </div>
      </section>

      <!-- Сейчас в работе -->
      <section v-if="activeTask" class="active">
        <span class="pulse"></span>
        <button class="atitle" @click="ui.openTask(activeTask.id)">{{ activeTask.title }}</button>
        <span class="atimer mono">{{ secToHMS(liveElapsed(activeTask)) }}</span>
      </section>

      <div class="cols">
        <!-- Мои задачи -->
        <section class="col">
          <div class="colhead">
            <h3 class="h">Мои задачи <span class="cnt">{{ myTasks.length }}</span></h3>
            <div class="search">
              <svg class="si" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
              <input v-model="q" placeholder="Поиск…" />
            </div>
          </div>
          <ul class="tasks">
            <li v-for="t in myTasks" :key="t.id" class="trow">
              <span class="tstat" :style="{ background: statusColor(t.statusKind) }" :title="t.statusLabel"></span>
              <button class="ttext" @click="ui.openTask(t.id)">{{ t.title }}</button>
              <span v-if="t.unread" class="badge" title="непрочитанные">{{ t.unread }}</span>
              <span class="ttime mono muted">{{ secToHMS(liveElapsed(t)) }}</span>
            </li>
          </ul>
        </section>

        <!-- Контроль / поставленные -->
        <section class="col">
          <h3 class="h">Ждут моего контроля <span class="cnt">{{ data.toReview.length }}</span></h3>
          <ul class="tasks" v-if="data.toReview.length">
            <li v-for="t in data.toReview" :key="t.id" class="trow">
              <span class="tstat" :style="{ background: statusColor(t.statusKind) }"></span>
              <button class="ttext" @click="ui.openTask(t.id)">{{ t.title }}</button>
            </li>
          </ul>
          <p v-else class="muted empty">Нет задач на контроль</p>

          <h3 class="h">Я поставил задачу <span class="cnt">{{ data.created.length }}</span></h3>
          <ul class="tasks" v-if="data.created.length">
            <li v-for="t in data.created" :key="t.id" class="trow">
              <span class="tstat" :style="{ background: statusColor(t.statusKind) }"></span>
              <button class="ttext" @click="ui.openTask(t.id)">{{ t.title }}</button>
            </li>
          </ul>
          <p v-else class="muted empty">Нет поставленных задач</p>
        </section>
      </div>

      <!-- Статистика -->
      <section v-if="chart" class="charts">
        <div class="charts-head">
          <h3 class="h">Статистика</h3>
          <div class="periods">
            <button v-for="p in ['day','week','month']" :key="p" :class="{ on: period === p }" @click="period = p">
              {{ p === 'day' ? 'Дни' : p === 'week' ? 'Нед' : 'Мес' }}
            </button>
          </div>
        </div>
        <div class="charts-grid">
          <MiniChart title="Часы" :labels="chart.labels" :you="chart.hours" :dept="chart.hours_dept" />
          <MiniChart title="Задачи" :labels="chart.labels" :you="chart.tasks" :dept="chart.tasks_dept" />
          <MiniChart title="Ср. время" :labels="chart.labels" :you="chart.avg_time" :dept="chart.avg_time_dept" />
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.board { display: flex; flex-direction: column; gap: 16px; }
.err { color: var(--bad); }
.link { color: var(--accent); margin-left: 8px; }

.stats { display: grid; gap: 10px; grid-template-columns: repeat(2, 1fr); }
@media (min-width: 720px) { .stats { grid-template-columns: repeat(4, 1fr); } }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 15px 16px; }
.tval { font-size: 21px; font-weight: 680; letter-spacing: -.01em; }
.tlabel { font-size: 12px; margin-top: 2px; }
.tdelta { font-size: 11px; margin-top: 7px; color: var(--ink-mid); }
.tdelta .arrow { margin-right: 3px; font-weight: 700; }
.tdelta.up { color: var(--good); }
.tdelta.down { color: var(--ink-mid); }
.tdelta.over { color: var(--good); }
.bar { height: 6px; background: var(--surface-2); border-radius: 999px; margin-top: 8px; overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--good); }

.active { display: flex; align-items: center; gap: 10px; background: var(--surface); border: 1px solid var(--accent); border-radius: var(--radius); padding: 12px 14px; }
.pulse { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); flex: none; animation: pulse 1.4s infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
.atitle { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  background: none; border: none; color: var(--ink); text-align: left; padding: 0; cursor: pointer; font-size: 14px; }
.atitle:hover { color: var(--accent); }
.atimer { color: var(--accent); font-size: 15px; }

.cols { display: grid; gap: 16px; grid-template-columns: 1fr; }
@media (min-width: 860px) { .cols { grid-template-columns: 1.4fr 1fr; } }
.col { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.colhead { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 6px 0 4px; }
.h { font-size: 13px; font-weight: 640; margin: 6px 0 2px; display: flex; align-items: center; gap: 8px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-mid); }
.cnt { font-size: 11px; color: var(--ink); background: var(--surface-2); border-radius: 999px; padding: 1px 8px; }
.search { display: flex; align-items: center; gap: 6px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 4px 9px; }
.search:focus-within { border-color: var(--accent); }
.search .si { width: 14px; height: 14px; color: var(--ink-mid); flex: none; }
.search input { background: none; border: none; color: var(--ink); font-size: 13px; width: 130px; outline: none; }
.tasks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.trow { display: flex; align-items: center; gap: 11px; padding: 9px 10px; border-radius: 8px; }
.trow:hover { background: var(--surface); }
.trow + .trow { box-shadow: 0 -1px 0 color-mix(in srgb, var(--line) 55%, transparent); }
.tstat { width: 8px; height: 8px; border-radius: 50%; flex: none; box-shadow: 0 0 6px color-mix(in srgb, currentColor 0%, transparent); }
.ttext { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px;
  background: none; border: none; color: var(--ink); text-align: left; padding: 0; cursor: pointer; }
.ttext:hover { color: var(--accent); }
.badge { font-size: 11px; background: var(--bad); color: #fff; border-radius: 999px; padding: 0 6px; flex: none; }
.ttime { font-size: 12px; flex: none; }
.empty { font-size: 13px; padding: 4px 0 8px; }

.charts-head { display: flex; align-items: center; justify-content: space-between; }
.periods { display: flex; gap: 4px; }
.periods button { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid); border-radius: 8px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.periods button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.charts-grid { display: grid; gap: 12px; grid-template-columns: 1fr; margin-top: 10px; }
@media (min-width: 720px) { .charts-grid { grid-template-columns: repeat(3, 1fr); } }
</style>
