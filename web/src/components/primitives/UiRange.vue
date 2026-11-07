<template>
  <input
    ref="element"
    v-bind="$attrs"
    class="ui-range"
    type="range"
    :value="model"
    :min="min"
    :max="max"
    :step="step"
    :disabled="disabled"
    :aria-disabled="ariaDisabled ? 'true' : undefined"
    :aria-valuetext="ariaValueText"
    @input="onInput"
    @change="$emit('change', $event)"
  />
</template>

<script setup lang="ts">
import { ref } from 'vue';

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    ariaDisabled?: boolean;
    ariaValueText?: string;
  }>(),
  {
    min: 0,
    max: 100,
    step: 1,
    disabled: false,
    ariaDisabled: false,
    ariaValueText: undefined,
  },
);
const emit = defineEmits<{ input: [event: Event]; change: [event: Event] }>();
const model = defineModel<number>({ default: 0 });
const element = ref<HTMLInputElement | null>(null);

function onInput(event: Event): void {
  emit('input', event);

  if (!props.ariaDisabled) {
    model.value = (event.target as HTMLInputElement).valueAsNumber;
  }
}

defineExpose({
  get el() {
    return element.value;
  },
  focus: (options?: FocusOptions) => element.value?.focus(options),
});
</script>
