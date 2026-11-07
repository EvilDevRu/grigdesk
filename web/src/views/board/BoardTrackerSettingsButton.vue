<template>
  <UiIconButton :label="t('core.trackerSettings')" data-context="workspace-toolbar" data-board-tracker-settings
                v-tooltip="t('core.trackerSettings')" @click="emit('click')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
      <path d="m9 3-.5 2a8 8 0 0 0-2 1.2L4.5 6l-2 3.5L4 11v2l-1.5 1.5 2 3.5 2-.2A8 8 0 0 0
               8.5 19l.5 2h4l.5-2a8 8 0 0 0 2-1.2l2 .2 2-3.5L18 13v-2l1.5-1.5-2-3.5-2 .2A8 8
               0 0 0 13.5 5L13 3Z" />
      <circle cx="11" cy="12" r="3" />
    </svg>
  </UiIconButton>
</template>

<script setup lang="ts">
import { t, UiIconButton, vTooltip } from '../../ui';

const emit = defineEmits<{ click: [] }>();
</script>
