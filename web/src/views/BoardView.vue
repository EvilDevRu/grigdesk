<template>
  <div class="board">
    <p v-if="!data && !error" class="muted"><UiSpinner decorative /> Загрузка доски…</p>
    <div v-else-if="error" class="err">
      Ошибка B24: {{ error }}
      <router-link to="/settings" class="link">→ Настройки</router-link>
    </div>

    <template v-else-if="data">
      <!-- Показатели + месяц -->
      <section class="stats" aria-label="Учёт времени и выполненные задачи">
        <div v-for="s in statTiles" :key="s.key" class="tile" :class="'t-' + s.tone">
          <div class="thead">
            <span class="tico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="TILE_ICONS[s.icon]" /></svg></span>
            <span class="tlabel">{{ s.label }}</span>
          </div>
          <div class="tval">{{ s.value }}</div>
          <div class="tdelta mono" :class="s.dir">
            <span class="darrow">{{ s.dir === 'up' ? '↑' : s.dir === 'down' ? '↓' : '→' }}</span>{{ s.delta }}
            <span class="dvs">к вчерашнему дню</span>
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

      <!-- B24 разрешает несколько незакрытых таймеров одновременно: показываем каждый. -->
      <section
        v-if="activeTasks.length"
        class="active-timers"
        aria-labelledby="active-timers-title"
      >
        <div class="active-timers-head">
          <span class="active-timers-symbol" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M12 7.5v4.5l3 2 M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" />
            </svg>
            <span class="active-timers-pulse"></span>
          </span>
          <span class="active-timers-heading">
            <h2 id="active-timers-title" class="active-timers-title">Активные таймеры</h2>
            <span class="active-timers-subtitle">Время списывается сейчас</span>
          </span>
          <span
            class="active-timers-count mono"
            :aria-label="`Запущено таймеров: ${activeTasks.length}`"
          >
            {{ activeTasks.length }}
          </span>
        </div>
        <ul class="active-timers-grid">
          <li v-for="task in activeTasks" :key="task.id" class="active-timer-item">
            <UiPressable
              data-context="active-timer-card"
              :title="task.title"
              @click="ui.openTask(task.id)"
            >
              <span class="active-timer-card-head">
                <span class="active-timer-state">
                  <span class="active-timer-dot" aria-hidden="true"></span>
                  таймер идёт
                </span>
                <span class="active-timer-time mono">{{ secToHMS(liveElapsed(task)) }}</span>
              </span>
              <span class="active-task-title">{{ task.title }}</span>
              <span class="active-task-meta">
                <span class="mono">#{{ task.id }}</span>
                <span v-if="projectName(task)" class="active-task-project">
                  {{ projectName(task) }}
                </span>
              </span>
            </UiPressable>
          </li>
        </ul>
      </section>

      <div class="cols" :class="{ solo: !(data.toReview.length || data.created.length) }">
        <!-- Мои задачи — основной блок -->
        <section class="col primary">
          <div class="colhead">
            <h3 class="h big">
              <span class="heading-name">Мои задачи</span>
              <span class="cnt">
                {{ myTasks.length }}<template v-if="hasListFilters"> из {{ data.tasks.length }}</template>
              </span>
            </h3>
            <UiButton
              class="filter-toggle"
              variant="outline"
              :tone="activeFilterCount ? 'accent' : 'neutral'"
              :pressed="Boolean(activeFilterCount)"
              :aria-expanded="String(filtersOpen)"
              aria-controls="board-task-filters"
              @click="filtersOpen = !filtersOpen"
            >
              <template #leading>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M4 5h16l-6.3 7.1v5.4l-3.4 1.7v-7.1z" />
                </svg>
              </template>
              <span>Фильтры</span>
              <span v-if="activeFilterCount" class="filter-count">{{ activeFilterCount }}</span>
            </UiButton>
            <div class="search" role="search">
              <UiSearchInput
                ref="taskSearch"
                v-model="q"
                aria-label="Поиск по задачам"
                placeholder="Номер, название, проект…"
                clear-label="Очистить поиск"
              />
            </div>
          </div>

          <div id="board-task-filters" class="filterbar" :class="{ expanded: filtersOpen }"
               role="region" aria-label="Фильтры задач">
            <label v-if="analysisEnabled" class="filter-section sort-filter">
              <span class="filter-caption">Сортировка</span>
              <UiSelect v-model="sortBy" class="trisort">
                <option value="b24">порядок B24</option>
                <option value="risk">по риску</option>
                <option value="complexity">по сложности</option>
                <option value="size">по размеру</option>
                <option value="fresh">по свежести оценки</option>
              </UiSelect>
            </label>

            <div class="filter-section show-filter" role="group" aria-labelledby="board-show-filter-label">
              <span id="board-show-filter-label" class="filter-caption">Показать</span>
              <UiToggleButton
                v-model="favoriteOnly"
                class="favfilter"
                variant="outline"
                tone="warning"
                :disabled="!favorites.loaded || favorites.loading"
                :title="favorites.loaded ? 'Только избранные задачи' : 'Избранное загружается'"
              >
                <template #leading>
                  <svg
                    viewBox="0 0 24 24"
                    :fill="favoriteOnly ? 'currentColor' : 'none'"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m12 2.7 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z" />
                  </svg>
                </template>
                Избранные {{ currentFavoriteCount }}
              </UiToggleButton>
              <!-- «Новых» не бывает без загруженной базовой линии отметок, поэтому кнопка
                   ждёт сервер (seen.ready), а не гадает по пустому набору. -->
              <UiToggleButton
                v-model="newOnly"
                class="newfilter"
                variant="outline"
                tone="accent"
                :disabled="!seen.ready || seen.loading"
                :title="seen.ready ? 'Только новые — те, что ещё не открывали' : 'Отметки просмотра загружаются'"
              >
                <template #leading>
                  <svg
                    viewBox="0 0 24 24"
                    :fill="newOnly ? 'currentColor' : 'none'"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 3.4 14 9l5.6 2-5.6 2-2 5.6-2-5.6L4.4 11 10 9z" />
                  </svg>
                </template>
                Новые {{ currentNewCount }}
              </UiToggleButton>
            </div>

            <div v-if="analysisEnabled" class="filter-section triage-filter" role="group" aria-labelledby="board-triage-filter-label">
              <span id="board-triage-filter-label" class="filter-caption">Оценка</span>
              <UiSegmentedControl
                v-model="triageMode"
                class="trisegment"
                label="Режим триажа"
                :options="TRIAGE_OPTIONS"
              />
            </div>
            <div v-else class="filter-section triage-disabled">Триаж выключен</div>

            <div class="filter-actions">
              <UiButton
                v-if="hasListFilters || activeFilterCount"
                class="filter-reset"
                variant="text"
                title="Вернуть порядок B24 и показать все задачи"
                @click="resetTaskFilters"
              >
                Сбросить
              </UiButton>
              <div v-if="analysisEnabled && unrated.length" class="batch-actions" role="group"
                   aria-label="Массовые действия с задачами">
                <UiButton
                  class="batch-action triage-all"
                  variant="solid"
                  tone="accent"
                  :aria-label="`Оценить все задачи без оценки: ${unrated.length}`"
                  title="Поставить все задачи без оценки в очередь триажа"
                  @click="analyzeAllUnrated"
                >
                  <template #leading>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12 3.5 14 9l5.5 2-5.5 2-2 5.5-2-5.5L4.5 11 10 9z" />
                    </svg>
                  </template>
                  Оценить все
                  <template #trailing>
                    <span class="batch-count mono" aria-hidden="true">{{ unrated.length }}</span>
                  </template>
                </UiButton>
              </div>
            </div>
          </div>
          <div v-if="favorites.error" class="faverror" role="alert">
            <span>Избранное: {{ favorites.error }}</span>
            <UiButton
              variant="text"
              tone="accent"
              :disabled="favorites.loading"
              @click="favorites.load(true)"
            >
              {{ favorites.loading ? 'Повторяю…' : 'Повторить' }}
            </UiButton>
          </div>
          <!-- Отказ отметок обязан быть виден: молча он читается как «новых задач нет». -->
          <div v-if="seen.error" class="faverror" role="alert">
            <span>Отметки просмотра: {{ seen.error }}</span>
            <UiButton
              variant="text"
              tone="accent"
              :disabled="seen.loading"
              @click="seen.load(true)"
            >
              {{ seen.loading ? 'Повторяю…' : 'Повторить' }}
            </UiButton>
          </div>
          <div class="list-head" :class="{ 'without-analysis': !analysisEnabled }" aria-hidden="true">
            <span class="list-task-label">Задача</span>
            <span v-if="analysisEnabled">Оценка</span>
            <span class="list-time-label">Учтено</span>
          </div>
          <ul ref="taskList" class="tasks scroller" @scroll="onTasksScroll">
            <li v-for="t in visibleTasks" :key="t.id" class="trow"
                :class="{ 'without-analysis': !analysisEnabled }">
              <TaskFavoriteButton :active="favorites.isFavorite(t.id)"
                                  :pending="!favorites.loaded || favorites.loading || favorites.isPending(t.id)"
                                  :task-title="t.title" @toggle="toggleFavorite(t)" />
              <UiPressable
                class="ttext"
                data-role="task-title"
                data-context="board-task"
                @click="ui.openTask(t.id)"
              >
                <span class="task-name">{{ t.title }}</span>
                <span class="task-meta">
                  <span class="mono task-id">#{{ t.id }}</span>
                  <span v-if="projectName(t)" class="task-project">{{ projectName(t) }}</span>
                  <span v-if="taskStateLabel(t)" class="task-state" :class="{ overdue: t.overdue }">
                    <span
                      class="tstat"
                      :class="{
                        conv: conveyor.has(String(t.id)),
                        'on-shelf': shelfEnabled && shelf.isOnShelf(t.id),
                      }"
                      :style="{ background: dotColor(t) }"
                      :title="dotTitle(t)"
                    ></span>
                    {{ taskStateLabel(t) }}
                  </span>
                  <span v-else class="tstat" :class="{ 'on-shelf': shelfEnabled && shelf.isOnShelf(t.id) }"
                        :style="{ background: dotColor(t) }" :title="dotTitle(t)"></span>
                  <span v-if="shelfEnabled && shelf.isOnShelf(t.id)" class="shelf-mark">На полке</span>
                  <span v-if="isNewTask(t)" class="newbadge" role="img"
                        aria-label="Новая задача — ещё не открывали"
                        title="Новая задача — ещё не открывали">Новая</span>
                  <span v-if="t.unread" class="badge" :aria-label="`Непрочитанных сообщений: ${t.unread}`">
                    {{ t.unread }} сообщ.
                  </span>
                </span>
              </UiPressable>
              <div v-if="analysisEnabled" class="task-triage"><TriageBadge :row="triageOf(t)" /></div>
              <span class="ttime" :class="{ running: t.timerRunning }">
                <span class="mono">{{ secToHMS(liveElapsed(t)) }}</span>
                <span v-if="t.timerRunning" class="time-state">Идёт учёт</span>
              </span>
            </li>
            <li v-if="!myTasks.length" class="muted empty">
              <template v-if="favoriteOnly && !hasFavoriteMatchesBeforeSearch">В текущем списке избранных задач нет</template>
              <template v-else-if="favoriteOnly">Избранные задачи не подходят под поиск или фильтры</template>
              <template v-else-if="newOnly && !currentNewCount">Новых задач нет — все просмотрены</template>
              <template v-else-if="newOnly">Новые задачи не подходят под поиск или фильтры</template>
              <template v-else>Ничего не найдено</template>
            </li>
            <li v-else-if="visibleTasks.length < myTasks.length" class="more muted">
              <span>Показано {{ visibleTasks.length }} из {{ myTasks.length }}</span>
              <UiButton data-role="board-load-more" variant="text" @click="showMoreTasks">
                Показать ещё
              </UiButton>
            </li>
          </ul>
        </section>

        <!-- Контроль / поставленные: блок скрыт, когда обе секции пусты -->
        <section v-if="data.toReview.length || data.created.length" class="col secondary">
          <h3 class="h big">Контроль и поручения</h3>
          <UiTabs v-model="secondaryMode" class="secondary-tabs" label="Связанные задачи">
            <UiTab id="board-review-tab" data-context="board-related-tab"
                   value="review" controls="board-related-list">
              Контроль <span class="cnt">{{ data.toReview.length }}</span>
            </UiTab>
            <UiTab id="board-created-tab" data-context="board-related-tab"
                   value="created" controls="board-related-list">
              Поручения <span class="cnt">{{ data.created.length }}</span>
            </UiTab>
          </UiTabs>
          <UiSearchInput
            v-model="secondaryQuery"
            aria-label="Поиск по связанным задачам"
            placeholder="Поиск в этом списке…"
            clear-label="Очистить поиск связанных задач"
          />
          <div class="secondary-summary">
            <span>{{ secondaryMode === 'review' ? 'Ждут моего контроля' : 'Я поставил задачу' }}</span>
            <span v-if="secondaryQuery.trim()">{{ relatedTasks.length }} из {{ relatedSource.length }}</span>
          </div>
          <div
            id="board-related-list"
            class="related-panel"
            role="tabpanel"
            :aria-labelledby="secondaryMode === 'review' ? 'board-review-tab' : 'board-created-tab'"
          >
            <ul ref="relatedList" class="tasks related-list">
              <li v-for="t in relatedTasks" :key="t.id" class="related-row">
                <UiPressable
                  class="ttext"
                  data-role="task-title"
                  data-context="board-task"
                  @click="ui.openTask(t.id)"
                >
                  <span class="task-name">{{ t.title }}</span>
                  <span class="task-meta">
                    <span class="mono task-id">#{{ t.id }}</span>
                    <span v-if="projectName(t)" class="task-project">{{ projectName(t) }}</span>
                    <span v-if="t.responsible" class="task-responsible">{{ t.responsible }}</span>
                    <span v-if="taskStateLabel(t)" class="task-state" :class="{ overdue: t.overdue }">
                      <span class="tstat" :style="{ background: dotColor(t) }"></span>
                      {{ taskStateLabel(t) }}
                    </span>
                  </span>
                </UiPressable>
              </li>
              <li v-if="!relatedTasks.length" class="muted empty">
                {{ secondaryQuery.trim() ? 'Ничего не найдено' : 'В этом списке пока нет задач' }}
              </li>
            </ul>
          </div>
        </section>
      </div>

      <!-- Статистика -->
      <section v-if="chart" class="charts">
        <div class="charts-head">
          <h3 class="h">Статистика</h3>
          <UiSegmentedControl
            v-model="period"
            class="periods"
            label="Период статистики"
            :options="PERIOD_OPTIONS"
          />
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

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import { hoursToHM, liveTimerSec, secToHMS, signed } from '../shared/format.ts';
import { useBoardStore } from '../stores/board.js';
import { useUiStore } from '../stores/ui.js';
import { analyzeTask, startAnalysisPolling, useAnalysisStore } from '../actions/analysis';
import { useTaskFavoritesStore } from '../stores/task-favorites.js';
import { useTaskShelfStore } from '../stores/taskShelf.ts';
import { usePluginsStore } from '../stores/plugins.js';
import { useTaskSeenStore } from '../stores/task-seen.js';
import MiniChart from './board/MiniChart.vue';
import TriageBadge from './board/TriageBadge.vue';
import TaskFavoriteButton from './board/TaskFavoriteButton.vue';
import { api } from '../shared/apiClient.ts';
import { useSse } from '../composables/useSse.ts';
import { boardTaskListResetKey, matchesBoardTask, selectBoardTasks } from '../shared/board-task-list.js';
import {
  confirmDialog,
  UiButton,
  UiPressable,
  UiSearchInput,
  UiSegmentedControl,
  UiSelect,
  UiSpinner,
  UiTab,
  UiTabs,
  UiToggleButton,
} from '../ui';

const ui = useUiStore();

// Данные — из кеш-стора (мгновенный показ при переходе + фоновое обновление).
const board = useBoardStore();
const { data, error, loading } = storeToRefs(board);
const now = ref(Date.now());
const period = ref('day');
const PERIOD_OPTIONS = [
  { value: 'day', label: 'Дни' },
  { value: 'week', label: 'Нед' },
  { value: 'month', label: 'Мес' },
];

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
function taskStateLabel(task) {
  const id = String(task.id);

  if (conveyor.value.has(id)) {
    return conveyor.value.get(id) ? 'Конвейер идёт' : 'Конвейер остановлен';
  }

  return task.overdue ? 'Просрочена' : task.statusLabel || '';
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
  const d = data.value;

  if (!d?.today) {
    return [];
  }

  const dyn = d.dynamics || {};
  const dir = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');

  return [
    {
      key: 'hours',
      icon: 'clock',
      tone: 'accent',
      label: 'Отработано сегодня',
      value: hoursToHM(d.today.hours),
      delta: signed(dyn.hours, 'ч'),
      dir: dir(dyn.hours),
    },
    {
      key: 'tasks',
      icon: 'check',
      tone: 'good',
      label: 'Выполнено сегодня',
      value: d.today.tasks_count ?? 0,
      delta: signed(dyn.tasks),
      dir: dir(dyn.tasks),
    },
    {
      key: 'avg',
      icon: 'gauge',
      tone: 'warn',
      label: 'Среднее на задачу',
      value: hoursToHM(d.today.avg_time),
      delta: signed(dyn.avg_time, 'ч'),
      dir: dir(dyn.avg_time),
    },
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
const activeTasks = computed(() => (data.value?.tasks || []).filter((task) => task.timerRunning));
// Поиск основного списка независим от поиска контроля и поручений.
const q = ref('');
const taskSearch = ref(null);
const taskList = ref(null);
const secondaryQuery = ref('');
const secondaryMode = ref(null);
const relatedList = ref(null);
const relatedSource = computed(() => secondaryMode.value === 'created'
  ? data.value?.created || []
  : data.value?.toReview || []);
const relatedTasks = computed(() => relatedSource.value
  .filter((task) => matchesBoardTask(task, secondaryQuery.value)));

// При первом ответе открываем непустой список. Дальше выбор принадлежит человеку,
// даже если после обновления в выбранном разделе больше нет задач.
watch(() => [data.value?.toReview.length || 0, data.value?.created.length || 0], ([review, created]) => {
  if (secondaryMode.value === null && (review || created)) {
    secondaryMode.value = review ? 'review' : 'created';
  }
}, { immediate: true });
watch([secondaryMode, secondaryQuery], () => {
  if (relatedList.value) {
    relatedList.value.scrollTop = 0;
  }
});

// Триаж: бейджи оценок + сортировка/фильтры по ним. Выбор запоминается.
const analysis = useAnalysisStore();
const favorites = useTaskFavoritesStore();
const shelf = useTaskShelfStore();
const plugins = usePluginsStore();
const shelfEnabled = computed(() => plugins.enabled('shelf'));
const analysisEnabled = computed(() => {
  const manifest = plugins.byId('analysis');
  return manifest ? manifest.enabled !== false : true;
});
const favoriteOnly = ref(false);
const filtersOpen = ref(false);
// Новая задача — та, которую ещё не открывали. Отметки серверные, поэтому до их
// загрузки (и до базовой линии) новых не бывает: см. геттер ready.
const seen = useTaskSeenStore();
const newOnly = ref(false);
const isNewTask = (task) => seen.ready && !seen.isSeen(task.id);
const TRIAGE_LS = 'board.triage';
const SORT_MODES = new Set(['b24', 'risk', 'complexity', 'size', 'fresh']);
const TRIAGE_OPTIONS = [
  { value: 'all', label: 'Все' },
  { value: 'unrated', label: 'Без оценки' },
  { value: 'needs-info', label: 'Нужны уточнения' },
];
function readTriagePrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(TRIAGE_LS) || '{}');
    return {
      sortBy: SORT_MODES.has(saved?.sortBy) ? saved.sortBy : 'b24',
      // Один режим вместо двух независимых флагов: повреждённое старое значение
      // больше не может одновременно включить «без оценки» и «нужны уточнения».
      triageMode: saved?.onlyUnrated ? 'unrated' : saved?.onlyNeedsInfo ? 'needs-info' : 'all',
    };
  } catch {
    return { sortBy: 'b24', triageMode: 'all' };
  }
}
const savedTriage = readTriagePrefs();
const sortBy = ref(savedTriage.sortBy);   // b24 | risk | complexity | size | fresh
const triageMode = ref(savedTriage.triageMode); // all | unrated | needs-info
const onlyUnrated = computed(() => triageMode.value === 'unrated');
const onlyNeedsInfo = computed(() => triageMode.value === 'needs-info');
watch([sortBy, triageMode], () => {
  try {
    localStorage.setItem(TRIAGE_LS, JSON.stringify({
      sortBy: sortBy.value,
      onlyUnrated: onlyUnrated.value,
      onlyNeedsInfo: onlyNeedsInfo.value,
    }));
  } catch { /* приватный режим/запрет хранилища не должен ронять доску */ }
});
const triageOf = (t) => analysis.byTask[t.id] || null;
// Батч: все задачи без оценки и не в очереди — в триаж по одной (очередь на сервере).
const unrated = computed(() => (data.value?.tasks || []).filter((t) => {
  if (!analysisEnabled.value) return false;
  const r = triageOf(t);
  return !r?.analysis && !['queued', 'running'].includes(r?.status?.state);
}));
async function analyzeAllUnrated() {
  const list = unrated.value;
  if (!list.length) return;
  if (!(await confirmDialog(
    `Поставить в очередь триажа ${list.length} задач(и)? Оценки идут последовательно, по несколько минут на задачу.`,
    { title: 'Оценить все задачи без оценки', okText: 'Поставить в очередь' },
  ))) return;
  for (const t of list) {
    try { await analyzeTask(t.id); } catch { /* очередь дедупит и переживает отказ одной задачи */ }
  }
}

const myTasks = computed(() => {
  return selectBoardTasks({
    tasks: data.value?.tasks || [],
    analysisByTask: analysis.byTask,
    query: q.value,
    sortBy: analysisEnabled.value ? sortBy.value : 'b24',
    onlyUnrated: analysisEnabled.value && onlyUnrated.value,
    onlyNeedsInfo: analysisEnabled.value && onlyNeedsInfo.value,
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
const activeFilterCount = computed(() => [
  analysisEnabled.value && sortBy.value !== 'b24',
  favoriteOnly.value,
  newOnly.value,
  analysisEnabled.value && triageMode.value !== 'all',
].filter(Boolean).length);
const hasListFilters = computed(() => !!q.value.trim()
  || favoriteOnly.value || newOnly.value
  || (analysisEnabled.value && triageMode.value !== 'all'));

/**
 * Возвращает исходный список и фокус в поиск после исчезновения кнопки сброса.
 * Сортировка и личные фильтры сбрасываются вместе, серверные отметки не меняются.
 */
async function resetTaskFilters() {
  q.value = '';
  sortBy.value = 'b24';
  triageMode.value = 'all';
  favoriteOnly.value = false;
  newOnly.value = false;
  await nextTick();
  taskSearch.value?.focus();
}
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
watch(listResetKey, () => {
  visibleCount.value = PAGE;
  if (taskList.value) {
    taskList.value.scrollTop = 0;
  }
});
function showMoreTasks() {
  visibleCount.value = Math.min(myTasks.value.length, visibleCount.value + PAGE);
}
function onTasksScroll(e) {
  const el = e.target;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80 && visibleCount.value < myTasks.value.length) {
    showMoreTasks();
  }
}
const chart = computed(() => data.value?.charts?.[period.value] || null);

let ticker = null;
onMounted(() => {
  board.load();
  favorites.load(true);
  seen.load(true);
  if (analysisEnabled.value) startAnalysisPolling();
  loadConveyor();
  ticker = setInterval(() => { now.value = Date.now(); }, 1000);
});
onUnmounted(() => { if (ticker) clearInterval(ticker); });
</script>

<style scoped>
.board {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  container: board-page / inline-size;
}
.err { color: var(--bad); }
.link { color: var(--accent); margin-left: 8px; }

.stats { display: grid; gap: 12px; grid-template-columns: repeat(2, 1fr); }
@container board-page (min-width: 720px) { .stats { grid-template-columns: repeat(4, 1fr); } }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 12px 16px; display: flex; flex-direction: column; gap: 7px; }
.thead { display: flex; align-items: center; gap: 9px; }
.tico { width: 27px; height: 27px; border-radius: 8px; display: grid; place-items: center; flex: none; }
.tico svg { width: 15px; height: 15px; }
.t-accent .tico { color: var(--accent); background: color-mix(in srgb, var(--accent) 15%, transparent); }
.t-good .tico { color: var(--good); background: color-mix(in srgb, var(--good) 15%, transparent); }
.t-warn .tico { color: var(--warn); background: color-mix(in srgb, var(--warn) 15%, transparent); }
.t-month .tico { color: var(--ink); background: var(--surface-2); }
.tlabel { font-size: 12px; color: var(--ink-mid); font-weight: 500; }
.tval { font-size: 24px; font-weight: 700; letter-spacing: -.02em; line-height: 1; }
.tdelta { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 4px; align-self: flex-start;
  font-size: 11px; color: var(--ink-mid); line-height: 1.5; }
.tdelta .darrow { font-weight: 700; }
.tdelta .dvs { color: var(--ink-mid); }
.tdelta.up { color: var(--good); }
.tdelta.down { color: var(--ink-mid); }

.tpct { margin-left: auto; font-size: 12px; color: var(--ink-mid); font-weight: 600; }
.tpct.over { color: var(--good); }
.bar { height: 7px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
.bar .fill { display: block; height: 100%; background: var(--good); border-radius: 999px; transition: width .3s; }
.bar .fill.over { background: linear-gradient(90deg, var(--good), var(--accent)); }
.mfoot { display: flex; align-items: center; justify-content: space-between; font-size: 11.5px; }
.mfoot .over { color: var(--good); font-weight: 600; }

.active-timers {
  padding: 12px;
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--good) 7%, var(--surface)),
      var(--surface) 32%
    );
  border: 1px solid color-mix(in srgb, var(--good) 34%, var(--line));
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}
.active-timers-head {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
  margin-bottom: 11px;
  padding: 0 2px;
}
.active-timers-symbol {
  position: relative;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  flex: none;
  border-radius: 10px;
  background: color-mix(in srgb, var(--good) 13%, transparent);
  color: var(--good);
}
.active-timers-symbol svg {
  width: 17px;
  height: 17px;
}
.active-timers-pulse {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 8px;
  height: 8px;
  border: 2px solid var(--surface);
  border-radius: 50%;
  background: var(--good);
  animation: active-timer-pulse 1.6s ease-in-out infinite;
}
.active-timers-heading {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.active-timers-title {
  margin: 0;
  color: var(--ink);
  font-size: 13px;
  font-weight: 680;
  line-height: 1.2;
}
.active-timers-subtitle {
  overflow: hidden;
  color: var(--ink-mid);
  font-size: 10.5px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.active-timers-count {
  min-width: 24px;
  height: 24px;
  display: inline-grid;
  place-items: center;
  flex: none;
  box-sizing: border-box;
  border-radius: 999px;
  background: color-mix(in srgb, var(--good) 15%, transparent);
  color: var(--good);
  font-size: 11.5px;
  font-weight: 750;
}
.active-timers-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr));
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.active-timer-item {
  min-width: 0;
}
.active-timer-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-width: 0;
}
.active-timer-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--good);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: .02em;
  white-space: nowrap;
}
.active-timer-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--good);
  box-shadow: 0 0 6px color-mix(in srgb, var(--good) 65%, transparent);
}
.active-timer-time {
  flex: none;
  color: var(--accent);
  font-size: 14px;
  font-weight: 650;
  white-space: nowrap;
}
.active-task-title {
  display: -webkit-box;
  overflow: hidden;
  color: var(--ink);
  font-size: 13px;
  font-weight: 620;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-height: 1.35;
  text-align: left;
}
.active-task-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-width: 0;
  margin-top: auto;
  color: var(--ink-mid);
  font-size: 10px;
  line-height: 1.2;
}
.active-task-project {
  overflow: hidden;
  padding-left: 7px;
  border-left: 1px solid var(--line-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}
@keyframes active-timer-pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) {
  .active-timers-pulse { animation: none; }
}

.cols { display: flex; flex-wrap: wrap; gap: 16px; align-items: stretch; min-width: 0; }
.col { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
/* Основной блок «Мои задачи» — в карточке, чтобы визуально доминировал */
.col.primary {
  flex: 2 1 720px; container: board-primary / inline-size;
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px;
}
.col.secondary {
  flex: 1 1 320px;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}
.secondary-tabs { width: 100%; }
.secondary-tabs > :deep(.ui-tab) { flex: 1; }
.secondary-summary {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 8px;
  color: var(--ink-mid);
  font-size: 12px;
}
.related-panel { display: flex; flex: 1; min-height: 0; }
.related-list { flex: 1; max-height: min(58vh, 560px); overflow-y: auto; scrollbar-gutter: stable; }
.related-row { padding: 11px 4px; }
.related-row + .related-row { border-top: 1px solid var(--line); }
/* Правой колонки нет — карточка задач занимает всю доступную строку. */
.cols.solo .primary { flex-basis: 100%; }
.colhead {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 340px);
  align-items: center; gap: 10px 14px; margin: 6px 0 2px; min-width: 0;
}
.h {
  font-size: 14px;
  font-weight: 640;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ink-mid);
}
.h.big { font-size: 16px; color: var(--ink); }
.colhead .h { flex-wrap: wrap; }
.heading-name { white-space: nowrap; }
.cnt { font-size: 11px; color: var(--ink); background: var(--surface-2); border-radius: 999px; padding: 1px 8px; white-space: nowrap; }
.filter-toggle {
  display: none;
  justify-self: end;
}
.filter-count {
  min-width: 18px; height: 18px; display: inline-grid; place-items: center; padding: 0 4px;
  border-radius: 999px; background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--accent); font-size: 10px; font-weight: 700; line-height: 1;
}
.filterbar {
  display: flex; align-items: flex-end; flex-wrap: wrap; gap: 8px 12px;
  min-width: 0; max-width: 100%; padding: 3px 0 5px;
}
.filter-section { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.sort-filter { flex: 0 1 205px; }
.show-filter, .triage-filter { flex: 0 1 auto; }
.filter-caption {
  flex-basis: 100%; color: var(--ink-mid); font-size: 11px; font-weight: 500;
  line-height: 1.4; white-space: nowrap;
}
.trisort {
  flex: 1 1 135px; min-width: 0; box-sizing: border-box;
}
.filter-actions { display: flex; flex: 0 1 auto; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; margin-left: auto; }
.batch-actions {
  display: flex; align-items: center; flex: none; padding-left: 10px;
  border-left: 1px solid var(--line);
}
.batch-count {
  min-width: 20px; height: 20px; display: inline-grid; place-items: center; box-sizing: border-box;
  border-radius: 999px; background: color-mix(in srgb, #000 18%, transparent); padding: 0 5px;
  font-size: 10px; line-height: 1;
}
.search {
  width: 100%;
  min-width: 0;
}
.search > :deep(.ui-search-input) { width: 100%; }
.faverror {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  margin: 2px 0 4px; padding: 7px 10px; border: 1px solid color-mix(in srgb, var(--bad) 45%, var(--line));
  border-radius: 8px; color: var(--bad); font-size: 12px;
}
.tasks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.scroller {
  flex: 1;
  max-height: min(58vh, 560px);
  overflow-y: auto;
  scrollbar-gutter: stable;
}
.more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 12px;
  padding: 10px 0 4px;
}
.list-head,
.trow {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) 182px 86px;
  align-items: center;
  gap: 12px;
}
.list-head {
  padding: 10px 10px 2px;
  overflow-y: hidden;
  scrollbar-gutter: stable;
  border-top: 1px solid var(--line);
  color: var(--ink-mid);
  font-size: 11px;
}
.list-task-label { grid-column: 2; }
.list-time-label { text-align: right; }
.trow { min-width: 0; padding: 12px 10px; border-radius: 8px; }
.trow.without-analysis,
.list-head.without-analysis { grid-template-columns: 28px minmax(0, 1fr) 86px; }
.trow > :deep(.favbtn) { align-self: start; margin-top: -4px; }
.trow:hover,
.trow:focus-within { background: var(--surface-2); }
.trow + .trow { border-top: 1px solid var(--line); }
.task-name { width: 100%; font-size: 14px; font-weight: 500; }
.task-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px 12px;
  min-width: 0;
  color: var(--ink-mid);
  font-size: 11.5px;
  line-height: 1.5;
}
.task-id { color: var(--ink-mid); }
.task-project { overflow-wrap: anywhere; }
.task-state { display: inline-flex; align-items: center; gap: 7px; }
.task-state.overdue { color: var(--bad); }
.shelf-mark { color: var(--warn); }
.task-triage { min-width: 0; }
.tstat { width: 8px; height: 8px; border-radius: 50%; flex: none; box-shadow: 0 0 6px color-mix(in srgb, currentColor 0%, transparent); }
.tstat.on-shelf { outline: 1px solid var(--warn); outline-offset: 3px; }
/* Задача на конвейере: точка чуть крупнее и «дышит» — видно с первого взгляда */
.tstat.conv { width: 9px; height: 9px; animation: convpulse 2s ease-in-out infinite; }
@keyframes convpulse { 50% { opacity: .45; } }
.badge { font-size: 11px; color: var(--accent); }
/* Метка «новая» — того же синего, что и точка новых задач на чипе «Доска» в навигации:
   человек приходит сюда именно с неё, и цвет должен совпасть. */
.newbadge {
  flex: none; font-size: 11px; font-weight: 500; line-height: 1.5;
  border-radius: 5px;
  background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); padding: 1px 6px;
}
.ttime {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  color: var(--ink-mid);
  font-size: 12px;
}
.ttime.running { color: var(--good); }
.time-state { font-size: 11px; }
.empty { font-size: 13px; padding: 24px 10px; }

/* Решение принимается по ширине карточки, а не viewport: sidebar, dock и правая
   колонка могут оставить планшету узкий primary даже при широком окне. */
@container board-primary (max-width: 720px) {
  .colhead { grid-template-columns: minmax(0, 1fr) auto; }
  .filter-toggle { display: inline-flex; }
  .search { grid-column: 1 / -1; }
  .filterbar { display: none; padding-top: 5px; border-top: 1px solid var(--line); }
  .filterbar.expanded { display: flex; }
  .filter-section { flex: 1 1 100%; align-items: stretch; }
  .filter-caption { flex-basis: 100%; padding: 2px 1px 0; }
  .sort-filter .trisort { flex-basis: 100%; width: 100%; }
  .show-filter > :deep(.ui-button) { flex: 1 1 140px; }
  .trisegment { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); width: 100%; }
  .trisegment :deep(.ui-button) { width: 100%; }
  .filter-actions { width: 100%; margin-left: 0; }
  .filter-actions > :deep(.ui-button) { flex: 1 1 auto; }
  .batch-actions { margin-left: auto; }
  .list-head { display: none; }
  .trow,
  .trow.without-analysis { grid-template-columns: 28px minmax(0, 1fr) 86px; gap: 9px; padding: 12px 2px; }
  .trow .ttext { grid-column: 2 / -1; }
  .task-triage { grid-column: 2; }
  .ttime { grid-column: 3; grid-row: 2; }
}

@container board-primary (max-width: 560px) {
  .trisegment { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .trisegment > :deep(.ui-button:last-child) { grid-column: 1 / -1; }
  .batch-actions {
    flex: 1 1 100%;
    margin-left: 0;
    padding: 8px 0 0;
    border-left: 0;
    border-top: 1px solid var(--line);
  }
  .batch-actions > :deep(.ui-button) { width: 100%; }
}

@container board-primary (max-width: 390px) {
  .colhead { column-gap: 8px; }
  .colhead .h { font-size: 15px; gap: 6px; }
  .trow,
  .trow.without-analysis { grid-template-columns: 24px minmax(0, 1fr) 78px; gap: 6px; }
  .task-triage :deep(.total) { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .tstat.conv { animation: none; }
}

.charts-head { display: flex; align-items: center; justify-content: space-between; }
.charts-grid { display: grid; gap: 12px; grid-template-columns: 1fr; margin-top: 10px; }
@container board-page (min-width: 720px) { .charts-grid { grid-template-columns: repeat(3, 1fr); } }
@container board-page (max-width: 420px) {
  .stats { gap: 8px; }
  .tile { padding: 10px; }
  .thead { gap: 6px; }
  .tico { width: 22px; height: 22px; }
  .tval { font-size: 20px; line-height: 1.2; overflow-wrap: anywhere; }
}
</style>
