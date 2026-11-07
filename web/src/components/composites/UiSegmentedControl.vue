<template>
  <div class="ui-segmented-control" role="group" :aria-label="label" :data-size="normalizedSize">
    <UiButton
      v-for="option in options"
      :key="String(option.value)"
      :data-option-value="String(option.value)"
      variant="ghost"
      :size="normalizedSize"
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
import { computed } from 'vue';

import { normalizeActionSize, type UiActionSize } from '../../types/uiActions';
import type { UiSelectionOption } from '../../types/uiSelection';
import UiButton from '../primitives/UiButton.vue';

const props = withDefaults(
  defineProps<{
    options?: Array<UiSelectionOption<T>>;
    label?: string;
    disabled?: boolean;
    size?: UiActionSize;
  }>(),
  {
    options: () => [],
    label: undefined,
    disabled: false,
    size: 'default',
  },
);

defineSlots<{ default?(): unknown }>();

const model = defineModel<T>({ required: true });
const normalizedSize = computed(() => normalizeActionSize(props.size));
</script>
