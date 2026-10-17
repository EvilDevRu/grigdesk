<template>
  <UiTopbarPanel
    title="Оповещения"
    trigger-mode="click"
    @open="onOpen"
    @close="onClose"
  >
    <template #trigger>
      <UiIconButton
        class="alert-bell"
        data-context="alert-history"
        role="rail"
        :label="triggerLabel"
        v-tooltip="'История оповещений'"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
             stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path :d="BELL_ICON" />
        </svg>
        <span v-if="missedCount" class="alert-bell-badge mono" aria-hidden="true">
          {{ missedCount > 99 ? '99+' : missedCount }}
        </span>
      </UiIconButton>
    </template>

    <template #actions>
      <UiButton
        v-if="entries.length"
        data-context="toast-action"
        variant="text"
        @click="clearAlertHistory()"
      >
        Очистить
      </UiButton>
    </template>

    <template #default="{ close }">
      <section class="alert-history" aria-label="История оповещений">
        <p v-if="!entries.length" class="alert-history-empty">
          Пока пусто. Здесь собираются оповещения этого окна, в том числе ушедшие сами.
        </p>

        <ol v-else class="alert-history-list">
          <li
            v-for="entry in entries"
            :key="entry.key"
            class="alert-history-row"
            :data-tone="entry.tone"
            :data-state="entry.state"
            :data-fresh="fresh.has(entry.key) ? '' : undefined"
          >
            <span class="alert-history-dot" aria-hidden="true"></span>
            <span class="alert-history-text">
              <span class="alert-history-title">{{ entry.title }}</span>
              <span v-if="entry.body" class="alert-history-body">{{ entry.body }}</span>
              <span class="alert-history-meta">
                {{ timeLabel(entry.at) }}
                <template v-if="stateLabel(entry)"> · {{ stateLabel(entry) }}</template>
              </span>
            </span>
            <UiButton
              v-if="entry.target"
              data-context="toast-action"
              variant="text"
              @click="open(entry.key, close)"
            >
              Открыть
            </UiButton>
          </li>
        </ol>
      </section>
    </template>
  </UiTopbarPanel>
</template>

<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  shallowRef,
} from 'vue';
import { UiButton, UiIconButton, UiTopbarPanel, vTooltip } from '../../ui';
import {
  clearAlertHistory,
  markAlertHistorySeen,
  openAlertHistoryEntry,
  subscribeAlertHistory,
} from '../../shared/alerts.ts';
import type { AlertHistoryEntry } from '../../shared/alertHistory.ts';

const BELL_ICON = 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0';

const entries = shallowRef<readonly AlertHistoryEntry[]>([]);
const fresh = shallowRef<ReadonlySet<string>>(new Set());
let unsubscribe: (() => void) | undefined;

const missedCount = computed(() => entries.value.filter((entry) => entry.state === 'missed').length);
const triggerLabel = computed(() => (missedCount.value
  ? `История оповещений, пропущено: ${missedCount.value}`
  : 'История оповещений'));

/**
 * Открытая история значит «посмотрел»: пропущенные перестают считаться в значке.
 * Их ключи запоминаются до закрытия, чтобы в списке было видно, что именно проехало мимо.
 */
function onOpen(): void {
  fresh.value = new Set(entries.value
    .filter((entry) => entry.state === 'missed')
    .map((entry) => entry.key));
  markAlertHistorySeen();
}

function onClose(): void {
  fresh.value = new Set();
}

function open(key: string, close: () => void): void {
  if (openAlertHistoryEntry(key)) {
    close();
  }
}

/**
 * Свежие события — относительным временем, старые — часами, вчерашние и раньше — с датой:
 * история живёт до перезагрузки окна и может пережить полночь.
 */
function timeLabel(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000);

  if (minutes < 1) {
    return 'только что';
  }
  if (minutes < 60) {
    return `${minutes} мин назад`;
  }

  const date = new Date(at);
  const time = date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });

  if (date.toDateString() === new Date().toDateString()) {
    return time;
  }

  return `${date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
  })}, ${time}`;
}

/**
 * Подпись состояния: пропущенное выделяется, разобранное приглушается, просмотренное
 * без подписи — это обычная запись истории.
 */
function stateLabel(entry: AlertHistoryEntry): string {
  if (fresh.value.has(entry.key)) {
    return 'пропущено';
  }
  if (entry.state === 'live') {
    return 'на экране';
  }
  if (entry.state === 'resolved') {
    return 'разобрано';
  }

  return '';
}

onMounted(() => {
  unsubscribe = subscribeAlertHistory((snapshot) => {
    entries.value = snapshot;
  });
});

onBeforeUnmount(() => {
  unsubscribe?.();
});
</script>

<style scoped>
.alert-bell {
  position: relative;
}

.alert-bell-badge {
  position: absolute;
  top: -3px;
  right: -4px;
  min-width: 15px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--warn);
  color: var(--ground);
  font-size: 9.5px;
  font-weight: 700;
  line-height: 15px;
  text-align: center;
}

.alert-history {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.alert-history-empty {
  margin: 0;
  padding: 10px 6px 12px;
  color: var(--ink-mid);
  font-size: 12px;
}

.alert-history-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: min(420px, calc(100dvh - 140px));
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.alert-history-row {
  --row-tone: var(--accent);
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  column-gap: 9px;
  align-items: start;
  padding: 7px 4px 7px 6px;
}

.alert-history-row[data-tone='warning'] {
  --row-tone: var(--warn);
}

.alert-history-row[data-tone='danger'] {
  --row-tone: var(--bad);
}

.alert-history-row[data-fresh] {
  background: color-mix(in srgb, var(--row-tone) 9%, transparent);
}

.alert-history-dot {
  width: 8px;
  height: 8px;
  margin-top: 4px;
  border-radius: 50%;
  background: var(--row-tone);
}

.alert-history-row[data-state='seen'] .alert-history-dot,
.alert-history-row[data-state='resolved'] .alert-history-dot {
  opacity: 0.4;
}

.alert-history-row[data-fresh] .alert-history-dot {
  opacity: 1;
}

.alert-history-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.alert-history-title {
  font-size: 12.5px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.alert-history-row[data-state='resolved'] .alert-history-title {
  color: var(--ink-mid);
  font-weight: 500;
}

.alert-history-body {
  display: -webkit-box;
  overflow: hidden;
  color: var(--ink-mid);
  font-size: 12px;
  overflow-wrap: anywhere;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.alert-history-meta {
  color: var(--ink-mid);
  font-size: 11px;
  opacity: 0.8;
}

.alert-history-row[data-fresh] .alert-history-meta {
  color: var(--row-tone);
  opacity: 1;
}
</style>
