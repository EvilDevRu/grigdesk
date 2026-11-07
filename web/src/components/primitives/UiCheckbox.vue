<template>
  <label
    class="ui-checkbox"
    :class="{ 'is-disabled': disabled, 'is-invalid': fieldState.invalid.value }"
  >
    <input
      ref="element"
      v-bind="forwardedAttrs"
      class="ui-checkbox__native"
      type="checkbox"
      :id="fieldState.id.value"
      :name="name"
      :value="nativeValue"
      :checked="isChecked"
      :disabled="disabled"
      :required="fieldState.required.value"
      :aria-disabled="ariaDisabled ? 'true' : undefined"
      :aria-invalid="fieldState.invalid.value ? 'true' : undefined"
      :aria-describedby="fieldState.describedBy.value"
      @change="onChange"
      @focus="$emit('focus', $event)"
      @blur="$emit('blur', $event)"
    />
    <span class="ui-checkbox__mark" aria-hidden="true" />
    <span v-if="$slots.default" class="ui-checkbox__label"><slot /></span>
  </label>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, useAttrs, watch } from 'vue';
import { useResolvedFieldState } from '../../composables/useUiFieldContext';
import type {
  UiCheckboxModel,
  UiSelectionValue,
} from '../../types/uiSelection';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    value?: UiSelectionValue;
    trueValue?: UiSelectionValue;
    falseValue?: UiSelectionValue;
    checked?: boolean;
    indeterminate?: boolean;
    id?: string;
    name?: string;
    disabled?: boolean;
    ariaDisabled?: boolean;
    invalid?: boolean;
    required?: boolean;
  }>(),
  {
    value: () => true,
    trueValue: () => true,
    falseValue: () => false,
    checked: undefined,
    indeterminate: false,
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
  'update:checked': [value: boolean];
  change: [event: Event];
  focus: [event: FocusEvent];
  blur: [event: FocusEvent];
}>();
const model = defineModel<UiCheckboxModel>();
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
const isArrayModel = computed(() => Array.isArray(model.value));
const isChecked = computed(() => {
  if (props.checked !== undefined) {
    return props.checked;
  }
  if (isArrayModel.value) {
    return (model.value as UiSelectionValue[]).some((item) =>
      Object.is(item, props.value),
    );
  }

  return Object.is(model.value, props.trueValue);
});
const nativeValue = computed(() =>
  typeof props.value === 'object' ? undefined : String(props.value ?? ''),
);

function syncIndeterminate(): void {
  if (element.value) {
    element.value.indeterminate = props.indeterminate;
  }
}

onMounted(syncIndeterminate);
watch(() => props.indeterminate, syncIndeterminate);

/**
 * `ariaDisabled` оставляет нативный input фокусируемым, поэтому сначала
 * откатываем DOM-состояние, а затем обновляем scalar или копию array-модели.
 */
function onChange(event: Event): void {
  const input = event.target as HTMLInputElement;

  if (props.ariaDisabled) {
    input.checked = isChecked.value;
    event.preventDefault();

    return;
  }

  emit('change', event);
  emit('update:checked', input.checked);

  if (isArrayModel.value) {
    const current = [...(model.value as UiSelectionValue[])];
    const index = current.findIndex((item) => Object.is(item, props.value));

    if (input.checked && index < 0) {
      current.push(props.value);
    }
    if (!input.checked && index >= 0) {
      current.splice(index, 1);
    }

    model.value = current;
  } else {
    model.value = input.checked ? props.trueValue : props.falseValue;
  }
}

defineExpose({
  get el() {
    return element.value;
  },
  focus: (options?: FocusOptions) => element.value?.focus(options),
});
</script>
