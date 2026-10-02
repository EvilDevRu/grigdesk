<template>
  <div class="chat-status" data-role="chat-status">
    <div class="chat-status__row">
      <div class="chat-status__activity">
        <ChatThinking v-if="status.thinking" :key="status.runKey"
                      :steps="steps" :tokens="tokens" :tokens-estimate="tokensEstimate"
                      :started-at="startedAt" />
        <span v-else class="chat-status__phase">
          <UiSpinner v-if="status.phase === 'compact'" decorative />
          {{ status.phaseLabel }}
        </span>
      </div>
      <div v-if="status.phase !== 'compact'" class="chat-status__summary"
           data-role="chat-status-summary" :title="fullSummary">
        <span class="chat-status__facts">
          <span class="chat-status__model" data-role="chat-status-model">
            <span v-if="status.modelKind" class="chat-status__kind" aria-hidden="true">
              {{ shortModelKind }}
            </span>
            <span class="chat-status__value">{{ status.modelLabel || 'Модель не выбрана' }}</span>
          </span>
          <span class="chat-status__sep" aria-hidden="true">·</span>
          <span class="chat-status__cwd" data-role="chat-status-cwd">{{ status.cwdLabel }}</span>
          <span v-if="usageItems.length" class="chat-status__sep" aria-hidden="true">·</span>
          <span v-if="usageItems.length" class="chat-status__usage" :class="[usage.tone, 'windows']"
                data-role="chat-status-usage">
            <template v-for="(item, index) in usageItems.slice(0, 2)" :key="item.key">
              <span v-if="index" class="chat-status__sep secondary" aria-hidden="true">·</span>
              <span class="chat-status__item" :class="{ secondary: index === 1 }">
                <span class="chat-status__value">{{ item.label }}:</span>
                <span>{{ item.value }}</span>
              </span>
            </template>
            <span v-if="usageItems.length > 1" class="chat-status__more narrow">
              +{{ usageItems.length - 1 }}
            </span>
            <span v-if="usageItems.length > 2" class="chat-status__more wide">
              +{{ usageItems.length - 2 }}
            </span>
            <span v-if="usage.stale" class="chat-status__stale">устарели</span>
          </span>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { UiSpinner } from '../../ui';
import type { UsageSummary } from '../../features/providers/providerUsageSummary.ts';
import type { ChatStatus } from './chatStatus.ts';
import ChatThinking from './ChatThinking.vue';

const props = withDefaults(defineProps<{
  chatKey: string;
  status: ChatStatus;
  usage: UsageSummary;
  steps?: unknown[];
  tokens?: number;
  tokensEstimate?: boolean;
  startedAt?: number;
}>(), {
  steps: () => [],
  tokens: 0,
  tokensEstimate: false,
  startedAt: 0,
});

const shortModelKind = computed(() => ({
  выбрана: 'выбр.',
  запрошена: 'запр.',
  сообщена: '',
} as Record<string, string>)[props.status.modelKind] || '');
const usageItems = computed(() => props.usage.label
  ? []
  : props.usage.items.filter((item) => item.value !== 'нет данных'));
const fullSummary = computed(() => [
  `${props.status.modelKind} ${props.status.modelLabel}`.trim(),
  props.status.cwd || props.status.cwdLabel,
  props.status.extraDirs.length ? `Дополнительные каталоги: ${props.status.extraDirs.join(', ')}` : '',
  usageItems.value.map((item) => `${item.label}: ${item.value}`).join(' · '),
  usageItems.value.length && props.usage.stale ? 'Данные устарели' : '',
].filter(Boolean).join(' · '));
</script>

<style scoped>
.chat-status {
  --chat-status-font-size: 13px;
  container: chat-status / inline-size;
  min-width: 0;
  font-size: var(--chat-status-font-size);
  line-height: 1.4;
  color: var(--ink-mid);
  font-variant-numeric: tabular-nums;
}
.chat-status__row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
}
.chat-status__activity {
  flex: 0 0 auto;
  min-width: 0;
  max-width: calc(100% - min(6em, 32%) - 12px);
}
.chat-status__activity :deep(.said) {
  flex: 0 1 auto;
  min-width: 0;
  width: 12em;
}
.chat-status__summary {
  color: color-mix(in srgb, var(--ink-low) 88%, var(--surface));
  flex: 0 1 auto;
  min-width: 0;
  max-width: 58%;
  margin-left: auto;
}
.chat-status__phase {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 2px 5px;
  white-space: nowrap;
}
.chat-status__facts {
  display: flex;
  justify-content: flex-end;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  min-width: 0;
  text-align: left;
}
.chat-status__model {
  display: flex;
  align-items: baseline;
  flex: 0 1 auto;
  gap: 4px;
  min-width: 0;
}
.chat-status__kind { display: none; }
.chat-status__cwd {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-status__usage {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
}
.chat-status__item { display: flex; align-items: baseline; gap: 3px; min-width: 0; }
.chat-status__value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-status__sep, .chat-status__more, .chat-status__stale { flex: none; }
.chat-status__sep { color: inherit; }
.chat-status__usage.muted { color: inherit; }
.chat-status__usage.warn { color: var(--warn); }
.chat-status__usage.bad { color: var(--bad); }
.chat-status__item.secondary, .chat-status__sep.secondary, .chat-status__more.wide { display: none; }

@container chat-status (max-width: 480px) {
  /* Место уступают подписи и декоративные точки: время и число токенов остаются целыми.
     Полные модель, путь и окна лимитов доступны в текстовой подсказке строки. */
  .chat-status__row { gap: 8px; }
  .chat-status__activity { max-width: calc(100% - min(8em, 38%) - 8px); }
  .chat-status__facts { gap: 2px; }
  .chat-status__model, .chat-status__cwd { min-width: 12px; }
  .chat-status__usage { gap: 4px; }
  .chat-status__usage.windows { flex-shrink: 0; }
  .chat-status__item > .chat-status__value { display: none; }
  .chat-status__activity :deep(.think) { gap: 5px; }
  .chat-status__activity :deep(.fact) { margin-left: 0; }
  .chat-status__activity :deep(.dots) { display: none; }
  .chat-status__activity :deep(.tok-unit) { display: none; }
}
@container chat-status (min-width: 640px) {
  .chat-status__kind { display: inline; flex: none; }
}
@container chat-status (min-width: 900px) {
  .chat-status__item.secondary { display: flex; }
  .chat-status__sep.secondary { display: inline; }
  .chat-status__more.wide { display: inline; }
  .chat-status__more.narrow { display: none; }
}
</style>
