<template>
  <div class="icon-editor" data-project-icon-editor>
    <ProjectAvatar :id="id" :title="title" :icon="modelValue" large />
    <UiFilePicker
      data-project-icon-picker
      accept="image/png,image/jpeg,image/webp"
      density="compact"
      :label="t('core.projectIconChoose')"
      :disabled="disabled"
      :busy="busy"
      :show-summary="false"
      :show-reset="false"
      @change="choose"
    />
    <UiButton
      v-if="modelValue"
      data-project-icon-remove
      variant="text"
      :disabled="disabled"
      @click="clear"
    >
      {{ t('core.projectIconRemove') }}
    </UiButton>
    <p v-if="error" role="alert">{{ t('core.projectIconInvalid') }}</p>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { UiButton, UiFilePicker, t } from '../../ui.ts';
import ProjectAvatar from './ProjectAvatar.vue';
import { projectIconFile } from './projectIconFile.ts';

const props = defineProps<{
  id: string;
  title: string;
  modelValue?: string | null;
  disabled?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string | null]; busy: [value: boolean] }>();

const busy = ref(false);
const error = ref(false);
let generation = 0;

/**
 * Смена паспорта или сброс обрывают право старого decode обновлять черновик.
 * Сам decode завершится и освободит Object URL в finally нормализатора.
 */
function invalidate(): void {
  generation += 1;
  busy.value = false;
  error.value = false;
  emit('busy', false);
}

/**
 * Только последнее выбранное изображение попадает в текущий черновик.
 * Ошибка сохраняет прежнюю иконку, а сохранение формы ждёт конца обработки.
 */
async function choose(files: File[]): Promise<void> {
  if (props.disabled || !files[0]) {
    return;
  }

  const current = ++generation;

  busy.value = true;
  error.value = false;
  emit('busy', true);

  try {
    const icon = await projectIconFile(files[0]);

    if (current === generation) {
      emit('update:modelValue', icon);
    }
  } catch {
    if (current === generation) {
      error.value = true;
    }
  } finally {
    if (current === generation) {
      busy.value = false;
      emit('busy', false);
    }
  }
}

function clear(): void {
  if (!props.disabled) {
    invalidate();
    emit('update:modelValue', null);
  }
}

watch(() => [props.id, props.modelValue, props.disabled], invalidate);
onBeforeUnmount(invalidate);
</script>

<style scoped>
.icon-editor {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.icon-editor p {
  flex-basis: 100%;
  margin: 0;
}
</style>
