<template>
  <UiButton class="sandbox-row" :tone="row.age.old ? 'warning' : 'neutral'"
            data-context="workspace-catalog-row" :data-task="row.task" :pressed="selected"
            @click="emit('select', row.task)">
    <span class="sandbox-row__line">
      <strong>t{{ row.task }}</strong>
      <span class="sandbox-row__title" v-tooltip="row.title">{{ row.title }}</span>
      <span v-if="row.entry?.slot != null" class="sandbox-row__slot">Слот {{ row.entry.slot }}</span>
    </span>
    <span class="sandbox-row__line sandbox-row__meta">
      <span v-tooltip="row.detail || undefined">{{ row.stateLabel }}</span>
      <span v-if="row.entry?.fePort">:{{ row.entry.fePort }}</span>
      <span v-tooltip="row.age.hint">
        <span v-if="row.age.old" aria-label="Давно стоит">⚠ </span>{{ row.age.label }}
      </span>
    </span>
    <span v-if="row.step" class="sandbox-row__step" v-tooltip="row.step">{{ row.step }}</span>
  </UiButton>
</template>

<script setup lang="ts">
import { UiButton, vTooltip } from '../../ui';
import type { SandboxRow } from '../../shared/sandboxPresentation.ts';

defineProps<{
  row: SandboxRow;
  selected: boolean;
}>();

const emit = defineEmits<{ select: [task: string] }>();
</script>

<style scoped>
.sandbox-row {
  min-width: 0;
  width: 100%;
}

.sandbox-row :deep(.ui-button__content),
.sandbox-row :deep(.ui-button__label) {
  min-width: 0;
  width: 100%;
}

.sandbox-row__line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  text-align: left;
}

.sandbox-row__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sandbox-row__slot {
  flex: none;
}

.sandbox-row__meta {
  gap: 6px 12px;
  flex-wrap: wrap;
  color: var(--ink-mid);
  font-size: 12px;
}

.sandbox-row__step {
  display: block;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-mid);
  font-size: 12px;
}

</style>
