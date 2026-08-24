<template>
  <div class="ui-segmented-control" role="group" :aria-label="label">
    <UiButton
      v-for="option in options"
      :key="String(option.value)"
      :data-option-value="String(option.value)"
      variant="ghost"
      :pressed="Object.is(option.value, model)"
      :disabled="disabled || option.disabled"
      @click="model = option.value"
    >
      {{ option.label }}
    </UiButton>
    <slot />
  </div>
</template>

<script setup lang="ts" generic="T extends string | number">
import type { UiSelectionOption } from '../../types/uiSelection';
import UiButton from '../primitives/UiButton.vue';

withDefaults(
  defineProps<{
    options?: Array<UiSelectionOption<T>>;
    label?: string;
    disabled?: boolean;
  }>(),
  {
    options: () => [],
    label: undefined,
    disabled: false,
  },
);
defineSlots<{ default?(): unknown }>();

const model = defineModel<T>({ required: true });
</script>
