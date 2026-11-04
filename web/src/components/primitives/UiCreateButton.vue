<template>
  <UiIconButton v-bind="$attrs" data-context="workspace-create" :label="label"
                :aria-expanded="expanded" v-tooltip="label" tone="accent">
    <span aria-hidden="true">{{ expanded ? '−' : '＋' }}</span>
  </UiIconButton>
</template>

<script setup lang="ts">
import UiIconButton from './UiIconButton.vue';
import { vTooltip } from '../../services/tooltipDirective.ts';

defineOptions({ inheritAttrs: false });

withDefaults(defineProps<{
  label: string;
  expanded?: boolean;
}>(), { expanded: undefined });
</script>
