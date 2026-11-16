<template>
  <section ref="panel" class="task-shelf-panel ui-workspace" data-ui-workspace
           tabindex="-1" :aria-label="t('core.taskPolkaZadach')" :aria-busy="shelf.loading || undefined">
    <header class="shelf-head">
      <div class="shelf-pane-heading">
        <UiPaneHeader>
          <template #title><h2>{{ t('core.taskPolkaZadach') }}</h2></template>
          <template #actions>
            <UiIconButton v-if="!shelf._viewMirror" role="embedded" data-context="workspace-toolbar"
                          :label="t('core.shelfDesignRefresh')" v-tooltip="t('core.shelfDesignRefresh')"
                          :loading="shelf.loading" @click="shelf.load(true)">
              <UiRefreshIcon />
            </UiIconButton>
          </template>
        </UiPaneHeader>
      </div>
      <div v-if="shelf.allRows.length || hasFilters" class="shelf-toolbar">
        <div class="shelf-search">
          <UiSearchInput ref="searchInput" v-model="query"
                         :aria-label="t('core.taskPoiskZadachNaPolke')" :placeholder="t('core.taskNaytiZadachu')"
                         v-tooltip="t('core.taskPoiskPoNomeruNazvaniyu')"
                         :aria-description="t('core.taskPoiskPoNomeruNazvaniyu')" />
        </div>
        <div class="shelf-filters" role="group" :aria-label="t('core.taskFiltrZadachNaPolke')">
          <UiButton v-for="filter in filters" :key="filter.id" data-context="workspace-toolbar"
                    :data-shelf-filter="filter.id" :pressed="activeFilter === filter.id"
                    :aria-label="t('core.boardPageLabel', { label: filter.label, count: filter.count })"
                    @click="activeFilter = filter.id">
            {{ filter.label }}<span class="shelf-filter-count">{{ filter.count }}</span>
          </UiButton>
        </div>
      </div>
      <div v-if="hasFilters" class="shelf-filter-summary">
        <span role="status">{{ t('core.taskPokazano') }} {{ visibleCount }} {{ t('settings.from') }} {{ shelf.allRows.length }}</span>
        <UiButton variant="text" size="compact" @click="resetFilters">{{ t('core.inboxResetFilters') }}</UiButton>
      </div>
    </header>

    <div class="shelf-content">
      <p class="shelf-heading ui-workspace-intro">{{ summaryText }}</p>
      <UiLoadingState v-if="shelf.loading && !shelf.loaded" :label="t('core.taskZagruzhayuPolku')"
                      :failed="Boolean(shelf.error)">
        <div class="shelf-loading"><UiSkeletonLayout layout="list" :header="true" /></div>
      </UiLoadingState>
      <UiInlineMessage v-if="shelf.error" class="shelf-state" tone="danger">
        {{ shelf.error }}
      </UiInlineMessage>
      <UiInlineMessage v-if="shelf.sourceIssues?.length" class="source-issues" tone="warning">
        <details>
          <summary>{{ t('core.taskChastDannyhVremennoNedostupna') }}</summary>
          <span>{{ shelf.sourceIssues.join(' · ') }}</span>
        </details>
      </UiInlineMessage>
      <div v-if="!shelf.loading && !shelf.error && !shelf.allRows.length" class="shelf-empty">
        <span class="shelf-empty-icon" aria-hidden="true">◇</span>
        <div>
          <h3>{{ t('core.taskNaPolkePokaPusto') }}</h3>
          <p>{{ t('core.taskOtkladyvayteSyudaZadachiPo') }}</p>
        </div>
      </div>
      <div v-else-if="shelf.allRows.length && !visibleCount" class="shelf-empty">
        <span class="shelf-empty-icon" aria-hidden="true">⌕</span>
        <div>
          <h3>{{ t('core.inboxNoResults') }}</h3>
          <p>{{ t('core.taskIzmenitePoiskovyyZaprosIli') }}</p>
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
            <li v-for="row in group.rows" :key="JSON.stringify([row.taskSource, row.taskId])">
              <UiSelectableRow
                class="shelf-card"
                data-ui-task-shelf-row
                :data-task-id="row.taskId"
                :data-shelf-state="row.state"
                :data-shelf-attention="row.needsHuman && !row.completed ? 'true' : undefined"
                :data-shelf-completed="row.completed ? 'true' : undefined"
                @select="ui.openTask(row.taskId, row.taskSource)"
              >
                <span class="shelf-copy">
                  <span class="shelf-main">
                    <span class="shelf-meta">
                      <span class="shelf-id mono">#{{ row.taskId }}</span>
                      <TaskSourceChip :source="row.taskSource" />
                      <template v-if="row.details?.project">
                        <span class="ui-visually-hidden">, </span>
                        <span class="shelf-project">{{ row.details.project }}</span>
                      </template>
                    </span>

                    <strong class="shelf-title" v-tooltip="row.title">{{ row.title }}</strong>

                    <span v-if="row.state === 'lit'" class="shelf-event">
                      <span class="shelf-event-label"> {{ t('core.taskNovoeSobytie') }}<template v-if="eventSource(row)"> · {{ eventSource(row) }}</template>
                      </span>
                      <span class="shelf-event-message">{{ row.message }}</span>
                      <span class="shelf-event-hint">{{ t('core.taskOtkrytieZadachiOtmetitSobytie') }}</span>
                    </span>
                    <span v-else class="shelf-waiting">
                      <span>{{ row.needsHuman && !row.completed ? t('core.taskTrebuetVnimaniya') : t('core.taskOzhidanie') }}</span>
                      {{ row.reasonText }}
                    </span>

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
                        <span class="ui-visually-hidden">{{ t('core.taskOtvetstvennyy') }}{{ ' ' }}</span>{{ row.details.responsible }}
                      </span>
                      <span
                        v-if="row.details?.deadline"
                        class="shelf-deadline"
                        :class="{ overdue: row.details.overdue }"
                      >
                        {{ row.details.overdue ? t('core.taskProsrochenaDo') : t('core.taskDo') }} {{ row.details.deadline }}
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
                        >{{ t('core.taskProydeno') }}</span></span>
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
                    :label="t('core.taskOtmetitSobytieProsmotrennym')"
                    v-tooltip="t('core.taskOtmetitSobytieProsmotrennym')"
                    role="embedded"
                    tone="success"
                    :loading="shelfState(row).isPending?.(row.taskId)"
                    :disabled="shelfState(row).isPending?.(row.taskId)"
                    @click.stop="shelf.acknowledge(row.taskId, { source: row.personalSource, taskSource: row.taskSource })"
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
                    :label="t('core.taskUbratSPolki')"
                    v-tooltip="t('core.taskUbratSPolki')"
                    role="embedded"
                    tone="neutral"
                    :loading="row.state !== 'lit' && shelfState(row).isPending?.(row.taskId)"
                    :disabled="shelfState(row).isPending?.(row.taskId)"
                    @click.stop="shelf.remove(row.taskId, { source: row.personalSource, taskSource: row.taskSource })"
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
    </div>
  </section>
</template>

<script setup lang="ts">
import TaskSourceChip from '../../shared/TaskSourceChip.vue';
import { computed, nextTick, ref } from 'vue';
import { useTaskShelfStore } from '../../stores/taskShelf.ts';
import type { ShelfActivity, ShelfActivityProgress, ShelfRow } from '../../stores/taskShelf.ts';
import { useUiStore } from '../../stores/ui.ts';
import { t, uiLocale } from '../../ui';
import {
  UiRefreshIcon, UiButton, UiPaneHeader, UiInlineMessage, UiSkeletonLayout, UiIconButton,
  UiProgress, UiSearchInput, UiSelectableRow, vTooltip, UiLoadingState,
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
  get analysis() {
    return t('core.taskOtsenka');
  },
  get pipeline() {
    return t('settings.pipeline');
  },
  get comments() {
    return t('core.taskKommentarii');
  },
  get b24() {
    return t('settings.bitrix');
  },
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
const shelfState = (row: ShelfRow) => row.taskSource ? shelf.forSource(row.taskSource) : shelf;
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
    title: t('core.needAttention'),
    rows: shelf.allRows.filter((row) => (row.state === 'lit' || row.needsHuman) && !row.completed),
  },
  {
    id: 'waiting',
    title: t('core.taskVOzhidanii'),
    rows: shelf.allRows.filter((row) => row.state !== 'lit' && !row.needsHuman && !row.completed),
  },
  {
    id: 'completed',
    title: t('core.taskZavershennye'),
    rows: shelf.allRows.filter((row) => row.completed),
  },
]);

const filters = computed(() => [
  {
    id: 'all' as const,
    label: t('core.selectAllGroups'),
    count: shelf.allRows.length,
  },
  ...allGroups.value.map((group) => ({
    id: group.id,
    label: group.id === 'attention' ? t('core.taskVnimanie') : group.title,
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
  if (!shelf.allRows.length) {
    return t('core.taskZadachiPoKotorymZhdem');
  }

  const total = t('core.shelfTaskCount', { count: shelf.allRows.length });

  const attention = allGroups.value.find((group) => group.id === 'attention')?.rows.length ?? 0;

  return attention
    ? t('core.taskTotalTrebuyutVnimaniyaAttention', { total, attention })
    : t('core.taskTotalPodNablyudeniem', { total });
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
    return t('core.taskDataNeizvestna');
  }

  const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));

  if (days === 0) {
    return t('core.taskDobavlenaSegodnya');
  }

  return t('core.taskNaPolkeDaysWordformdays', {
                      days: days,
                      wordFormdays: t('core.shelfDayWord', { count: days }),
                    });
}

function fullDate(value: string): string {
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return '';
  }

  return new Date(timestamp).toLocaleString(uiLocale.value, {
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
  return t('core.shelfUnreadCount', { count: value });
}

function progressTone(tone: string): UiActionTone {
  return PROGRESS_TONES[tone] || 'neutral';
}

function progressText(progress: ShelfActivityProgress): string {
  return progress.total ? `${progress.done}/${progress.total}` : t('core.taskIdet');
}

/**
 * Полоса остаётся отдельной от колонок активности и помещается в нижней строке
 * карточки: прогресс не растягивает соседние сведения и сохраняет видимые числа.
 */
function progressBars(row: ShelfRow): ShelfActivity[] {
  const bar = row.details?.activities?.find((activity) => activity.progress);

  return bar ? [bar] : [];
}

function exportState() {
  return { query: query.value, filter: activeFilter.value };
}

/**
 * Восстанавливает поиск и только существующий фильтр Полки.
 * Перенос не меняет строки или состояние просмотра задач.
 */
function importState(state: Record<string, unknown>) {
  query.value = typeof state.query === 'string' ? state.query : '';

  if (filters.value.some((filter) => filter.id === state.filter)) {
    activeFilter.value = state.filter as ShelfFilter;
  }
}

defineExpose({
  focus: () => panel.value?.focus?.(),
  exportState,
  importState,
});
</script>

<style scoped>
.task-shelf-panel {
  display: flex;
  flex-direction: column;
  container: task-shelf / inline-size;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--surface);
  color: var(--ink);
}

.shelf-head {
  flex: none;
  min-width: 0;
  border-bottom: 1px solid var(--line);
  background: var(--topbar);
}

.shelf-pane-heading {
  padding-right: var(--tool-dock-actions-space, 0px);
}

.shelf-heading {
  padding: 10px 12px 0;
}

.shelf-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  min-width: 0;
  padding: 10px 12px;
}

.shelf-search {
  flex: 1 1 220px;
  max-width: 360px;
  min-width: 0;
}

.shelf-filters {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.shelf-filter-count {
  margin-left: 7px;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  opacity: .75;
}

.shelf-filter-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 12px;
  min-width: 0;
  padding: 0 12px 8px;
  color: var(--ink-mid);
  font-size: 11px;
  line-height: 17px;
}

.shelf-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.shelf-loading {
  padding: 12px 0;
}

.shelf-state,
.source-issues {
  margin: 12px;
}

.source-issues span {
  display: block;
  margin-top: 6px;
  overflow-wrap: anywhere;
}

.shelf-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  min-height: 200px;
  padding: 24px;
  color: var(--ink-mid);
}

.shelf-empty-icon {
  flex: none;
  color: var(--ink-low);
  font-size: 28px;
  line-height: 36px;
}

.shelf-empty h3 {
  margin: 0;
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
  line-height: 19px;
}

.shelf-empty p {
  max-width: 48ch;
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

.shelf-groups {
  display: grid;
  gap: 12px;
  padding-bottom: 16px;
}

.shelf-group {
  min-width: 0;
}

.shelf-group-head {
  position: sticky;
  z-index: 1;
  top: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--ground);
}

.shelf-group-head h3 {
  margin: 0;
  color: var(--ink-mid);
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
}

.shelf-group-head > span {
  display: inline-grid;
  flex: none;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding-inline: 5px;
  border-radius: 4px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

[data-shelf-group='attention'] .shelf-group-head h3,
[data-shelf-group='attention'] .shelf-group-head > span {
  color: var(--warn);
}

.shelf-list {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  margin: 0;
  padding: 0;
  list-style: none;
}

.shelf-list > li {
  min-width: 0;
}

.shelf-copy {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px 24px;
  min-width: 0;
}

.shelf-main {
  display: grid;
  align-content: start;
  gap: 5px;
  min-width: 0;
}

.shelf-meta {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 8px;
  min-width: 0;
  color: var(--ink-mid);
  font-size: 10.5px;
  line-height: 16px;
}

.shelf-id {
  flex: none;
  color: var(--accent);
  font-weight: 500;
}

.shelf-project {
  min-width: 0;
  overflow-wrap: anywhere;
}

.shelf-title {
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
  line-height: 19px;
  overflow-wrap: anywhere;
}

.shelf-event,
.shelf-waiting {
  min-width: 0;
  font-size: 11.5px;
  line-height: 17px;
  overflow-wrap: anywhere;
}

.shelf-event {
  display: grid;
  gap: 3px;
  margin-top: 2px;
}

.shelf-event-label {
  color: var(--warn);
  font-size: 10.5px;
  font-weight: 600;
}

.shelf-event-message {
  color: var(--ink);
}

.shelf-event-hint {
  color: var(--ink-low);
  font-size: 10.5px;
  line-height: 16px;
}

.shelf-waiting {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 3px 8px;
  color: var(--ink-mid);
}

.shelf-waiting > span {
  color: var(--ink-low);
}

[data-shelf-attention='true'] .shelf-waiting > span {
  color: var(--warn);
  font-weight: 500;
}

.shelf-activities {
  display: grid;
  align-content: start;
  gap: 8px;
  min-width: 0;
}

.shelf-activity {
  display: grid;
  grid-template-columns: 78px minmax(0, 1fr);
  align-content: start;
  gap: 4px 10px;
  min-width: 0;
  font-size: 11.5px;
  line-height: 17px;
}

.shelf-activity-label {
  color: var(--ink-low);
  font-size: 10.5px;
  line-height: 16px;
}

.shelf-activity-value {
  min-width: 0;
  color: var(--ink-mid);
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
  grid-column: 1 / -1;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 20px;
  min-width: 0;
}

.shelf-footer {
  display: flex;
  flex: 1 1 320px;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px 14px;
  min-width: 0;
  color: var(--ink-low);
  font-size: 10.5px;
  line-height: 16px;
  overflow-wrap: anywhere;
}

.shelf-responsible {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.shelf-responsible svg {
  width: 12px;
  height: 12px;
  flex: none;
}

.shelf-deadline.overdue,
.shelf-unread {
  color: var(--bad);
}

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
  gap: 8px;
  color: var(--ink-mid);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  line-height: 16px;
}

.shelf-progress-bar {
  flex: 1;
  min-width: 48px;
}

/* Источники сохраняют свои места, даже если у задачи нет оценки или конвейера.
   На широком экране их сводка стоит рядом с задачей, а не удлиняет каждую строку. */
@container task-shelf (min-width: 820px) {
  .shelf-activities {
    grid-template-columns: minmax(0, .8fr) minmax(0, 1fr) minmax(0, 1.2fr);
    gap: 16px;
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

@container task-shelf (min-width: 1080px) {
  .shelf-copy {
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
  }
}

@container task-shelf (max-width: 700px) {
  .shelf-search {
    flex: 1 1 100%;
    max-width: none;
  }

  .shelf-filters {
    flex: 1 1 100%;
  }

  .shelf-progress {
    flex-basis: 100%;
    max-width: 320px;
  }
}

@container task-shelf (max-width: 380px) {
  .shelf-activity {
    grid-template-columns: 68px minmax(0, 1fr);
    gap: 4px 8px;
  }
}

@container task-shelf (max-width: 560px) {
  .shelf-filters {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
