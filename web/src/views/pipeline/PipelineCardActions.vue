<template>
  <div v-if="actions.length" class="pipeline-card-actions">
    <UiButton
      v-for="action in actions"
      :key="action.id"
      size="compact"
      :class="action.className"
      :data-role="action.role || 'pipeline-compact-action'"
      :tone="action.primary ? action.tone : 'neutral'"
      :variant="action.primary ? 'solid' : 'outline'"
      :disabled="action.disabled"
      :loading="action.loading"
      :loading-label="action.loadingLabel"
      v-tooltip="action.hint"
      @click="emit('action', action.id)"
    >
      {{ action.label }}
    </UiButton>
  </div>
</template>

<script setup lang="ts">
import type { PipelineCardAction, PipelineCardActionId } from '../../shared/pipelineCardActions.ts';
import { UiButton, vTooltip } from '../../ui';

defineProps<{ actions: PipelineCardAction[] }>();

const emit = defineEmits<{ action: [id: PipelineCardActionId] }>();
</script>

<style scoped>
.pipeline-card-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

@media (max-width: 600px) {
  .pipeline-card-actions {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 128px), 1fr));
    grid-auto-rows: 1fr;
    align-items: stretch;
    gap: 8px;
    width: 100%;
  }
}
</style>
