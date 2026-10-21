<template>
  <div class="ui-number-field">
    <UiNumberInput
      ref="input"
      v-bind="$attrs"
      v-model="model"
      :min="min"
      :max="max"
      :step="step"
      :disabled="disabled"
      :readonly="readonly"
      :invalid="invalid"
      @change="$emit('change', $event)"
    />
    <span class="ui-number-field__steps">
      <UiIconButton
        role="stepper"
        :label="t('core.increase')"
        :disabled="disabled || readonly || atMax"
        @click="changeBy(1)"
      >
        +
      </UiIconButton>
      <UiIconButton
        role="stepper"
        :label="t('core.decrease')"
        :disabled="disabled || readonly || atMin"
        @click="changeBy(-1)"
      >
        −
      </UiIconButton>
    </span>
  </div>
</template>

<script setup lang="ts">
import { t } from '../../services/locale.ts';

import { computed, ref } from 'vue';
import type { UiNumberValue } from '../../types/uiFields';
import UiIconButton from '../primitives/UiIconButton.vue';
import UiNumberInput from '../primitives/UiNumberInput.vue';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    readonly?: boolean;
    invalid?: boolean;
  }>(),
  {
    min: undefined,
    max: undefined,
    step: 1,
    disabled: false,
    readonly: false,
    invalid: false,
  },
);
const emit = defineEmits<{ change: [event: Event] }>();
const model = defineModel<UiNumberValue>({ default: '' });
const input = ref<InstanceType<typeof UiNumberInput> | null>(null);
const numericValue = computed(() =>
  typeof model.value === 'number' ? model.value : 0,
);
const atMax = computed(
  () => props.max !== undefined && numericValue.value >= props.max,
);
const atMin = computed(
  () => props.min !== undefined && numericValue.value <= props.min,
);

/**
 * Пустое числовое поле начинает шаг от нуля, как и `numericValue`.
 * После шага значение обязательно зажимается в объявленных границах.
 */
function changeBy(direction: 1 | -1): void {
  let value = numericValue.value + props.step * direction;

  if (props.min !== undefined) {
    value = Math.max(props.min, value);
  }
  if (props.max !== undefined) {
    value = Math.min(props.max, value);
  }

  model.value = value;
}

defineExpose({
  get el() {
    return input.value?.el ?? null;
  },
  focus: (options?: FocusOptions) => input.value?.focus(options),
  select: () => input.value?.select(),
});
</script>
