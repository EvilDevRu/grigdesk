<template>
  <div
    v-if="loop"
    class="loop-status"
    :class="{ active: loop.activeNode }"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    <span class="loop-heading"><span aria-hidden="true">↻</span> {{ t('core.pipelinePetlyaAgentov') }}</span>
    <strong class="loop-round">{{ loop.roundLabel }}</strong>
    <span v-if="loop.stage !== null" class="loop-stage">{{ t('core.pipelineEtap') }} {{ loop.stage }}</span>
    <span class="loop-activity">
      <span v-if="loop.activeNode" class="loop-dot" aria-hidden="true"></span>
      {{ loop.activity }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { t } from '../../ui';

import type { FactoryGraphData } from '../../../../shared/pipeline/factoryGraphContracts.ts';
import { factoryLoopView } from '../../shared/factoryLoopView.ts';

const props = defineProps<{ graph: FactoryGraphData }>();

const loop = computed(() => factoryLoopView(props.graph));
</script>

<style scoped>
.loop-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  margin-top: 10px;
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--line));
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 5%, transparent);
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 1.4;
}
.loop-heading { display: inline-flex; align-items: center; gap: 6px; color: var(--accent); }
.loop-heading > span { font-size: 19px; line-height: 1; }
.loop-round { color: var(--ink); font-weight: 650; font-variant-numeric: tabular-nums; }
.loop-stage { font-variant-numeric: tabular-nums; }
.loop-activity { display: inline-flex; align-items: baseline; gap: 7px; margin-left: auto; }
.active .loop-activity { color: var(--ink); }
.loop-dot { width: 6px; height: 6px; flex: 0 0 6px; border-radius: 50%; background: var(--accent); }
@media (max-width: 720px) {
  .loop-activity { flex-basis: 100%; margin-left: 0; }
}
</style>
