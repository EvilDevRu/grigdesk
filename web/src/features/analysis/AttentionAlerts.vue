<template>
  <UiTopbarPanel
    v-if="items.length"
    :title="t('core.interruptedEvaluations')"
    trigger-mode="both"
  >
    <template #trigger>
      <UiButton
        data-context="analysis-attention-topbar"
        variant="link"
        tone="warning"
        size="compact"
        :aria-label="t('core.needAttention2', { itemsLength: items.length })"
      >
        <template #leading>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path
              d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"
            />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </template>

        <span class="mono">{{ items.length }}</span>
        <span class="topbar-status-label">{{ t('core.interruptedEvaluations') }}</span>
      </UiButton>
    </template>

    <div class="attention-alerts">
      <p class="attention-description">
        {{ t('core.triageEvaluationsInterruptedManualRestartOnly') }}
      </p>

      <ul class="attention-list">
        <li
          v-for="item in items"
          :key="item.task"
          class="attention-row"
        >
          <span class="attention-copy">
            <b class="attention-task mono">#{{ item.task }}</b>
            <span class="attention-reason">{{ item.reason }}</span>
          </span>

          <span class="attention-actions">
            <UiIconButton
              :label="t('core.restartEvaluation', { itemTask: item.task })"
              v-tooltip="t('core.restartEvaluation2')"
              role="embedded"
              :disabled="busy === item.task"
              @click="restart(item.task)"
            >
<UiRefreshIcon />
            </UiIconButton>
            <UiIconButton
              :label="t('core.hideEvaluation', { itemTask: item.task })"
              v-tooltip="t('core.hideDoNotRestart')"
              role="embedded"
              :disabled="busy === item.task"
              @click="dismiss(item.task)"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </UiIconButton>
          </span>
        </li>
      </ul>
    </div>

    <template #footer>
      <UiFormActions align="start">
        <UiButton
          v-if="items.length > 1"
          variant="text"
          tone="accent"
          size="compact"
          :loading="busy === 'all'"
          :loading-label="t('core.starting')"
          @click="restartAll"
        >
          {{ t('core.restartAll') }}{{ items.length }})
        </UiButton>
        <UiButton
          variant="text"
          size="compact"
          :disabled="busy === 'all'"
          @click="dismissAll"
        >
          {{ t('core.dismissAll') }}
        </UiButton>
      </UiFormActions>
    </template>
  </UiTopbarPanel>
</template>

<script setup lang="ts">
import { t } from '../../ui.ts';

import { computed, ref } from 'vue';
import {
  analyzeTask,
  dismissAnalysis,
  startAnalysisPolling,
  useAnalysisStore,
} from '../../actions/analysis';
import {
  UiRefreshIcon,
  UiButton,
  UiFormActions,
  UiIconButton,
  UiTopbarPanel,
  vTooltip,
} from '../../ui';

const analysis = useAnalysisStore();

// Шапка живёт на всех экранах, а запуск опроса идемпотентен.
if (!analysis.disabled) {
  startAnalysisPolling();
}

const busy = ref<string | number | null>(null);
const items = computed(() => (analysis.disabled ? [] : analysis.issues).map((issue) => ({
  task: issue.task,
  reason: issue.status?.error || (
    issue.status?.state === 'interrupted' ? t('core.interrupted') : t('core.failed')
  ),
})));

/**
 * Busy привязан к task id, чтобы обе конфликтующие операции конкретной строки
 * оставались недоступны до завершения запроса.
 */
async function restart(id: number) {
  busy.value = id;

  try {
    await analyzeTask(id);
  } finally {
    busy.value = null;
  }
}

/**
 * Скрытие использует тот же row-lock, что и перезапуск: повторный клик не должен
 * отправить конкурирующую команду для одной оценки.
 */
async function dismiss(id: number) {
  busy.value = id;

  try {
    await dismissAnalysis(id);
  } finally {
    busy.value = null;
  }
}

/**
 * Массовый перезапуск намеренно последовательный: store и сервер получают
 * предсказуемый порядок задач, а единый busy закрывает обе batch-команды.
 */
async function restartAll() {
  busy.value = 'all';

  try {
    for (const item of items.value) {
      await analyzeTask(item.task);
    }
  } finally {
    busy.value = null;
  }
}

/**
 * Массовое скрытие повторяет последовательную семантику старого интерфейса,
 * чтобы частичный сбой не запускал остальные запросы параллельно.
 */
async function dismissAll() {
  busy.value = 'all';

  try {
    for (const item of items.value) {
      await dismissAnalysis(item.task);
    }
  } finally {
    busy.value = null;
  }
}
</script>

<style scoped>
.attention-alerts {
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
  text-align: left;
}

.attention-description {
  margin: 0;
  color: var(--ink-mid);
}

.attention-list {
  display: flex;
  flex-direction: column;
  max-height: 45vh;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.attention-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 9px 0;
}

.attention-row + .attention-row {
  border-top: 1px solid var(--line);
}

.attention-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.attention-task {
  font-size: 12px;
  font-weight: 500;
}

.attention-reason {
  min-width: 0;
  color: var(--ink-mid);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.attention-actions {
  display: inline-flex;
  flex: none;
  gap: 2px;
}
</style>
