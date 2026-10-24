<template>
  <div
    v-if="view"
    class="stalled"
    :class="{ 'stop-collapsed': collapsed }"
    :role="arbitrating ? 'status' : 'alert'"
  >
    <div class="stop-heading">
      <span class="stop-title" v-tooltip="`${view.nodeLabel} — ${view.reason}`">
        <strong class="stop-node">{{ view.nodeLabel }}</strong> — {{ view.reason }}
      </span>
      <span class="stop-metrics">
        <span v-if="view.attempts != null" class="stop-tag">
          {{ metricLabel(view.attempts, 'attempts') }}
        </span>
        <span v-if="view.returns != null" class="stop-tag">
          {{ metricLabel(view.returns, 'returns') }}
        </span>
      <span v-if="view.fails != null" class="stop-tag">{{ view.fails }} сбоев</span>
      <span v-if="view.lastFailure" class="stop-tag stop-failure" v-tooltip="view.lastFailure">
        {{ view.lastFailure }}
      </span>
      <span v-if="view.model" class="stop-tag stop-model mono" v-tooltip="view.model">{{ view.model }}</span>
      </span>
      <span v-if="arbitrating" class="sarbrun" v-tooltip="arbiterRunLabel(arbitrating)">
        Арбитр разбирает остановку · {{ arbiterRunLabel(arbitrating) }}
      </span>
      <span v-else-if="arbiterNote" class="sarbnote" :class="arbiterVerdict" v-tooltip="arbiterModel">
        ⚖ {{ arbiterNote }}<span v-if="arbiterModel" class="samodel mono"> · {{ arbiterModel }}</span>
      </span>
    </div>
    <div v-if="!collapsed" class="stop-summary">
      <span v-tooltip="view.summary">{{ view.summary }}</span>
      <UiDisclosureButton
        v-model:open="open"
        class="stop-disclosure"
        :controls="detailsId"
        density="compact"
        tone="accent"
      >
        подробнее
      </UiDisclosureButton>
    </div>
    <slot />
    <dl v-if="open && !collapsed" :id="detailsId" class="stop-details">
      <template v-for="shelf in shelves" :key="shelf.key">
        <dt>{{ shelf.label }}</dt>
        <dd>{{ shelf.text }}</dd>
      </template>
    </dl>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import type { ArbiterRun } from '../../../../shared/pipeline/factoryGraphContracts.ts';
import { arbiterRunLabel } from '../../shared/arbiterRun.ts';
import type { GraphStallView } from '../../shared/graphStall.ts';
import { UiDisclosureButton, vTooltip } from '../../ui';

const props = defineProps<{
  view: GraphStallView | null;
  identity?: string | number;
  collapsed?: boolean;
  arbitrating?: ArbiterRun | null;
  arbiterNote?: string;
  arbiterModel?: string | null;
  arbiterVerdict?: string;
}>();

const metricPluralRules = new Intl.PluralRules('ru');
const metricNouns = {
  attempts: ['заход', 'захода', 'заходов'],
  returns: ['возврат', 'возврата', 'возвратов'],
} as const;

const open = ref(false);
const detailsId = `pipeline-stop-${useId()}`;
const shelfLabels = [
  ['what', 'Что случилось'],
  ['cause', 'Возможная причина'],
  ['retained', 'Что уцелело'],
  ['action', 'Что делать'],
] as const;

const shelves = computed(() => shelfLabels.map(([key, label]) => ({
  key,
  label,
  text: props.view?.details[key],
})).filter((shelf) => shelf.text?.trim()));

/**
 * Склоняет короткие метки остановки по русским правилам, включая 11–14 и 21.
 * Формы выбирает стандартный Intl; тексты немигрировавшего раздела остаются русскими.
 */
function metricLabel(count: number, kind: keyof typeof metricNouns): string {
  const category = metricPluralRules.select(count);
  const word = metricNouns[kind][category === 'one' ? 0 : category === 'few' ? 1 : 2];

  return `${count} ${word}`;
}

// Родитель создаёт новый view при обновлении таймера; сравниваем значения источников.
// Подробности закрываются при смене задачи или остановки, а не ссылки на объект.
watch(
  [
    () => props.identity,
    () => props.view?.title,
    () => props.view?.stage,
    () => JSON.stringify(props.view?.details),
  ],
  () => {
    open.value = false;
  },
);
</script>

<style scoped>
.stalled {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  margin-top: 6px;
  padding: 7px 10px;
  color: var(--ink);
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-left: 3px solid var(--bad);
  border-radius: 8px;
  font-size: 12px;
  line-height: 18px;
}

.stop-heading {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 4px 8px;
  min-width: 0;
}

.stop-title,
.stop-failure,
.stop-model,
.sarbnote,
.sarbrun {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.stop-title {
  flex: 0 1 auto;
  font-weight: 600;
}

.stop-node {
  color: var(--bad);
}

.stop-tag {
  padding: 0 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 11px;
  color: var(--ink-mid);
  line-height: 15px;
}

.stop-metrics {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 4px;
  min-width: 0;
  margin-left: auto;
}

.stop-failure,
.stop-model {
  max-width: 240px;
}

.stop-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.stop-summary > span {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-mid);
}

.stop-disclosure {
  flex-shrink: 0;
}

.sarbnote,
.sarbrun {
  color: var(--ink-mid);
}

.stop-details {
  display: grid;
  grid-template-columns: 116px minmax(0, 1fr);
  gap: 6px 12px;
  margin: 6px 0 0;
  overflow-wrap: anywhere;
}

.stop-details dt {
  font-weight: 600;
}

.stop-details dd {
  margin: 0 0 6px;
  white-space: pre-wrap;
}

.stop-collapsed {
  flex-direction: row;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 12px;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: 0;
}

.stop-collapsed .stop-heading {
  flex: 1 1 300px;
}

.stop-collapsed .stop-metrics {
  margin-left: 0;
}

@media (max-width: 600px) {
  .stop-heading {
    align-items: baseline;
    flex-wrap: wrap;
  }

  .stop-title {
    flex-basis: 100%;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .stop-metrics {
    margin-left: 0;
    flex-wrap: wrap;
  }

  .stop-details {
    grid-template-columns: minmax(0, 1fr);
    gap: 3px;
  }
}
</style>
