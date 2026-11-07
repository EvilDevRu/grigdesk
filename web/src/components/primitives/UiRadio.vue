<template>
  <label
    class="ui-radio"
    :class="{ 'is-disabled': disabled, 'is-invalid': fieldState.invalid.value }"
  >
    <input
      ref="element"
      v-bind="forwardedAttrs"
      class="ui-radio__native"
      type="radio"
      :id="fieldState.id.value"
      :name="name"
      :checked="checked"
      :disabled="disabled"
      :required="fieldState.required.value"
      :aria-disabled="ariaDisabled ? 'true' : undefined"
      :aria-invalid="fieldState.invalid.value ? 'true' : undefined"
      :aria-describedby="fieldState.describedBy.value"
      @change="onChange"
      @focus="$emit('focus', $event)"
      @blur="$emit('blur', $event)"
    />
    <span class="ui-radio__mark" aria-hidden="true" />
    <span v-if="$slots.default" class="ui-radio__label"><slot /></span>
  </label>
</template>

<script setup lang="ts">
import { computed, ref, useAttrs } from 'vue';
import { useResolvedFieldState } from '../../composables/useUiFieldContext';
import type { UiSelectionValue } from '../../types/uiSelection';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    value: UiSelectionValue;
    id?: string;
    name?: string;
    disabled?: boolean;
    ariaDisabled?: boolean;
    invalid?: boolean;
    required?: boolean;
  }>(),
  {
    id: undefined,
    name: undefined,
    disabled: false,
    ariaDisabled: false,
    invalid: false,
    required: false,
  },
);

defineSlots<{ default?(): unknown }>();

const emit = defineEmits<{
  change: [event: Event];
  focus: [event: FocusEvent];
  blur: [event: FocusEvent];
}>();
const model = defineModel<UiSelectionValue>();
const attrs = useAttrs();
const element = ref<HTMLInputElement | null>(null);
const checked = computed(() => Object.is(model.value, props.value));
const fieldState = useResolvedFieldState({
  id: () => props.id,
  describedBy: () => attrs['aria-describedby'] as string | undefined,
  invalid: () => props.invalid,
  required: () => props.required,
});
const forwardedAttrs = computed(() => {
  const {
    id: _id,
    'aria-describedby': _describedBy,
    value: _value,
    ...rest
  } = attrs;

  return rest;
});

function onChange(event: Event): void {
  if (props.ariaDisabled) {
    event.preventDefault();
    (event.target as HTMLInputElement).checked = checked.value;

    return;
  }

  emit('change', event);
  model.value = props.value;
}

defineExpose({
  get el() {
    return element.value;
  },
  focus: (options?: FocusOptions) => element.value?.focus(options),
});
</script>
