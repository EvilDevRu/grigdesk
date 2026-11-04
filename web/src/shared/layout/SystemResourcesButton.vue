<template>
  <UiPressable class="resource-trigger mono"
               :data-context="phone ? 'phone-status-metrics' : 'topbar-metrics'"
               :class="{ stale, 'phone-status-metrics': phone }" :aria-label="label || t('core.computerResources')"
               aria-haspopup="dialog" :aria-expanded="open" @click="$emit('click', $event)">
    <span class="resource-reading">CPU <b :class="loadClass(metrics?.cpu.percent)">{{ cpuLabel }}</b></span>
    <span class="resource-memory">
      <span class="resource-reading">RAM <b :class="loadClass(metrics?.mem?.percent)">{{ memoryLabel }}</b></span>
      <span v-if="alarm" class="resources-alarm" aria-hidden="true"></span>
    </span>
  </UiPressable>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { SystemMetrics } from '../../../../shared/runtime/systemMetrics.ts';
import { formatNumber } from '../../../../shared/i18n/formats.ts';
import { t, uiLocale, UiPressable } from '../../ui.ts';
import { loadClass } from './resourceMetrics.ts';

const props = defineProps<{
  metrics: SystemMetrics | null;
  stale: boolean;
  phone?: boolean;
  alarm?: boolean;
  label?: string;
  open?: boolean;
}>();

defineEmits<{ click: [event: MouseEvent] }>();

const cpuLabel = computed(() => props.metrics
  ? `${formatNumber(props.metrics.cpu.percent, uiLocale)}%`
  : '—');
const memoryLabel = computed(() => {
  const memory = props.metrics?.mem;

  if (memory?.usedGb === undefined || memory.totalGb === undefined) {
    return '—';
  }

  return `${formatNumber(memory.usedGb, uiLocale)}/${formatNumber(memory.totalGb, uiLocale)}`;
});
</script>
