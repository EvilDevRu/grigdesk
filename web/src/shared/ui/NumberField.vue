<template>
  <UiNumberField
    :model-value="model"
    :min="min"
    :max="max"
    :step="step"
    :placeholder="placeholder"
    @update:model-value="set"
  />
</template>

<script setup lang="ts">
import { UiNumberField, type UiNumberValue } from '../../ui';

const props = withDefaults(defineProps<{
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}>(), { min: 0, max: undefined, step: 1, placeholder: '' });
const model = defineModel<number>({ default: 0 });
function set(value: UiNumberValue): void {
  const normalized = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  model.value = Math.max(props.min, normalized);
}
</script>
