<template>
  <section ref="panel" class="task-shelf-panel" tabindex="-1" aria-label="Полка задач">
    <header class="shelf-head">
      <div class="shelf-heading">
        <h2>Полка задач</h2>
        <p>{{ summaryText }}</p>
      </div>

      <div v-if="shelf.rows.length || hasFilters" class="shelf-toolbar">
        <div class="shelf-search">
          <UiSearchInput
            ref="searchInput"
            v-model="query"
            aria-label="Поиск задач на полке"
            placeholder="Найти задачу…"
            v-tooltip="'Поиск по номеру, названию, проекту и ответственному'"
            aria-description="Поиск по номеру, названию, проекту и ответственному"
          />
        </div>
        <UiSelect v-model="activeFilter" aria-label="Фильтр задач на полке">
          <option v-for="filter in filters" :key="filter.id" :value="filter.id">
            {{ filter.label }} · {{ filter.count }}
          </option>
        </UiSelect>
      </div>
      <div v-if="hasFilters" class="shelf-filter-summary">
        <span role="status">Показано {{ visibleCount }} из {{ shelf.rows.length }}</span>
        <UiButton variant="ghost" @click="resetFilters">Сбросить фильтры</UiButton>
      </div>
    </header>

    <p v-if="shelf.loading && !shelf.loaded" class="shelf-state">Загружаю полку…</p>
    <p v-if="shelf.error" class="shelf-state error" role="alert">{{ shelf.error }}</p>
    <div v-if="shelf.sourceIssues?.length" class="source-issues" role="status">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3 2.8 19h18.4z" />
        <path d="M12 9v4 M12 17h.01" />
      </svg>
      <details>
        <summary>Часть данных временно недоступна</summary>
        <span>{{ shelf.sourceIssues.join(' · ') }}</span>
      </details>
    </div>
    <div v-if="!shelf.loading && !shelf.error && !shelf.rows.length" class="shelf-empty">
      <span class="shelf-empty-icon" aria-hidden="true">◇</span>
      <div>
        <h3>На полке пока пусто</h3>
        <p>Откладывайте сюда задачи, по которым ждёте оценку, прогон или ответ.</p>
      </div>
    </div>
    <div v-else-if="shelf.rows.length && !visibleCount" class="shelf-empty">
      <span class="shelf-empty-icon" aria-hidden="true">⌕</span>
      <div>
        <h3>Ничего не найдено</h3>
        <p>Измените поисковый запрос или выберите другую группу задач.</p>
      </div>
    </div>

    <div v-if="visibleCount" class="shelf-groups">
      <section
        v-for="group in groups"
        :key="group.id"
        class="shelf-group"
        :data-shelf-group="group.id"
        :aria-labelledby="`shelf-group-${group.id}`"
      >
        <header class="shelf-group-head">
          <h3 :id="`shelf-group-${group.id}`">{{ group.title }}</h3>
          <span>{{ group.rows.length }}</span>
        </header>

        <ul class="shelf-list">
          <li v-for="row in group.rows" :key="row.taskId">
            <UiSelectableRow
              class="shelf-card"
              data-ui-task-shelf-row
              :data-task-id="row.taskId"
              :data-shelf-state="row.state"
              :data-shelf-attention="row.needsHuman && !row.completed ? 'true' : undefined"
              :data-shelf-completed="row.completed ? 'true' : undefined"
              @select="ui.openTask(row.taskId)"
            >
              <span class="shelf-copy">
                <span class="shelf-meta">
                  <span class="shelf-id mono">#{{ row.taskId }}</span>
                  <template v-if="row.details?.project">
                    <span class="ui-visually-hidden">, </span>
                    <span class="shelf-project">{{ row.details.project }}</span>
                  </template>
                </span>

                <strong class="shelf-title" v-tooltip="row.title">{{ row.title }}</strong>

                <span v-if="row.state === 'lit'" class="shelf-event">
                  <span class="shelf-event-label">
                    Новое событие<template v-if="eventSource(row)"> · {{ eventSource(row) }}</template>
                  </span>
                  <span class="shelf-event-message">{{ row.message }}</span>
                  <span class="shelf-event-hint">Открытие задачи отметит событие просмотренным</span>
                </span>
                <span v-else class="shelf-waiting">
                  <span>{{ row.needsHuman && !row.completed ? 'Требует внимания' : 'Ожидание' }}</span>
                  {{ row.reasonText }}
                </span>

                <span v-if="row.details?.activities?.length" class="shelf-activities">
                  <span
                    v-for="activity in row.details.activities"
                    :key="activity.kind"
                    class="shelf-activity"
                    :data-kind="activity.kind"
                    :data-tone="activity.tone"
                  >
                    <span class="shelf-activity-label">{{ activity.label }}</span>
                    <span class="ui-visually-hidden">: </span>
                    <span class="shelf-activity-value">{{ activity.value }}</span>
                  </span>
                </span>

                <span class="shelf-bottom">
                  <span class="shelf-footer">
                    <span v-if="row.details?.responsible" class="shelf-responsible">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
                           stroke-linecap="round" aria-hidden="true">
                        <circle cx="12" cy="8" r="3" />
                        <path d="M5 21v-2a7 7 0 0 1 14 0v2" />
                      </svg>
                      <span class="ui-visually-hidden">Ответственный: </span>{{ row.details.responsible }}
                    </span>
                    <span
                      v-if="row.details?.deadline"
                      class="shelf-deadline"
                      :class="{ overdue: row.details.overdue }"
                    >
                      {{ row.details.overdue ? 'Просрочена · до' : 'до' }} {{ row.details.deadline }}
                    </span>
                    <span v-if="row.details?.unread" class="shelf-unread">
                      <span class="ui-visually-hidden">, </span>{{ unreadLabel(row.details.unread) }}
                    </span>
                    <time :datetime="row.addedAt" v-tooltip="fullDate(row.addedAt)">
                      {{ ageLabel(row.addedAt) }}
                    </time>
                  </span>
                  <span
                    v-for="bar in progressBars(row)"
                    :key="`progress-${bar.kind}`"
                    class="shelf-progress"
                    :data-tone="bar.tone"
                  >
                    <span class="shelf-progress-count">
                      <span class="shelf-progress-label">{{ bar.label }}<span
                        class="ui-visually-hidden"
                      >, пройдено:</span></span>
                      {{ progressText(bar.progress!) }}
                    </span>
                    <UiProgress
                      class="shelf-progress-bar"
                      :label="bar.label"
                      :tone="progressTone(bar.tone)"
                      :value="bar.progress!.done"
                      :max="bar.progress!.total"
                      :indeterminate="!bar.progress!.total"
                      :value-text="progressText(bar.progress!)"
                      v-tooltip="progressText(bar.progress!)"
                    />
                  </span>
                </span>
              </span>

              <template #actions>
                <UiIconButton
                  v-if="row.state === 'lit'"
                  label="Отметить событие просмотренным"
                  v-tooltip="'Отметить событие просмотренным'"
                  role="embedded"
                  tone="success"
                  :loading="shelf.isPending?.(row.taskId)"
                  :disabled="shelf.isPending?.(row.taskId)"
                  @click.stop="shelf.acknowledge(row.taskId)"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="m5 12 4 4L19 6" />
                  </svg>
                </UiIconButton>
                <!--
                  Тон намеренно нейтральный: снятие с полки обратимо — задачу кладут
                  обратно тем же движением. Красный крестик был самым громким пятном
                  карточки и обещал последствия, которых у действия нет.
                -->
                <UiIconButton
                  label="Убрать с полки"
                  v-tooltip="'Убрать с полки'"
                  role="embedded"
                  tone="neutral"
                  :loading="row.state !== 'lit' && shelf.isPending?.(row.taskId)"
                  :disabled="shelf.isPending?.(row.taskId)"
                  @click.stop="shelf.remove(row.taskId)"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                       stroke-linecap="round" aria-hidden="true">
                    <path d="M6 6l12 12 M18 6 6 18" />
                  </svg>
                </UiIconButton>
              </template>
            </UiSelectableRow>
          </li>
        </ul>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useTaskShelfStore } from '../../stores/taskShelf.ts';
import type { ShelfActivity, ShelfActivityProgress, ShelfRow } from '../../stores/taskShelf.ts';
import { useUiStore } from '../../stores/ui.ts';
import {
  UiButton,
  UiSelect,
  UiIconButton,
  UiProgress,
  UiSearchInput,
  UiSelectableRow,
  vTooltip,
} from '../../ui';
import type { UiActionTone } from '../../ui';

type PluralForms = [string, string, string];
type ShelfGroupId = 'attention' | 'waiting' | 'completed';
type ShelfFilter = 'all' | ShelfGroupId;

interface ShelfGroup {
  id: ShelfGroupId;
  title: string;
  rows: ShelfRow[];
}

const SOURCE_LABELS: Record<string, string> = {
  analysis: 'оценка',
  pipeline: 'конвейер',
  comments: 'комментарии',
  b24: 'Битрикс24',
};

// Полка и UI-kit говорят о цвете разными словарями: у карточки это состояние конвейера,
// у примитива — роль действия. Перевод живёт здесь, чтобы полоса не заводила свой скин.
const PROGRESS_TONES: Record<string, UiActionTone> = {
  accent: 'accent',
  good: 'success',
  warn: 'warning',
  bad: 'danger',
};

const shelf = useTaskShelfStore();
const ui = useUiStore();
const panel = ref<HTMLElement | null>(null);
const searchInput = ref<InstanceType<typeof UiSearchInput> | null>(null);
const query = ref('');
const activeFilter = ref<ShelfFilter>('all');

/**
 * Верхняя группа отвечает на вопрос «что ждёт меня», а не «что изменилось». Огонёк —
 * событие по фронту и снимается acknowledge, поэтому одной его проверки мало: задача,
 * которую конвейер держит на воротах, после первого же просмотра уезжала в тихую
 * «В ожидании» и там терялась, хотя решение по ней так и не принято.
 */
const allGroups = computed<ShelfGroup[]>(() => [
  {
    id: 'attention',
    title: 'Требуют внимания',
    rows: shelf.rows.filter((row) => (row.state === 'lit' || row.needsHuman) && !row.completed),
  },
  {
    id: 'waiting',
    title: 'В ожидании',
    rows: shelf.rows.filter((row) => row.state !== 'lit' && !row.needsHuman && !row.completed),
  },
  {
    id: 'completed',
    title: 'Завершённые',
    rows: shelf.rows.filter((row) => row.completed),
  },
]);

const filters = computed(() => [
  {
    id: 'all' as const,
    label: 'Все',
    count: shelf.rows.length,
  },
  ...allGroups.value.map((group) => ({
    id: group.id,
    label: group.id === 'attention' ? 'Внимание' : group.title,
    count: group.rows.length,
  })),
]);
const searchTerms = computed(() => normalizeSearch(query.value).split(/\s+/).filter(Boolean));
const hasFilters = computed(() => searchTerms.value.length > 0 || activeFilter.value !== 'all');
const groups = computed(() => allGroups.value
  .filter((group) => activeFilter.value === 'all' || group.id === activeFilter.value)
  .map((group) => ({
    ...group,
    rows: group.rows.filter(matchesSearch),
  }))
  .filter((group) => group.rows.length));
const visibleCount = computed(() => groups.value.reduce((total, group) => total + group.rows.length, 0));

/**
 * Счётчик внимания включает и просмотренные остановки на человеке. Он остаётся
 * общим при поиске, чтобы фильтр не создавал впечатление, что остальные задачи исчезли.
 */
const summaryText = computed(() => {
  if (!shelf.rows.length) {
    return 'Задачи, по которым ждём событие';
  }

  const total = `${shelf.rows.length} ${wordForm(shelf.rows.length, ['задача', 'задачи', 'задач'])}`;

  const attention = allGroups.value.find((group) => group.id === 'attention')?.rows.length ?? 0;

  return attention ? `${total} · требуют внимания: ${attention}` : `${total} под наблюдением`;
});

function normalizeSearch(value: string): string {
  return value.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').replaceAll('#', '').trim();
}

/**
 * Все слова запроса могут находиться в разных полях одной задачи. Поиск только
 * сужает видимые строки: снимки наблюдения и признак нового события он не меняет.
 */
function matchesSearch(row: ShelfRow): boolean {
  const text = normalizeSearch([
    row.taskId,
    row.title,
    row.details?.project,
    row.details?.responsible,
  ].join(' '));

  return searchTerms.value.every((term) => text.includes(term));
}

/**
 * Кнопка сброса исчезает вместе с отбором; возвращаем фокус в поиск, чтобы человек
 * мог сразу ввести новый запрос и не потерял место при работе с клавиатуры.
 */
async function resetFilters(): Promise<void> {
  query.value = '';
  activeFilter.value = 'all';

  await nextTick();
  searchInput.value?.focus();
}

/**
 * Русские числительные: 11–19 всегда просят форму множественного числа, поэтому
 * сотня проверяется раньше единиц.
 */
function wordForm(value: number, forms: PluralForms): string {
  const mod100 = Math.abs(value) % 100;
  const mod10 = mod100 % 10;

  if (mod100 >= 11 && mod100 <= 19) {
    return forms[2];
  }
  if (mod10 === 1) {
    return forms[0];
  }
  if (mod10 >= 2 && mod10 <= 4) {
    return forms[1];
  }

  return forms[2];
}

/**
 * Возраст записи на полке. Сегодняшняя задача называется отдельно: «на полке 0 дней»
 * человек читал бы как ошибку.
 */
function ageLabel(value: string): string {
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return 'дата неизвестна';
  }

  const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));

  if (days === 0) {
    return 'добавлена сегодня';
  }

  return `на полке ${days} ${wordForm(days, ['день', 'дня', 'дней'])}`;
}

function fullDate(value: string): string {
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return '';
  }

  return new Date(timestamp).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function eventSource(row: ShelfRow): string {
  return SOURCE_LABELS[String(row.source)] || '';
}

function unreadLabel(value: number): string {
  return `${value} ${wordForm(value, ['непрочитанный', 'непрочитанных', 'непрочитанных'])}`;
}

function progressTone(tone: string): UiActionTone {
  return PROGRESS_TONES[tone] || 'neutral';
}

function progressText(progress: ShelfActivityProgress): string {
  return progress.total ? `${progress.done}/${progress.total}` : 'Идёт';
}

/**
 * Полоса остаётся отдельной от колонок активности и помещается в нижней строке
 * карточки: прогресс не растягивает соседние сведения и сохраняет видимые числа.
 */
function progressBars(row: ShelfRow): ShelfActivity[] {
  const bar = row.details?.activities?.find((activity) => activity.progress);

  return bar ? [bar] : [];
}

defineExpose({ focus: () => panel.value?.focus?.() });
</script>

<style scoped>
.task-shelf-panel {
  container: task-shelf / inline-size;
  min-height: 100%;
  height: 100%;
  overflow-y: auto;
  scrollbar-gutter: stable;
  outline: none;
  background: var(--ground);
  color: var(--ink);
}

.shelf-head {
  position: sticky;
  z-index: 3;
  top: 0;
  display: grid;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--ground) 96%, transparent);
  backdrop-filter: blur(12px);
}

.shelf-heading {
  min-height: 36px;
  padding-right: var(--tool-dock-actions-space, 0px);
}

.shelf-head h2 {
  margin: 0;
  font-size: 17px;
  line-height: 1.4;
}

.shelf-head p {
  margin: 3px 0 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.45;
}

.shelf-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px 16px;
  min-width: 0;
}

.shelf-search {
  flex: 1 1 160px;
  min-width: 0;
}

.shelf-filter-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 12px;
  color: var(--ink-mid);
  font-size: 12px;
}

.shelf-state {
  margin: 0;
  padding: 18px 16px;
  color: var(--ink-mid);
  font-size: 13px;
}

.shelf-state.error {
  color: var(--bad);
}

.source-issues {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 12px 16px 0;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--warn) 38%, var(--line));
  border-radius: 8px;
  background: color-mix(in srgb, var(--warn) 7%, transparent);
  color: var(--warn);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.source-issues svg {
  width: 16px;
  height: 16px;
  flex: none;
  margin-top: 1px;
}

.shelf-empty {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 16px;
  padding: 24px;
  border: 1px dashed var(--line-2);
  border-radius: 10px;
  color: var(--ink-mid);
}

.shelf-empty-icon {
  color: var(--accent);
  font-size: 28px;
}

.shelf-empty h3 {
  margin: 0;
  color: var(--ink);
  font-size: 14px;
}

.shelf-empty p {
  margin: 5px 0 0;
  font-size: 12px;
  line-height: 1.5;
}

.shelf-groups {
  display: grid;
  gap: 24px;
  padding: 18px 16px 24px;
}

.shelf-group {
  min-width: 0;
}

.shelf-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
}

.shelf-group-head h3 {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  font-weight: 650;
}

.shelf-group-head span {
  min-width: 20px;
  height: 20px;
  display: inline-grid;
  place-items: center;
  padding-inline: 5px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

[data-shelf-group='attention'] .shelf-group-head h3,
[data-shelf-group='attention'] .shelf-group-head span {
  color: var(--warn);
}

[data-shelf-group='attention'] .shelf-group-head span {
  background: color-mix(in srgb, var(--warn) 13%, transparent);
}

.shelf-list {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.shelf-list > li {
  min-width: 0;
}

.shelf-copy {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 9px;
}

.shelf-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  color: var(--ink-mid);
  font-size: 11px;
  line-height: 1.4;
}

.shelf-id {
  flex: none;
  color: var(--accent);
  font-weight: 650;
}

.shelf-project {
  min-width: 0;
  overflow-wrap: anywhere;
  padding-left: 8px;
  border-left: 1px solid var(--line-2);
}

.shelf-title {
  color: var(--ink);
  font-size: 14px;
  font-weight: 650;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.shelf-event,
.shelf-waiting {
  min-width: 0;
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.shelf-event {
  display: grid;
  gap: 4px;
  padding: 9px 11px;
  border-left: 2px solid var(--warn);
  border-radius: 0 6px 6px 0;
  background: color-mix(in srgb, var(--warn) 7%, transparent);
}

.shelf-event-label {
  color: var(--warn);
  font-size: 11px;
  font-weight: 650;
}

.shelf-event-message {
  color: var(--ink);
  font-weight: 550;
}

.shelf-event-hint {
  color: var(--ink-mid);
  font-size: 11px;
}

.shelf-waiting {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 3px 8px;
  color: var(--ink);
}

.shelf-waiting > span {
  color: var(--ink-mid);
}

[data-shelf-attention='true'] .shelf-waiting > span {
  color: var(--warn);
  font-weight: 650;
}

.shelf-activities {
  display: grid;
  gap: 8px;
  padding-block: 3px;
}

.shelf-activity {
  display: grid;
  grid-template-columns: 78px minmax(0, 1fr);
  align-content: start;
  gap: 4px 10px;
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
}

.shelf-activity-label {
  color: var(--ink-mid);
  font-size: 11px;
  font-weight: 550;
}

.shelf-activity-value {
  min-width: 0;
  color: var(--ink);
  overflow-wrap: anywhere;
}

.shelf-activity[data-tone='warn'] .shelf-activity-value,
.shelf-progress[data-tone='warn'] .shelf-progress-count {
  color: var(--warn);
}

.shelf-activity[data-tone='bad'] .shelf-activity-value,
.shelf-progress[data-tone='bad'] .shelf-progress-count {
  color: var(--bad);
}

.shelf-bottom {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px 20px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.shelf-footer {
  display: flex;
  flex: 1 1 300px;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px 16px;
  min-width: 0;
  color: var(--ink-mid);
  font-size: 11px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.shelf-responsible {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.shelf-responsible svg {
  width: 13px;
  height: 13px;
  flex: none;
}

.shelf-deadline.overdue,
.shelf-unread {
  color: var(--bad);
}

/* Короткая шкала в подвале показывает место в маршруте, оставляя причину остановки
   главным цветовым акцентом. Число остаётся видимым и при неизвестной длине маршрута. */
.shelf-progress {
  display: flex;
  flex: 0 1 260px;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.shelf-progress-count {
  display: inline-flex;
  flex: none;
  justify-content: space-between;
  gap: 8px;
  min-width: 104px;
  color: var(--ink-mid);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
}

.shelf-progress-label {
  color: var(--ink-mid);
}

.shelf-progress-bar {
  flex: 1;
  min-width: 48px;
}

@container task-shelf (min-width: 820px) {
  .shelf-list {
    grid-template-columns: minmax(0, 1fr);
  }

  /* Каждый источник сохраняет свою колонку даже при отсутствии соседнего:
     оценка и конвейер не перескакивают влево между карточками. */
  .shelf-activities {
    grid-template-columns: minmax(0, 0.8fr) minmax(0, 1fr) minmax(0, 1.2fr);
    gap: 20px;
  }

  .shelf-activity {
    grid-template-columns: minmax(0, 1fr);
  }

  .shelf-activity[data-kind='b24'] {
    grid-column: 1;
    grid-row: 1;
  }

  .shelf-activity[data-kind='analysis'] {
    grid-column: 2;
    grid-row: 1;
  }

  .shelf-activity[data-kind='pipeline'] {
    grid-column: 3;
    grid-row: 1;
  }
}

@container task-shelf (max-width: 560px) {
  .shelf-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .shelf-search {
    flex: auto;
  }

  .shelf-progress {
    flex-basis: 100%;
    max-width: 320px;
  }
}

@container task-shelf (max-width: 380px) {
  .shelf-head {
    padding-inline: 12px;
  }

  .shelf-groups {
    padding-inline: 12px;
  }

  .shelf-activity {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
}
</style>
