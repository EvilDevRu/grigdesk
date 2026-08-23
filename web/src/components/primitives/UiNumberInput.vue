<template>
  <input
    ref="element"
    v-bind="forwardedAttrs"
    class="ui-number-input"
    type="number"
    :value="model ?? ''"
    :id="fieldState.id.value"
    :min="min"
    :max="max"
    :step="step"
    :disabled="disabled"
    :readonly="readonly"
    :required="fieldState.required.value"
    :aria-invalid="fieldState.invalid.value ? 'true' : undefined"
    :aria-describedby="fieldState.describedBy.value"
    @input="onInput"
    @change="$emit('change', $event)"
    @focus="$emit('focus', $event)"
    @blur="$emit('blur', $event)"
  />
</template>

<script setup lang="ts">
import { computed, ref, useAttrs } from 'vue';
import { useResolvedFieldState } from '../../composables/useUiFieldContext';
import type { UiNumberValue } from '../../types/uiFields';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    id?: string;
    min?: number | string;
    max?: number | string;
    step?: number | string;
    disabled?: boolean;
    readonly?: boolean;
    invalid?: boolean;
    required?: boolean;
  }>(),
  {
    id: undefined,
    min: undefined,
    max: undefined,
    step: 1,
    disabled: false,
    readonly: false,
    invalid: false,
    required: false,
  },
);
const emit = defineEmits<{
  input: [event: Event];
  change: [event: Event];
  focus: [event: FocusEvent];
  blur: [event: FocusEvent];
}>();
const model = defineModel<UiNumberValue>({ default: '' });
const attrs = useAttrs();
const element = ref<HTMLInputElement | null>(null);
const fieldState = useResolvedFieldState({
  id: () => props.id,
  describedBy: () => attrs['aria-describedby'] as string | undefined,
  invalid: () => props.invalid,
  required: () => props.required,
});
const forwardedAttrs = computed(() => {
  const { id: _id, 'aria-describedby': _describedBy, ...rest } = attrs;

  return rest;
});

function onInput(event: Event): void {
  emit('input', event);

  const input = event.target as HTMLInputElement;

  model.value = input.value === '' ? '' : input.valueAsNumber;
}

defineExpose({
  get el() {
    return element.value;
  },
  focus: (options?: FocusOptions) => element.value?.focus(options),
  select: () => element.value?.select(),
  stepUp: () => element.value?.stepUp(),
  stepDown: () => element.value?.stepDown(),
});
</script>
