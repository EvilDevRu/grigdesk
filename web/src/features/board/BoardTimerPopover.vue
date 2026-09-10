<template>
  <span v-if="tasks.length" class="board-timers-topbar">
    <UiPopover
      trigger-mode="both"
      focus-policy="none"
      placement="bottom-end"
      :hover-delay="160"
      :style="{ width: 'min(430px, calc(100vw - 20px))' }"
    >
      <template #trigger>
        <UiButton
          data-context="board-timers-topbar"
          variant="ghost"
          :aria-label="`Таймеры задач: активных ${activeCount}, сегодня отработано ${workedToday}`"
        >
          <svg class="board-timers-topbar-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 7.5v4.5l3 2 M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" />
          </svg>
          <span class="board-timers-topbar-count mono">{{ activeCount }}</span>
        </UiButton>
      </template>

      <template #default="{ close }">
        <section class="board-timers-popover" aria-label="Таймеры задач">
          <header class="board-timers-popover-head">
            <strong class="board-timers-popover-titlebar">Таймеры задач</strong>
            <span class="board-timers-popover-summary">
              Активно
              <span class="board-timers-popover-active mono">{{ activeCount }}</span>
              <span aria-hidden="true">·</span>
              сегодня
              <span class="board-timers-popover-today mono">{{ workedToday }}</span>
            </span>
          </header>

          <ul class="board-timers-popover-list">
            <li
              v-for="task in tasks"
              :key="task.id"
              :class="{ paused: !task.timerRunning }"
            >
              <span class="board-timers-popover-row">
                <UiButton
                  data-context="topbar-timer-task"
                  variant="ghost"
                  :title="task.title"
                  @click="openTask(task.id, close)"
                >
                  <span class="board-timers-popover-copy">
                    <span class="board-timers-popover-title">{{ task.title }}</span>
                    <span class="board-timers-popover-meta">
                      <span class="mono">#{{ task.id }}</span>
                      <span v-if="task.group" class="board-timers-popover-project">
                        {{ task.group }}
                      </span>
                    </span>
                  </span>
                  <span class="board-timers-popover-time mono">
                    {{ elapsed(task) }}
                  </span>
                </UiButton>
                <UiIconButton
                  data-context="topbar-timer-toggle"
                  role="embedded"
                  :tone="task.timerRunning ? 'warning' : 'success'"
                  :label="timerActionLabel(task)"
                  :title="timerActionLabel(task)"
                  :loading="isTimerBusy(task)"
                  :disabled="timerControlsBusy"
                  @click="emit('toggleTimer', task)"
                >
                  <svg
                    v-if="task.timerRunning"
                    class="board-timers-popover-action-icon"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path d="M9 7v10M15 7v10" />
                  </svg>
                  <svg
                    v-else
                    class="board-timers-popover-action-icon play"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path d="m9 7 8 5-8 5V7z" />
                  </svg>
                </UiIconButton>
              </span>
            </li>
          </ul>

          <UiInlineMessage v-if="error" tone="danger">
            {{ error }}
          </UiInlineMessage>

          <span class="board-timers-popover-footer">
            <UiButton
              block
              data-context="topbar-popover-footer"
              variant="outline"
              @click="openBoard(close)"
            >
              Открыть доску
            </UiButton>
          </span>
        </section>
      </template>
    </UiPopover>
  </span>
</template>

<script setup>
import { computed, onUnmounted, ref } from 'vue';

import { hoursToHM, liveTimerSec, secToHMS } from '../../shared/format.ts';
import { UiButton, UiIconButton, UiInlineMessage, UiPopover } from '../../ui';

const props = defineProps({
  tasks: {
    type: Array,
    default: () => [],
  },
  busyTaskId: {
    type: [String, Number],
    default: null,
  },
  error: {
    type: String,
    default: '',
  },
  workedTodayHours: {
    type: [Number, String],
    default: 0,
  },
});

const emit = defineEmits(['openTask', 'openBoard', 'toggleTimer']);
const now = ref(Date.now());
const activeCount = computed(() => props.tasks.filter((task) => task.timerRunning).length);
const workedToday = computed(() => hoursToHM(props.workedTodayHours));
const timerControlsBusy = computed(() => props.busyTaskId !== null);
const ticker = setInterval(() => {
  now.value = Date.now();
}, 1000);
ticker.unref?.();

const elapsed = (task) => secToHMS(liveTimerSec(task, now.value));
const isTimerBusy = (task) => String(props.busyTaskId) === String(task.id);
const timerActionLabel = (task) => (
  task.timerRunning
    ? `Поставить таймер задачи #${task.id} на паузу`
    : `Запустить таймер задачи #${task.id}`
);

function openTask(taskId, close) {
  close('action');
  emit('openTask', taskId);
}

function openBoard(close) {
  close('action');
  emit('openBoard');
}

onUnmounted(() => clearInterval(ticker));
</script>

<style scoped>
.board-timers-topbar {
  display: inline-flex;
  align-items: center;
  line-height: normal;
}
.board-timers-topbar-icon {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: var(--good);
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.board-timers-topbar-count {
  color: var(--ink);
  font-size: 11px;
  font-weight: 750;
}
.board-timers-popover {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  min-width: 0;
}
.board-timers-popover-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}
.board-timers-popover-titlebar {
  flex: none;
  color: var(--ink);
  font-size: 13px;
  white-space: nowrap;
}
.board-timers-popover-summary {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
  color: var(--ink-mid);
  font-size: 10.5px;
  white-space: nowrap;
}
.board-timers-popover-active {
  color: var(--good);
  font-weight: 750;
}
.board-timers-popover-today {
  color: var(--accent);
  font-weight: 650;
}
.board-timers-popover-list {
  max-height: min(48vh, 360px);
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 2px 0;
  border-block: 1px solid var(--line);
}
.board-timers-popover-list li + li {
  border-top: 1px solid color-mix(in srgb, var(--line) 62%, transparent);
}
.board-timers-popover-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.board-timers-popover-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.board-timers-popover-title {
  overflow: hidden;
  color: var(--ink);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.board-timers-popover-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--ink-mid);
  font-size: 9.5px;
}
.board-timers-popover-project {
  overflow: hidden;
  padding-left: 6px;
  border-left: 1px solid var(--line-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.board-timers-popover-time {
  flex: none;
  color: var(--accent);
  font-size: 12px;
  font-weight: 650;
  white-space: nowrap;
}
.board-timers-popover-list li.paused .board-timers-popover-time {
  color: var(--ink-mid);
}
.board-timers-popover-action-icon {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.board-timers-popover-action-icon.play {
  fill: currentColor;
  stroke: none;
}
.board-timers-popover-footer {
  display: flex;
}
</style>
