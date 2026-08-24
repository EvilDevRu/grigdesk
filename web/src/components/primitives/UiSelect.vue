<template>
  <span
    class="ui-select-wrap"
    :class="{ 'ui-select-wrap--compact': compact }"
  >
    <select
      ref="element"
      v-bind="forwardedAttrs"
      class="ui-select"
      :class="{ 'ui-select--compact': compact }"
      :value="model ?? ''"
      :id="fieldState.id.value"
      :disabled="disabled"
      :required="fieldState.required.value"
      :aria-disabled="ariaDisabled ? 'true' : undefined"
      :aria-invalid="fieldState.invalid.value ? 'true' : undefined"
      :aria-describedby="fieldState.describedBy.value"
      @change="onChange"
      @focus="$emit('focus', $event)"
      @blur="$emit('blur', $event)"
    >
      <slot />
    </select>
  </span>
</template>

<script setup lang="ts">
import { computed, ref, useAttrs } from 'vue';
import { useResolvedFieldState } from '../../composables/useUiFieldContext';
import type { UiSelectValue } from '../../types/uiFields';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    id?: string;
    disabled?: boolean;
    ariaDisabled?: boolean;
    invalid?: boolean;
    required?: boolean;
    compact?: boolean;
  }>(),
  {
    id: undefined,
    disabled: false,
    ariaDisabled: false,
    invalid: false,
    required: false,
    compact: false,
  },
);

defineSlots<{ default(): unknown }>();

const emit = defineEmits<{
  change: [event: Event];
  focus: [event: FocusEvent];
  blur: [event: FocusEvent];
}>();
const [model, modelModifiers] = defineModel<UiSelectValue, 'trim' | 'number'>({
  default: '',
});
const attrs = useAttrs();
const element = ref<HTMLSelectElement | null>(null);
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

/**
 * Событие остаётся доступно consumer-у, а модель получает уже нормализованное значение.
 * Для `ariaDisabled` видимый DOM откатывается, поскольку select остаётся фокусируемым.
 */
function onChange(event: Event): void {
  if (props.ariaDisabled) {
    event.preventDefault();
    (event.target as HTMLSelectElement).value = String(model.value ?? '');

    emit('change', event);

    return;
  }

  let value: UiSelectValue = (event.target as HTMLSelectElement).value;

  if (modelModifiers.trim) {
    value = String(value).trim();
  }
  if (modelModifiers.number && value !== '') {
    const parsed = Number.parseFloat(String(value));

    if (!Number.isNaN(parsed)) {
      value = parsed;
    }
  }

  model.value = value;
  emit('change', event);
}

defineExpose({
  get el() {
    return element.value;
  },
  focus: (options?: FocusOptions) => element.value?.focus(options),
});
</script>
