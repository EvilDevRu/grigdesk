<template>
  <input
    ref="element"
    v-bind="$attrs"
    class="ui-file-input"
    type="file"
    :accept="accept"
    :multiple="multiple"
    :capture="capture"
    :disabled="disabled || ariaDisabled"
    @change="onChange"
  />
</template>

<script setup lang="ts">
import { ref } from 'vue';

defineOptions({ inheritAttrs: false });
withDefaults(
  defineProps<{
    accept?: string;
    multiple?: boolean;
    capture?: boolean | 'user' | 'environment';
    disabled?: boolean;
    ariaDisabled?: boolean;
  }>(),
  {
    accept: undefined,
    multiple: false,
    capture: undefined,
    disabled: false,
    ariaDisabled: false,
  },
);

const emit = defineEmits<{ change: [files: FileList, event: Event] }>();
const element = ref<HTMLInputElement | null>(null);

function onChange(event: Event): void {
  const input = event.target as HTMLInputElement;

  if (input.files) {
    emit('change', input.files, event);
  }
}

function reset(): void {
  if (element.value) {
    element.value.value = '';
  }
}

defineExpose({
  get el() {
    return element.value;
  },
  focus: (options?: FocusOptions) => element.value?.focus(options),
  open: () => element.value?.click(),
  click: () => element.value?.click(),
  reset,
});
</script>
