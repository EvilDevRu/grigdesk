<template>
  <span v-if="total" class="pipeline-topbar-wrap">
    <UiPopover
      trigger-mode="both"
      focus-policy="none"
      placement="bottom-end"
      :hover-delay="160"
      :style="{ width: 'min(360px, calc(100vw - 20px))' }"
    >
      <template #trigger>
        <UiButton
          data-context="pipeline-topbar"
          variant="ghost"
          :aria-label="triggerLabel"
        >
          <svg class="pipeline-topbar-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path :d="icon" />
          </svg>
          <span class="pipeline-topbar-counts mono" aria-hidden="true">
            <span class="pipeline-topbar-total">{{ total }}</span>
            <span class="pipeline-topbar-slash">/</span>
            <span class="pipeline-topbar-running">{{ runningCount }}</span>
            <span class="pipeline-topbar-slash">/</span>
            <span class="pipeline-topbar-stopped" :class="{ error: hasErrors }">
              {{ stoppedCount }}
            </span>
          </span>
        </UiButton>
      </template>

      <template #default="{ close }">
        <section class="pipeline-topbar-popover" aria-label="Активные конвейеры">
          <header class="pipeline-topbar-popover-head">
            <span class="pipeline-topbar-popover-heading">
              <strong>Конвейеры</strong>
              <small>Активны сейчас</small>
            </span>
            <span
              class="pipeline-topbar-popover-count mono"
              :aria-label="`Активных конвейеров: ${total}`"
            >
              {{ total }}
            </span>
          </header>

          <dl class="pipeline-topbar-popover-summary" aria-label="Сводка по состояниям">
            <div class="running">
              <dt>В работе</dt>
              <dd class="mono">{{ runningCount }}</dd>
            </div>
            <div class="waiting">
              <dt>Ждут решения</dt>
              <dd class="mono" :class="{ empty: !waitingCount }">{{ waitingCount }}</dd>
            </div>
            <div class="error">
              <dt>Проблемы</dt>
              <dd class="mono" :class="{ empty: !issueCount }">{{ issueCount }}</dd>
            </div>
          </dl>

          <div v-if="aggregateProgress" class="pipeline-topbar-popover-progress">
            <span class="pipeline-topbar-popover-progress-copy">
              <span>{{ progressLabel }}</span>
              <small v-if="aggregateProgress.observed < total">
                По {{ aggregateProgress.observed }} из {{ total }} конвейеров
              </small>
            </span>
            <strong class="mono">
              {{ aggregateProgress.done }} / {{ aggregateProgress.total }}
            </strong>
          </div>

          <section
            v-if="attentionItems.length"
            class="pipeline-topbar-popover-attention"
            aria-label="Конвейеры, требующие внимания"
          >
            <header class="pipeline-topbar-popover-attention-head">
              <strong>Требуют внимания</strong>
              <span class="mono" :class="{ error: issueCount }">
                {{ attentionItems.length }}
              </span>
            </header>

            <ul class="pipeline-topbar-popover-list">
              <li
                v-for="item in visibleAttentionItems"
                :key="item.task"
                :data-task-id="item.task"
                :data-state="item.kind"
              >
                <span class="pipeline-topbar-popover-copy">
                  <span class="pipeline-topbar-popover-title" :title="item.title">
                    <span class="mono">#{{ item.task }}</span>
                    <span>{{ item.title || 'Без названия' }}</span>
                  </span>
                  <span class="pipeline-topbar-popover-meta">
                    <span class="pipeline-topbar-popover-state" :class="item.kind">
                      {{ item.stateLabel }}
                    </span>
                    <span
                      v-if="item.detail || item.stage"
                      class="pipeline-topbar-popover-detail"
                      :title="item.detail || item.stage"
                    >
                      {{ item.detail || item.stage }}
                    </span>
                  </span>
                </span>
              </li>
            </ul>

            <small v-if="hiddenAttentionCount" class="pipeline-topbar-popover-more">
              И ещё {{ hiddenAttentionCount }}
            </small>
          </section>

          <div v-else class="pipeline-topbar-popover-ok">
            <strong>Все конвейеры работают</strong>
            <small>Сейчас ничего не требует вашего решения.</small>
          </div>

          <UiInlineMessage v-if="error" tone="warning">
            Состояние может быть устаревшим: {{ error }}
          </UiInlineMessage>

          <span class="pipeline-topbar-popover-footer">
            <UiButton
              block
              data-context="topbar-popover-footer"
              variant="outline"
              @click="openPipeline(close)"
            >
              Открыть конвейер
            </UiButton>
          </span>
        </section>
      </template>
    </UiPopover>
  </span>
</template>

<script setup>
import { computed } from 'vue';

import { UiButton, UiInlineMessage, UiPopover } from '../../ui';

const ATTENTION_LIMIT = 3;

const props = defineProps({
  items: {
    type: Array,
    default: () => [],
  },
  total: {
    type: Number,
    default: 0,
  },
  runningCount: {
    type: Number,
    default: 0,
  },
  stoppedCount: {
    type: Number,
    default: 0,
  },
  hasErrors: {
    type: Boolean,
    default: false,
  },
  error: {
    type: String,
    default: '',
  },
  icon: {
    type: String,
    required: true,
  },
});

const emit = defineEmits(['openPipeline']);
const triggerLabel = computed(() => (
  `Конвейеры: всего ${props.total}, едут ${props.runningCount}, стоят ${props.stoppedCount}`
));
const attentionItems = computed(() => props.items.filter((item) => item.kind !== 'running'));
const visibleAttentionItems = computed(() => attentionItems.value.slice(0, ATTENTION_LIMIT));
const hiddenAttentionCount = computed(() => (
  Math.max(0, attentionItems.value.length - visibleAttentionItems.value.length)
));
const waitingCount = computed(() => (
  attentionItems.value.filter((item) => item.kind === 'waiting').length
));
const issueCount = computed(() => (
  attentionItems.value.filter((item) => item.kind === 'error').length
));
const aggregateProgress = computed(() => {
  let done = 0;
  let total = 0;
  let observed = 0;

  for (const item of props.items) {
    const progressDone = item.progress?.done;
    const progressTotal = item.progress?.total;
    const valid = Number.isSafeInteger(progressDone)
      && Number.isSafeInteger(progressTotal)
      && progressDone >= 0
      && progressTotal >= 0;

    if (!valid) {
      continue;
    }

    done += progressDone;
    total += progressTotal;
    observed += 1;
  }

  return observed ? { done, total, observed } : null;
});
const progressLabel = computed(() => (
  aggregateProgress.value?.observed === props.total
    ? 'Этапы выполнены'
    : 'Известный прогресс'
));

function openPipeline(close) {
  close('action');
  emit('openPipeline');
}
</script>

<style scoped>
.pipeline-topbar-wrap {
  display: inline-flex;
  align-items: center;
  line-height: normal;
}
.pipeline-topbar-icon {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.pipeline-topbar-counts {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
  font-size: 11px;
  font-weight: 750;
}
.pipeline-topbar-total {
  color: var(--ink);
}
.pipeline-topbar-slash {
  color: var(--ink-mid);
  font-weight: 500;
}
.pipeline-topbar-running {
  color: var(--accent);
}
.pipeline-topbar-stopped {
  color: var(--warn);
}
.pipeline-topbar-stopped.error {
  color: var(--bad);
}
.pipeline-topbar-popover {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  min-width: 0;
}
.pipeline-topbar-popover-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.pipeline-topbar-popover-heading {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.pipeline-topbar-popover-heading strong {
  color: var(--ink);
  font-size: 13px;
}
.pipeline-topbar-popover-heading small {
  color: var(--ink-mid);
  font-size: 10.5px;
}
.pipeline-topbar-popover-count {
  min-width: 24px;
  height: 24px;
  display: inline-grid;
  place-items: center;
  flex: none;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  color: var(--accent);
  font-size: 11px;
  font-weight: 750;
}
.pipeline-topbar-popover-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  margin: 0;
}
.pipeline-topbar-popover-summary > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
  padding: 9px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-2);
}
.pipeline-topbar-popover-summary dt {
  overflow: hidden;
  color: var(--ink-mid);
  font-size: 9.5px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pipeline-topbar-popover-summary dd {
  margin: 0;
  font-size: 16px;
  font-weight: 750;
}
.pipeline-topbar-popover-summary .running dd {
  color: var(--accent);
}
.pipeline-topbar-popover-summary .waiting dd {
  color: var(--warn);
}
.pipeline-topbar-popover-summary .error dd {
  color: var(--bad);
}
.pipeline-topbar-popover-summary dd.empty {
  color: var(--ink-mid);
}
.pipeline-topbar-popover-progress {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 10px;
  border-block: 1px solid var(--line);
}
.pipeline-topbar-popover-progress-copy {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
  color: var(--ink-mid);
  font-size: 10.5px;
}
.pipeline-topbar-popover-progress-copy small {
  font-size: 9.5px;
}
.pipeline-topbar-popover-progress strong {
  color: var(--ink);
  font-size: 12px;
}
.pipeline-topbar-popover-attention {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
}
.pipeline-topbar-popover-attention-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--ink-mid);
  font-size: 10.5px;
}
.pipeline-topbar-popover-attention-head strong {
  color: var(--ink);
  font-weight: 650;
}
.pipeline-topbar-popover-attention-head span {
  color: var(--warn);
}
.pipeline-topbar-popover-attention-head span.error {
  color: var(--bad);
}
.pipeline-topbar-popover-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border-block: 1px solid var(--line);
}
.pipeline-topbar-popover-list li {
  display: flex;
  min-width: 0;
  padding: 7px 5px;
}
.pipeline-topbar-popover-list li + li {
  border-top: 1px solid color-mix(in srgb, var(--line) 62%, transparent);
}
.pipeline-topbar-popover-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.pipeline-topbar-popover-title {
  display: flex;
  gap: 5px;
  overflow: hidden;
  color: var(--ink);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pipeline-topbar-popover-title .mono {
  flex: none;
}
.pipeline-topbar-popover-title > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
}
.pipeline-topbar-popover-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: var(--ink-mid);
  font-size: 9.5px;
}
.pipeline-topbar-popover-state {
  flex: none;
  font-weight: 650;
}
.pipeline-topbar-popover-state.running {
  color: var(--accent);
}
.pipeline-topbar-popover-state.waiting {
  color: var(--warn);
}
.pipeline-topbar-popover-state.error {
  color: var(--bad);
}
.pipeline-topbar-popover-detail {
  overflow: hidden;
  color: var(--ink-mid);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pipeline-topbar-popover-more {
  color: var(--ink-mid);
  font-size: 9.5px;
  text-align: right;
}
.pipeline-topbar-popover-ok {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--good) 32%, var(--line));
  border-radius: 7px;
  background: color-mix(in srgb, var(--good) 6%, var(--surface));
}
.pipeline-topbar-popover-ok strong {
  color: var(--good);
  font-size: 11px;
}
.pipeline-topbar-popover-ok small {
  color: var(--ink-mid);
  font-size: 9.5px;
}
.pipeline-topbar-popover-footer {
  display: flex;
}
</style>
