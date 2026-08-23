<template>
  <input
    ref="element"
    v-bind="forwardedAttrs"
    class="ui-input"
    :type="normalizedType"
    :value="model ?? ''"
    :id="fieldState.id.value"
    :disabled="disabled"
    :readonly="readonly"
    :required="fieldState.required.value"
    :aria-invalid="fieldState.invalid.value ? 'true' : undefined"
    :aria-describedby="fieldState.describedBy.value"
    @compositionstart="composing = true"
    @compositionend="onCompositionEnd"
    @input="onInput"
    @change="onChange"
    @focus="$emit('focus', $event)"
    @blur="$emit('blur', $event)"
  />
</template>

<script setup lang="ts">
import { computed, ref, useAttrs } from 'vue';
import { useResolvedFieldState } from '../../composables/useUiFieldContext';
import type { UiTextInputType, UiTextValue } from '../../types/uiFields';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    type?: UiTextInputType;
    id?: string;
    disabled?: boolean;
    readonly?: boolean;
    invalid?: boolean;
    required?: boolean;
  }>(),
  {
    type: 'text',
    id: undefined,
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
const [model, modelModifiers] = defineModel<
  UiTextValue,
  'trim' | 'number' | 'lazy'
>({ default: '' });
const attrs = useAttrs();
const element = ref<HTMLInputElement | null>(null);
const composing = ref(false);
const allowedTypes: UiTextInputType[] = [
  'text',
  'email',
  'password',
  'search',
  'tel',
  'url',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
];
const normalizedType = computed<UiTextInputType>(() =>
  allowedTypes.includes(props.type) ? props.type : 'text',
);
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
 * Модификаторы применяются внутри primitive одинаково для input и IME.
 * Пустота и нечисловой текст не превращаются в `NaN`, чтобы модель не теряла ввод.
 */
function convert(value: string): UiTextValue {
  const normalized = modelModifiers.trim ? value.trim() : value;

  if (!modelModifiers.number) {
    return normalized;
  }
  if (normalized === '') {
    return '';
  }

  const parsed = Number.parseFloat(normalized);

  return Number.isNaN(parsed) ? normalized : parsed;
}

function updateFrom(event: Event): void {
  model.value = convert((event.target as HTMLInputElement).value);
}

function onInput(event: Event): void {
  emit('input', event);

  if (!composing.value && !modelModifiers.lazy) {
    updateFrom(event);
  }
}

function onChange(event: Event): void {
  emit('change', event);

  if (modelModifiers.lazy) {
    updateFrom(event);
  }
}

function onCompositionEnd(event: CompositionEvent): void {
  composing.value = false;

  if (!modelModifiers.lazy) {
    updateFrom(event);
  }
}

defineExpose({
  get el() {
    return element.value;
  },
  focus: (options?: FocusOptions) => element.value?.focus(options),
  select: () => element.value?.select(),
});
</script>
