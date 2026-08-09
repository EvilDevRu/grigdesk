<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import { hoursToHM, liveTimerSec, secToHMS, signed } from '../shared/format.js';
import { useBoardStore } from '../stores/board.js';
import { useUiStore } from '../stores/ui.js';
import { useAnalysisStore } from '../stores/analysis.js';
import { useTaskFavoritesStore } from '../stores/task-favorites.js';
import { useTaskSeenStore } from '../stores/task-seen.js';
import MiniChart from './board/MiniChart.vue';
import TriageBadge from './board/TriageBadge.vue';
import TaskFavoriteButton from './board/TaskFavoriteButton.vue';
import { api } from '../shared/api-client.js';
import { useSse } from '../composables/useSse.js';
import { boardTaskListResetKey, selectBoardTasks } from '../shared/board-task-list.js';

const ui = useUiStore();

// Данные — из кеш-стора (мгновенный показ при переходе + фоновое обновление).
const board = useBoardStore();
const { data, error, loading } = storeToRefs(board);
const now = ref(Date.now());
const period = ref('day');

const STATUS_COLOR = {
  running: 'var(--accent)', overdue: 'var(--bad)', my_review: 'var(--warn)',
  waiting: 'var(--warn)', deferred: 'var(--idle)', completed: 'var(--good)', done: 'var(--good)',
};
function statusColor(kind) { return STATUS_COLOR[kind] || 'var(--ink-mid)'; }

// Задачи на конвейере фабрики: id → жив ли демон. Точка статуса в списке берёт
// цвет конвейера (зелёный — идёт, оранжевый — стоит/ждёт), как на странице конвейера.
const conveyor = ref(new Map());
async function loadConveyor() {
  try {
    const { tasks } = await api.get('/api/tasks');
    conveyor.value = new Map((tasks || []).map((t) => [String(t.task), !!t.daemonAlive]));
  } catch { /* фабрика недоступна — точки остаются статусными */ }
}
useSse((name) => { if (name === 'state-change') loadConveyor(); });
function dotColor(t) {
  const k = String(t.id);
  if (conveyor.value.has(k)) return conveyor.value.get(k) ? 'var(--good)' : 'var(--warn)';
  return statusColor(t.statusKind);
}
function dotTitle(t) {
  const k = String(t.id);
  if (conveyor.value.has(k)) return conveyor.value.get(k) ? 'На конвейере — идёт' : 'На конвейере — стоит (ждёт/прерван)';
  return t.statusLabel;
}
function projectName(t) {
  return String(t?.group || '').trim();
}
function projectInitial(t) {
  const [initial = ''] = projectName(t).match(/[\p{L}\p{N}]/u) || [];
  return initial.toLocaleUpperCase('ru-RU');
}

// Живой тик таймера: считается от timer_started_at из B24 — см. liveTimerSec.
function liveElapsed(t) {
  return liveTimerSec(t, now.value);
}

// Иконки плиток (Lucide-контуры, stroke=currentColor).
const TILE_ICONS = {
  clock: 'M12 7.5v4.5l3 2 M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  check: 'M21.5 11.1V12a9.5 9.5 0 1 1-5.6-8.7 M22 5 12 15l-3-3',
  gauge: 'M12 13l3.4-3.4 M4.5 17.5a9 9 0 1 1 15 0',
  calendar: 'M8 2.5v3 M16 2.5v3 M3.5 9.5h17 M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 19 20.5H5A1.5 1.5 0 0 1 3.5 19V6A1.5 1.5 0 0 1 5 4.5z',
};
const statTiles = computed(() => {
  const d = data.value; if (!d?.today) return [];
  const dyn = d.dynamics || {};
  const dir = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
  return [
    { key: 'hours', icon: 'clock', tone: 'accent', label: 'Отработано', value: hoursToHM(d.today.hours), delta: signed(dyn.hours, 'ч'), dir: dir(dyn.hours) },
    { key: 'tasks', icon: 'check', tone: 'good', label: 'Выполнено', value: d.today.tasks_count ?? 0, delta: signed(dyn.tasks), dir: dir(dyn.tasks) },
    { key: 'avg', icon: 'gauge', tone: 'warn', label: 'Ср. время', value: hoursToHM(d.today.avg_time), delta: signed(dyn.avg_time, 'ч'), dir: dir(dyn.avg_time) },
  ];
});
const overwork = computed(() => {
  const m = data.value?.month; if (!m?.norm) return 0;
  return Math.max(0, +(m.hours - m.norm).toFixed(1));
});
// Процент выполнения месячной нормы (может быть > 100 при переработке).
const monthPct = computed(() => {
  const m = data.value?.month; if (!m?.norm) return 0;
  return Math.round((m.hours / m.norm) * 100);
});
const activeTask = computed(() => {
  const d = data.value; if (!d?.tasks) return null;
  return d.tasks.find((task) => task.timerRunning) || null;
});
// Поиск по «Моим задачам» (88 штук — без фильтра неудобно).
const q = ref('');

// Триаж: бейджи оценок + сортировка/фильтры по ним. Выбор запоминается.
const analysis = useAnalysisStore();
const favorites = useTaskFavoritesStore();
const favoriteOnly = ref(false);
// Новая задача — та, которую ещё не открывали. Отметки серверные, поэтому до их
// загрузки (и до базовой линии) новых не бывает: см. геттер ready.
const seen = useTaskSeenStore();
const newOnly = ref(false);
const isNewTask = (task) => seen.ready && !seen.isSeen(task.id);
const TRIAGE_LS = 'board.triage';
const saved = JSON.parse(localStorage.getItem(TRIAGE_LS) || '{}');
const sortBy = ref(saved.sortBy || 'b24');   // b24 | risk | complexity | size | fresh
const onlyUnrated = ref(!!saved.onlyUnrated);
const onlyNeedsInfo = ref(!!saved.onlyNeedsInfo);
watch([sortBy, onlyUnrated, onlyNeedsInfo], () => {
  localStorage.setItem(TRIAGE_LS, JSON.stringify({
    sortBy: sortBy.value, onlyUnrated: onlyUnrated.value, onlyNeedsInfo: onlyNeedsInfo.value,
  }));
});
const triageOf = (t) => analysis.byTask[t.id] || null;
// Батч: все задачи без оценки и не в очереди — в триаж по одной (очередь на сервере).
const unrated = computed(() => (data.value?.tasks || []).filter((t) => {
  const r = triageOf(t);
  return !r?.analysis && !['queued', 'running'].includes(r?.status?.state);
}));
async function analyzeAllUnrated() {
  const list = unrated.value;
  if (!list.length) return;
  if (!confirm(`Поставить в очередь триажа ${list.length} задач(и)? Оценки идут последовательно, по несколько минут на задачу.`)) return;
  for (const t of list) {
    try { await analysis.analyze(t.id); } catch { /* очередь дедупит и переживает отказ одной задачи */ }
  }
}

const myTasks = computed(() => {
  return selectBoardTasks({
    tasks: data.value?.tasks || [],
    analysisByTask: analysis.byTask,
    query: q.value,
    sortBy: sortBy.value,
    onlyUnrated: onlyUnrated.value,
    onlyNeedsInfo: onlyNeedsInfo.value,
    favoriteOnly: favoriteOnly.value,
    favoriteTaskIds: favorites.taskIds,
    newOnly: newOnly.value && seen.ready,
    seenTaskIds: seen.taskIds,
  });
});
const currentFavoriteCount = computed(() => {
  const ids = new Set(favorites.taskIds.map(String));
  return (data.value?.tasks || []).filter((task) => ids.has(String(task.id))).length;
});
// Счётчик на кнопке фильтра — по всему списку доски, а не по видимой выборке:
// он отвечает на вопрос «сколько задач я ещё не смотрел», а не «сколько нашлось».
const currentNewCount = computed(() => {
  if (!seen.ready) return 0;
  return (data.value?.tasks || []).filter((task) => !seen.isSeen(task.id)).length;
});
const hasFavoriteMatchesBeforeSearch = computed(() => selectBoardTasks({
  tasks: data.value?.tasks || [],
  analysisByTask: analysis.byTask,
  favoriteOnly: true,
  favoriteTaskIds: favorites.taskIds,
}).length > 0);
const toggleFavorite = (task) => favorites.toggle(task.id);
// Пагинация по скроллу: рисуем первые N, при докрутке до низа добавляем ещё.
const PAGE = 40;
const visibleCount = ref(PAGE);
const visibleTasks = computed(() => myTasks.value.slice(0, visibleCount.value));
const listResetKey = computed(() => boardTaskListResetKey({
  query: q.value,
  onlyUnrated: onlyUnrated.value,
  onlyNeedsInfo: onlyNeedsInfo.value,
  favoriteOnly: favoriteOnly.value,
  newOnly: newOnly.value,
  sortBy: sortBy.value,
  taskCount: data.value?.tasks?.length || 0,
}));
watch(listResetKey, () => { visibleCount.value = PAGE; });
function onTasksScroll(e) {
  const el = e.target;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80 && visibleCount.value < myTasks.value.length) {
    visibleCount.value += PAGE;
  }
}
const chart = computed(() => data.value?.charts?.[period.value] || null);

let ticker = null;
onMounted(() => {
  board.load();
  favorites.load(true);
  seen.load(true);
  analysis.startPolling();
  loadConveyor();
  ticker = setInterval(() => { now.value = Date.now(); }, 1000);
});
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
        <div v-for="s in statTiles" :key="s.key" class="tile" :class="'t-' + s.tone">
          <div class="thead">
            <span class="tico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="TILE_ICONS[s.icon]" /></svg></span>
            <span class="tlabel">{{ s.label }}</span>
          </div>
          <div class="tval">{{ s.value }}</div>
          <div class="tdelta mono" :class="s.dir">
            <span class="darrow">{{ s.dir === 'up' ? '↑' : s.dir === 'down' ? '↓' : '→' }}</span>{{ s.delta }}
            <span class="dvs">vs вчера</span>
          </div>
        </div>
        <div class="tile month t-month">
          <div class="thead">
            <span class="tico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="TILE_ICONS.calendar" /></svg></span>
            <span class="tlabel">За месяц</span>
            <span class="tpct mono" :class="{ over: overwork }">{{ monthPct }}%</span>
          </div>
          <div class="tval">{{ hoursToHM(data.month.hours) }}</div>
          <div class="bar"><span class="fill" :class="{ over: overwork }" :style="{ width: Math.min(100, monthPct) + '%' }"></span></div>
          <div class="mfoot">
            <span class="muted">норма {{ data.month.norm }}ч</span>
            <span v-if="overwork" class="over mono">+{{ overwork }}ч переработки</span>
          </div>
        </div>
      </section>

      <!-- Сейчас в работе -->
      <section v-if="activeTask" class="active">
        <span class="pulse"></span>
        <button class="atitle" @click="ui.openTask(activeTask.id)">{{ activeTask.title }}</button>
        <span class="atimer mono">{{ secToHMS(liveElapsed(activeTask)) }}</span>
      </section>

      <div class="cols" :class="{ solo: !(data.toReview.length || data.created.length) }">
        <!-- Мои задачи — основной блок -->
        <section class="col primary">
          <div class="colhead">
            <h3 class="h big">Мои задачи <span class="cnt">{{ myTasks.length }}</span></h3>
            <div class="tritools">
              <select v-model="sortBy" class="trisort" title="Сортировка по оценкам триажа">
                <option value="b24">порядок B24</option>
                <option value="risk">по риску</option>
                <option value="complexity">по сложности</option>
                <option value="size">по размеру</option>
                <option value="fresh">по свежести оценки</option>
              </select>
              <button class="trif trif-ic favfilter" :class="{ on: favoriteOnly }"
                      :disabled="!favorites.loaded || favorites.loading" :aria-pressed="String(favoriteOnly)"
                      :title="favorites.loaded ? 'Только избранные задачи' : 'Избранное загружается'"
                      @click="favoriteOnly = !favoriteOnly">
                <svg viewBox="0 0 24 24" :fill="favoriteOnly ? 'currentColor' : 'none'"
                     stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
                  <path d="m12 2.7 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z" />
                </svg>
                избранные {{ currentFavoriteCount }}
              </button>
              <!-- «Новых» не бывает без загруженной базовой линии отметок, поэтому кнопка
                   ждёт сервер (seen.ready), а не гадает по пустому набору. -->
              <button class="trif trif-ic newfilter" :class="{ on: newOnly }"
                      :disabled="!seen.ready || seen.loading" :aria-pressed="String(newOnly)"
                      :title="seen.ready ? 'Только новые — те, что ещё не открывали' : 'Отметки просмотра загружаются'"
                      @click="newOnly = !newOnly">
                <svg viewBox="0 0 24 24" :fill="newOnly ? 'currentColor' : 'none'"
                     stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 3.4 14 9l5.6 2-5.6 2-2 5.6-2-5.6L4.4 11 10 9z" />
                </svg>
                новые {{ currentNewCount }}
              </button>
              <button class="trif" :class="{ on: onlyUnrated }" title="Только неоценённые" @click="onlyUnrated = !onlyUnrated; if (onlyUnrated) onlyNeedsInfo = false;">без оценки</button>
              <button class="trif" :class="{ on: onlyNeedsInfo }" title="Триаж просит уточнений" @click="onlyNeedsInfo = !onlyNeedsInfo; if (onlyNeedsInfo) onlyUnrated = false;">уточнить</button>
              <button v-if="unrated.length" class="trif trif-ic" title="Оценить все неоценённые (очередь)" @click="analyzeAllUnrated">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
                {{ unrated.length }}
              </button>
            </div>
            <div class="search">
              <svg class="si" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
              <input v-model="q" placeholder="Поиск по задачам…" />
              <button v-if="q" class="clr" title="Сбросить" @click="q = ''">✕</button>
            </div>
          </div>
          <div v-if="favorites.error" class="faverror" role="alert">
            <span>Избранное: {{ favorites.error }}</span>
            <button type="button" :disabled="favorites.loading" @click="favorites.load(true)">
              {{ favorites.loading ? 'Повторяю…' : 'Повторить' }}
            </button>
          </div>
          <!-- Отказ отметок обязан быть виден: молча он читается как «новых задач нет». -->
          <div v-if="seen.error" class="faverror" role="alert">
            <span>Отметки просмотра: {{ seen.error }}</span>
            <button type="button" :disabled="seen.loading" @click="seen.load(true)">
              {{ seen.loading ? 'Повторяю…' : 'Повторить' }}
            </button>
          </div>
          <ul class="tasks scroller" @scroll="onTasksScroll">
            <li v-for="t in visibleTasks" :key="t.id" class="trow">
              <span class="tstat" :class="{ conv: conveyor.has(String(t.id)) }"
                    :style="{ background: dotColor(t) }" :title="dotTitle(t)"></span>
              <TaskFavoriteButton :active="favorites.isFavorite(t.id)"
                                  :pending="!favorites.loaded || favorites.loading || favorites.isPending(t.id)"
                                  :task-title="t.title" @toggle="toggleFavorite(t)" />
              <span v-if="projectName(t)" class="project-badge" role="img"
                    :aria-label="`Проект: ${projectName(t)}`"
                    :title="`Проект: ${projectName(t)}`">{{ projectInitial(t) }}</span>
              <button class="ttext" @click="ui.openTask(t.id)">{{ t.title }}</button>
              <span v-if="isNewTask(t)" class="newbadge" role="img"
                    aria-label="Новая задача — ещё не открывали"
                    title="Новая задача — ещё не открывали">новая</span>
              <TriageBadge :row="triageOf(t)" />
              <span v-if="t.unread" class="badge" title="непрочитанные">{{ t.unread }}</span>
              <span class="ttime mono muted">{{ secToHMS(liveElapsed(t)) }}</span>
            </li>
            <li v-if="!myTasks.length" class="muted empty">
              <template v-if="favoriteOnly && !hasFavoriteMatchesBeforeSearch">В текущем списке избранных задач нет</template>
              <template v-else-if="favoriteOnly">Избранные задачи не подходят под поиск или фильтры</template>
              <template v-else-if="newOnly && !currentNewCount">Новых задач нет — все просмотрены</template>
              <template v-else-if="newOnly">Новые задачи не подходят под поиск или фильтры</template>
              <template v-else>Ничего не найдено</template>
            </li>
            <li v-else-if="visibleTasks.length < myTasks.length" class="more muted">
              Показано {{ visibleTasks.length }} из {{ myTasks.length }} — прокрути ниже
            </li>
          </ul>
        </section>

        <!-- Контроль / поставленные: блок скрыт, когда обе секции пусты -->
        <section v-if="data.toReview.length || data.created.length" class="col">
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
          <MiniChart title="Часы" kind="hours" :labels="chart.labels" :you="chart.hours" :dept="chart.hours_dept" />
          <MiniChart title="Задачи" kind="count" :labels="chart.labels" :you="chart.tasks" :dept="chart.tasks_dept" />
          <MiniChart title="Ср. время" kind="hours" :labels="chart.labels" :you="chart.avg_time" :dept="chart.avg_time_dept" />
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.board { display: flex; flex-direction: column; gap: 16px; }
.err { color: var(--bad); }
.link { color: var(--accent); margin-left: 8px; }

.stats { display: grid; gap: 12px; grid-template-columns: repeat(2, 1fr); }
@media (min-width: 720px) { .stats { grid-template-columns: repeat(4, 1fr); } }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 14px 16px 15px; display: flex; flex-direction: column; gap: 10px; box-shadow: var(--shadow); }
.thead { display: flex; align-items: center; gap: 9px; }
.tico { width: 27px; height: 27px; border-radius: 8px; display: grid; place-items: center; flex: none; }
.tico svg { width: 15px; height: 15px; }
.t-accent .tico { color: var(--accent); background: color-mix(in srgb, var(--accent) 15%, transparent); }
.t-good .tico { color: var(--good); background: color-mix(in srgb, var(--good) 15%, transparent); }
.t-warn .tico { color: var(--warn); background: color-mix(in srgb, var(--warn) 15%, transparent); }
.t-month .tico { color: var(--ink); background: var(--surface-2); }
.tlabel { font-size: 12px; color: var(--ink-mid); font-weight: 500; }
.tval { font-size: 24px; font-weight: 700; letter-spacing: -.02em; line-height: 1; }
.tdelta { display: inline-flex; align-items: center; gap: 4px; align-self: flex-start;
  font-size: 11px; color: var(--ink-mid); background: var(--surface-2); border-radius: 999px; padding: 3px 9px; }
.tdelta .darrow { font-weight: 700; }
.tdelta .dvs { opacity: .6; }
.tdelta.up { color: var(--good); background: color-mix(in srgb, var(--good) 13%, transparent); }
.tdelta.down { color: var(--ink-mid); }

.tpct { margin-left: auto; font-size: 12px; color: var(--ink-mid); font-weight: 600; }
.tpct.over { color: var(--good); }
.bar { height: 7px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
.bar .fill { display: block; height: 100%; background: var(--good); border-radius: 999px; transition: width .3s; }
.bar .fill.over { background: linear-gradient(90deg, var(--good), var(--accent)); }
.mfoot { display: flex; align-items: center; justify-content: space-between; font-size: 11.5px; }
.mfoot .over { color: var(--good); font-weight: 600; }

.active { display: flex; align-items: center; gap: 10px; background: var(--surface); border: 1px solid var(--accent); border-radius: var(--radius); padding: 12px 14px; }
.pulse { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); flex: none; animation: pulse 1.4s infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
.atitle { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  background: none; border: none; color: var(--ink); text-align: left; padding: 0; cursor: pointer; font-size: 14px; }
.atitle:hover { color: var(--accent); }
.atimer { color: var(--accent); font-size: 15px; }

.cols { display: grid; gap: 18px; grid-template-columns: 1fr; align-items: start; }
@media (min-width: 860px) { .cols { grid-template-columns: 2fr 1fr; } }
/* Правой колонки нет (нечего контролировать/не ставил задач) — задачи на всю ширину */
.cols.solo { grid-template-columns: 1fr; }
.col { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
/* Основной блок «Мои задачи» — в карточке, чтобы визуально доминировал */
.col.primary { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 8px 14px 12px; }
.colhead { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin: 6px 0 4px; }
.h { font-size: 13px; font-weight: 640; margin: 6px 0 2px; display: flex; align-items: center; gap: 8px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-mid); }
.h.big { font-size: 14px; color: var(--ink); }
.cnt { font-size: 11px; color: var(--ink); background: var(--surface-2); border-radius: 999px; padding: 1px 8px; }
/* Тулбар триажа: все контролы одной высоты с поиском (36px) */
.tritools { display: flex; align-items: center; gap: 6px; flex: none; }
.trisort {
  height: 36px; background: var(--ground); border: 1px solid var(--line); border-radius: 9px;
  color: var(--ink-mid); font-size: 12px; padding: 0 8px; outline: none; cursor: pointer;
}
.trisort:focus, .trisort:hover { border-color: var(--accent); color: var(--ink); }
.trif {
  height: 36px; background: var(--ground); border: 1px solid var(--line); border-radius: 9px;
  color: var(--ink-mid); font-size: 12px; padding: 0 11px; cursor: pointer;
}
.trif:hover { color: var(--ink); }
.trif.on { border-color: var(--accent); color: var(--accent); }
.trif:disabled { opacity: .55; cursor: wait; }
.favfilter.on { border-color: var(--warn); color: var(--warn); }
.trif-ic { display: inline-flex; align-items: center; gap: 5px; font-variant-numeric: tabular-nums; }
.trif-ic svg { width: 13px; height: 13px; }
.search { display: flex; align-items: center; gap: 8px; height: 36px; background: var(--ground); border: 1px solid var(--line); border-radius: 9px; padding: 0 11px; flex: 1; max-width: 340px; }
.search:focus-within { border-color: var(--accent); }
.search .si { width: 15px; height: 15px; color: var(--ink-mid); flex: none; }
.search input { background: none; border: none; color: var(--ink); font-size: 14px; flex: 1; min-width: 0; outline: none; }
.search .clr { background: none; border: none; color: var(--ink-mid); cursor: pointer; font-size: 12px; padding: 0 2px; flex: none; }
.search .clr:hover { color: var(--ink); }
.faverror {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  margin: 2px 0 4px; padding: 7px 10px; border: 1px solid color-mix(in srgb, var(--bad) 45%, var(--line));
  border-radius: 8px; color: var(--bad); font-size: 12px;
}
.faverror button {
  border: 0; background: none; color: var(--accent); cursor: pointer; font: inherit; padding: 2px 4px;
}
.faverror button:disabled { opacity: .55; cursor: wait; }
.tasks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.scroller { max-height: min(58vh, 560px); overflow-y: auto; margin: 0 -6px; padding: 0 6px; }
.more { font-size: 12px; text-align: center; padding: 10px 0 4px; }
.trow { display: flex; align-items: center; gap: 11px; padding: 9px 10px; border-radius: 8px; }
.trow > :deep(.favbtn) { margin: -7px -7px -7px -5px; }
.trow:hover { background: var(--surface); }
.trow + .trow { box-shadow: 0 -1px 0 color-mix(in srgb, var(--line) 55%, transparent); }
.tstat { width: 8px; height: 8px; border-radius: 50%; flex: none; box-shadow: 0 0 6px color-mix(in srgb, currentColor 0%, transparent); }
/* Задача на конвейере: точка чуть крупнее и «дышит» — видно с первого взгляда */
.tstat.conv { width: 9px; height: 9px; animation: convpulse 2s ease-in-out infinite; }
@keyframes convpulse { 50% { opacity: .45; } }
.project-badge {
  width: 22px; height: 22px; flex: none; display: inline-grid; place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--line)); border-radius: 50%;
  background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent);
  font-size: 11px; font-weight: 700; line-height: 1; text-transform: uppercase;
}
.ttext { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px;
  background: none; border: none; color: var(--ink); text-align: left; padding: 0; cursor: pointer; }
.ttext:hover { color: var(--accent); }
.badge { font-size: 11px; background: var(--bad); color: #fff; border-radius: 999px; padding: 0 6px; flex: none; }
/* Метка «новая» — того же синего, что и точка новых задач на чипе «Доска» в навигации:
   человек приходит сюда именно с неё, и цвет должен совпасть. */
.newbadge {
  flex: none; font-size: 10.5px; font-weight: 700; line-height: 1.6; letter-spacing: .02em;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--line)); border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); padding: 0 7px;
}
.ttime { font-size: 12px; flex: none; }
.empty { font-size: 13px; padding: 4px 0 8px; }

@media (max-width: 900px) {
  .colhead { flex-wrap: wrap; }
  .search { order: 3; max-width: none; flex-basis: 100%; }
  .tritools { margin-left: auto; flex-wrap: wrap; justify-content: flex-end; }
}

.charts-head { display: flex; align-items: center; justify-content: space-between; }
.periods { display: flex; gap: 4px; }
.periods button { background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-mid); border-radius: 8px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.periods button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.charts-grid { display: grid; gap: 12px; grid-template-columns: 1fr; margin-top: 10px; }
@media (min-width: 720px) { .charts-grid { grid-template-columns: repeat(3, 1fr); } }
</style>
