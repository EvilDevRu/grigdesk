<template>
  <textarea
    ref="element"
    v-bind="forwardedAttrs"
    class="ui-textarea"
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

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    id?: string;
    disabled?: boolean;
    readonly?: boolean;
    invalid?: boolean;
    required?: boolean;
  }>(),
  {
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
const [model, modelModifiers] = defineModel<string | null, 'trim' | 'lazy'>({
  default: '',
});
const attrs = useAttrs();
const element = ref<HTMLTextAreaElement | null>(null);
const composing = ref(false);
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

function valueOf(event: Event): string {
  const value = (event.target as HTMLTextAreaElement).value;

  return modelModifiers.trim ? value.trim() : value;
}

function updateFrom(event: Event): void {
  model.value = valueOf(event);
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
