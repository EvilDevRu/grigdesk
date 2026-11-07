<template>
  <div
    class="ui-radio-group"
    role="radiogroup"
    :aria-label="label"
    :aria-labelledby="labelledby"
    :aria-disabled="disabled ? 'true' : undefined"
  >
    <slot :model-value="model" :select="select" :disabled="disabled" />
  </div>
</template>

<script setup lang="ts">
import type { UiSelectionValue } from '../../types/uiSelection';

const props = withDefaults(
  defineProps<{
    label?: string;
    labelledby?: string;
    disabled?: boolean;
  }>(),
  {
    label: undefined,
    labelledby: undefined,
    disabled: false,
  },
);

defineSlots<{
  default(props: {
    modelValue: UiSelectionValue | undefined;
    select: (value: UiSelectionValue) => void;
    disabled: boolean;
  }): unknown;
}>();

const model = defineModel<UiSelectionValue>();

function select(value: UiSelectionValue): void {
  if (!props.disabled) {
    model.value = value;
  }
}
</script>
