<template>
  <UiTooltipHost v-if="hostEnabled" />
  <UiButton v-tooltip="text" data-test="target">Цель</UiButton>
  <UiDialog v-model:open="open" title="Диалог">
    <template #default="{ isTop }">
      <span data-test="top">{{ String(isTop) }}</span>
      <UiButton v-tooltip="'В диалоге'" data-test="in-dialog">Цель диалога</UiButton>
    </template>
  </UiDialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';

import { UiButton, UiDialog, UiTooltipHost, vTooltip } from '../../../../web/src/ui.ts';

const props = withDefaults(defineProps<{
  text: string;
  dialogOpen?: boolean;
  hostEnabled?: boolean;
}>(), {
  dialogOpen: false,
  hostEnabled: true,
});

const open = ref(props.dialogOpen);

watch(() => props.dialogOpen, (value) => {
  open.value = value;
});
</script>
