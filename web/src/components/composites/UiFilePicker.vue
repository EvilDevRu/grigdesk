<template>
  <div class="ui-file-picker" :aria-busy="busy ? 'true' : undefined">
    <UiFileInput
      ref="input"
      :accept="accept"
      :multiple="multiple"
      :capture="capture"
      :disabled="disabled || busy"
      :aria-disabled="ariaDisabled"
      @change="onFiles"
    />
    <UiButton
      :disabled="disabled"
      :aria-disabled="ariaDisabled"
      :loading="busy"
      @click="open"
    >
      {{ label }}
    </UiButton>
    <span v-if="summary" class="ui-file-picker__summary">{{ summary }}</span>
    <UiIconButton
      v-if="files.length"
      label="Очистить выбранные файлы"
      :disabled="disabled || busy"
      @click="reset"
    >
      ×
    </UiIconButton>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import UiButton from '../primitives/UiButton.vue';
import UiFileInput from '../primitives/UiFileInput.vue';
import UiIconButton from '../primitives/UiIconButton.vue';

const props = withDefaults(
  defineProps<{
    accept?: string;
    multiple?: boolean;
    capture?: boolean | 'user' | 'environment';
    disabled?: boolean;
    ariaDisabled?: boolean;
    busy?: boolean;
    label?: string;
  }>(),
  {
    accept: undefined,
    multiple: false,
    capture: undefined,
    disabled: false,
    ariaDisabled: false,
    busy: false,
    label: 'Выбрать файл',
  },
);
const emit = defineEmits<{
  change: [files: File[]];
  reset: [];
}>();
const input = ref<InstanceType<typeof UiFileInput> | null>(null);
const files = ref<File[]>([]);
const summary = computed(() => {
  if (!files.value.length) {
    return '';
  }
  if (files.value.length === 1) {
    return files.value[0]?.name || '';
  }

  return `Выбрано файлов: ${files.value.length}`;
});

function onFiles(fileList: FileList): void {
  files.value = Array.from(fileList);
  emit('change', [...files.value]);
}

function open(): void {
  if (!props.disabled && !props.ariaDisabled && !props.busy) {
    input.value?.reset();
    input.value?.open();
  }
}

function reset(): void {
  files.value = [];
  input.value?.reset();
  emit('reset');
}

defineExpose({
  open,
  reset,
  get files() {
    return [...files.value];
  },
});
</script>
