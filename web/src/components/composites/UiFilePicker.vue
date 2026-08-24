<template>
  <div
    class="ui-file-picker"
    :class="[
      `ui-file-picker--${presentation}`,
      `ui-file-picker--${density}`,
    ]"
    :data-presentation="presentation"
    :data-density="density"
    :aria-busy="busy ? 'true' : undefined"
  >
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
      class="ui-file-picker__trigger"
      :disabled="disabled || busy"
      :aria-disabled="ariaDisabled"
      :loading="busy && presentation !== 'dropzone'"
      :loading-label="loadingLabel"
      :block="presentation === 'dropzone'"
      @click="open"
    >
      <template v-if="$slots.leading" #leading>
        <slot name="leading" />
      </template>
      <span class="ui-file-picker__copy">
        <strong><slot>{{ label }}</slot></strong>
        <small v-if="$slots.hint"><slot name="hint" /></small>
      </span>
      <template v-if="$slots.trailing" #trailing>
        <slot name="trailing" />
      </template>
    </UiButton>
    <span v-if="showSummary && summary" class="ui-file-picker__summary">{{ summary }}</span>
    <UiIconButton
      v-if="showReset && files.length"
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
    loadingLabel?: string;
    presentation?: 'inline' | 'dropzone';
    density?: 'default' | 'compact';
    showSummary?: boolean;
    showReset?: boolean;
  }>(),
  {
    accept: undefined,
    multiple: false,
    capture: undefined,
    disabled: false,
    ariaDisabled: false,
    busy: false,
    label: 'Выбрать файл',
    loadingLabel: 'Загрузка файла',
    presentation: 'inline',
    density: 'default',
    showSummary: true,
    showReset: true,
  },
);

defineSlots<{
  default?(): unknown;
  leading?(): unknown;
  hint?(): unknown;
  trailing?(): unknown;
}>();

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
