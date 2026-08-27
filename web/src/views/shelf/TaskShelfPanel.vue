<template>
  <section ref="panel" class="task-shelf-panel" tabindex="-1" aria-label="Полка задач">
    <header class="shelf-head">
      <div>
        <h2>Полка</h2>
        <p>{{ summaryText }}</p>
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
      <span>{{ shelf.sourceIssues.join(' · ') }}</span>
    </div>
    <div v-if="!shelf.loading && !shelf.error && !shelf.rows.length" class="shelf-empty">
      <span class="shelf-empty-icon" aria-hidden="true">◇</span>
      <div>
        <h3>На полке пока пусто</h3>
        <p>Откладывайте сюда задачи, по которым ждёте оценку, прогон или ответ.</p>
      </div>
    </div>

    <div v-if="shelf.rows.length" class="shelf-groups">
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
              :aria-label="rowAriaLabel(row)"
              @select="ui.openTask(row.taskId)"
            >
              <span class="shelf-copy">
                <span class="shelf-meta">
                  <span class="shelf-id mono">#{{ row.taskId }}</span>
                  <span v-if="row.details?.project" class="shelf-project">
                    {{ row.details.project }}
                  </span>
                  <time :datetime="row.addedAt" :title="fullDate(row.addedAt)">
                    {{ ageLabel(row.addedAt) }}
                  </time>
                </span>

                <strong class="shelf-title">{{ row.title }}</strong>

                <span v-if="row.state === 'lit'" class="shelf-event">
                  <span class="shelf-event-label">
                    Новое событие<template v-if="eventSource(row)"> · {{ eventSource(row) }}</template>
                  </span>
                  <span class="shelf-event-message">{{ row.message }}</span>
                  <span class="shelf-event-hint">Открытие задачи отметит событие просмотренным</span>
                </span>
                <span v-else class="shelf-waiting">
                  <span>Ожидание</span>
                  {{ row.reasonText }}
                </span>

                <span v-if="row.details?.activities?.length" class="shelf-activities">
                  <span
                    v-for="activity in row.details.activities"
                    :key="activity.kind"
                    class="shelf-activity"
                    :data-tone="activity.tone"
                  >
                    <span class="shelf-activity-label">{{ activity.label }}</span>
                    <span class="shelf-activity-value">{{ activity.value }}</span>
                  </span>
                </span>

                <span v-if="hasFooter(row)" class="shelf-footer">
                  <span v-if="row.details.responsible">{{ row.details.responsible }}</span>
                  <span
                    v-if="row.details.deadline"
                    class="shelf-deadline"
                    :class="{ overdue: row.details.overdue }"
                  >
                    до {{ row.details.deadline }}
                  </span>
                  <span v-if="row.details.unread" class="shelf-unread">
                    {{ unreadLabel(row.details.unread) }}
                  </span>
                </span>
              </span>

              <template #actions>
                <UiIconButton
                  v-if="row.state === 'lit'"
                  label="Отметить событие просмотренным"
                  title="Отметить событие просмотренным"
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
                <UiIconButton
                  label="Убрать с полки"
                  title="Убрать с полки"
                  role="embedded"
                  tone="danger"
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

<script setup>
import { computed, ref } from 'vue';
import { useTaskShelfStore } from '../../stores/task-shelf.js';
import { useUiStore } from '../../stores/ui.js';
import { UiIconButton, UiSelectableRow } from '../../ui';

const SOURCE_LABELS = {
  analysis: 'оценка',
  pipeline: 'конвейер',
  comments: 'комментарии',
  b24: 'Битрикс24',
};

const shelf = useTaskShelfStore();
const ui = useUiStore();
const panel = ref(null);

const groups = computed(() => [
  {
    id: 'attention',
    title: 'Требуют внимания',
    rows: shelf.rows.filter((row) => row.state === 'lit'),
  },
  {
    id: 'waiting',
    title: 'В ожидании',
    rows: shelf.rows.filter((row) => row.state !== 'lit'),
  },
].filter((group) => group.rows.length));

const summaryText = computed(() => {
  if (!shelf.rows.length) return 'Задачи, по которым ждём событие';
  const total = `${shelf.rows.length} ${wordForm(shelf.rows.length, ['задача', 'задачи', 'задач'])}`;
  if (!shelf.litCount) return `${total} под наблюдением`;
  const events = `${shelf.litCount} ${wordForm(shelf.litCount, ['событие', 'события', 'событий'])}`;
  return `${events} · ${total}`;
});

function wordForm(value, forms) {
  const mod100 = Math.abs(value) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 19) return forms[2];
  if (mod10 === 1) return forms[0];
  if (mod10 >= 2 && mod10 <= 4) return forms[1];
  return forms[2];
}

function ageLabel(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'дата неизвестна';
  const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
  if (days === 0) return 'добавлена сегодня';
  return `на полке ${days} ${wordForm(days, ['день', 'дня', 'дней'])}`;
}

function fullDate(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function eventSource(row) {
  return SOURCE_LABELS[row.source] || '';
}

function hasFooter(row) {
  return !!(row.details?.responsible || row.details?.deadline || row.details?.unread);
}

function unreadLabel(value) {
  return `${value} ${wordForm(value, ['непрочитанный', 'непрочитанных', 'непрочитанных'])}`;
}

function rowAriaLabel(row) {
  const event = row.state === 'lit' && row.message ? `, новое событие: ${row.message}` : '';
  return `${row.title}, задача #${row.taskId}${event}`;
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
  display: flex;
  align-items: center;
  min-height: 54px;
  padding: 10px var(--tool-dock-actions-space, 12px) 10px 12px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--ground) 94%, transparent);
  backdrop-filter: blur(12px);
}

.shelf-head h2 {
  margin: 0;
  font-size: 15px;
}

.shelf-head p {
  margin: 2px 0 0;
  color: var(--ink-mid);
  font-size: 11px;
}

.shelf-state {
  margin: 0;
  padding: 18px 14px;
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
  margin: 10px 12px 0;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--warn) 38%, var(--line));
  border-radius: 8px;
  background: color-mix(in srgb, var(--warn) 7%, transparent);
  color: var(--warn);
  font-size: 11px;
  line-height: 1.4;
}

.source-issues svg {
  width: 15px;
  height: 15px;
  flex: none;
  margin-top: 1px;
}

.shelf-empty {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px;
  padding: 18px;
  border: 1px dashed var(--line-2);
  border-radius: 10px;
  color: var(--ink-mid);
}

.shelf-empty-icon {
  color: var(--accent);
  font-size: 24px;
}

.shelf-empty h3 {
  margin: 0;
  color: var(--ink);
  font-size: 13px;
}

.shelf-empty p {
  margin: 3px 0 0;
  font-size: 11px;
  line-height: 1.45;
}

.shelf-groups {
  display: grid;
  gap: 18px;
  padding: 12px;
}

.shelf-group {
  min-width: 0;
}

.shelf-group-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 2px 7px;
}

.shelf-group-head h3 {
  margin: 0;
  color: var(--ink-mid);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .06em;
  text-transform: uppercase;
}

.shelf-group-head span {
  min-width: 18px;
  height: 18px;
  display: inline-grid;
  place-items: center;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--ink-mid);
  font-size: 10px;
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
  gap: 7px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.shelf-list > li {
  min-width: 0;
}

.shelf-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.shelf-meta {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 5px 8px;
  min-width: 0;
  color: var(--ink-mid);
  font-size: 10px;
  line-height: 1.2;
}

.shelf-id {
  color: var(--accent);
  font-weight: 700;
}

.shelf-project {
  grid-column: 2;
  overflow: hidden;
  max-width: none;
  padding-left: 8px;
  border-left: 1px solid var(--line-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shelf-meta time {
  grid-column: 3;
  white-space: nowrap;
}

.shelf-title {
  display: -webkit-box;
  overflow: hidden;
  color: var(--ink);
  font-size: 13px;
  line-height: 1.35;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.shelf-event,
.shelf-waiting {
  padding: 7px 8px;
  border-radius: 7px;
  font-size: 11px;
  line-height: 1.4;
}

.shelf-event {
  display: grid;
  align-items: start;
  gap: 3px;
  border: 1px solid color-mix(in srgb, var(--warn) 38%, transparent);
  background: color-mix(in srgb, var(--warn) 8%, transparent);
}

.shelf-waiting {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 3px 7px;
}

.shelf-event-label,
.shelf-waiting > span {
  color: var(--warn);
  font-size: 9px;
  font-weight: 750;
  letter-spacing: .05em;
  text-transform: uppercase;
}

.shelf-event-message {
  color: var(--warn);
  font-weight: 650;
}

.shelf-event-hint {
  color: var(--ink-mid);
  font-size: 10px;
}

.shelf-waiting {
  padding: 0;
  color: var(--ink-mid);
}

.shelf-waiting > span {
  color: var(--ink-low);
}

.shelf-activities {
  display: grid;
  gap: 5px;
}

.shelf-activity {
  display: grid;
  grid-template-columns: 70px minmax(0, 1fr);
  gap: 8px;
  min-width: 0;
  font-size: 10.5px;
  line-height: 1.35;
}

.shelf-activity-label {
  color: var(--ink-mid);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
}

.shelf-activity-value {
  min-width: 0;
  color: var(--ink-mid);
  overflow-wrap: anywhere;
}

.shelf-activity[data-tone='accent'] .shelf-activity-label {
  color: var(--accent);
}

.shelf-activity[data-tone='good'] .shelf-activity-label {
  color: var(--good);
}

.shelf-activity[data-tone='warn'] .shelf-activity-label {
  color: var(--warn);
}

.shelf-activity[data-tone='bad'] .shelf-activity-label {
  color: var(--bad);
}

.shelf-footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px 9px;
  padding-top: 7px;
  border-top: 1px solid color-mix(in srgb, var(--line) 75%, transparent);
  color: var(--ink-mid);
  font-size: 10px;
}

.shelf-footer > span + span {
  padding-left: 9px;
  border-left: 1px solid var(--line-2);
}

.shelf-deadline.overdue,
.shelf-unread {
  color: var(--bad);
}

@container task-shelf (min-width: 820px) {
  .shelf-groups {
    gap: 14px;
  }

  .shelf-list {
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }

  .shelf-copy {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    grid-template-areas:
      'meta meta signal'
      'title title signal'
      'activities activities activities'
      'footer footer footer';
    gap: 6px 18px;
  }

  .shelf-meta {
    grid-area: meta;
    align-self: end;
  }

  .shelf-title {
    grid-area: title;
    min-height: 2.7em;
  }

  .shelf-event,
  .shelf-waiting {
    grid-area: signal;
    align-self: center;
  }

  .shelf-event {
    align-self: stretch;
    align-content: center;
  }

  .shelf-event-message {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }

  .shelf-event-hint {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .shelf-activities {
    grid-area: activities;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 18px;
    padding-top: 2px;
  }

  .shelf-activity {
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 6px;
  }

  .shelf-activity-value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .shelf-footer {
    grid-area: footer;
  }
}

@container task-shelf (max-width: 430px) {
  .shelf-meta {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .shelf-meta time {
    grid-column: 1 / -1;
    width: 100%;
  }

  .shelf-activity {
    grid-template-columns: minmax(0, 1fr);
    gap: 1px;
  }
}
</style>
