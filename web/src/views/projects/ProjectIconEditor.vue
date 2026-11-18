<template>
  <div class="icon-editor" data-project-icon-editor>
    <ProjectAvatar :id="id" :title="projectTitle" :icon="modelValue" large />
    <div class="icon-details">
      <div class="icon-actions">
        <UiFilePicker
          data-project-icon-picker
          data-context="project-icon-upload"
          :accept="PROJECT_ICON_FILE_ACCEPT"
          :label="modelValue ? t('core.projectIconReplace') : t('core.projectIconChoose')"
          :disabled="disabled"
          :busy="busy"
          :show-summary="false"
          :show-reset="false"
          @change="choose"
        >
          <template #leading><ProjectIcon name="upload" /></template>
        </UiFilePicker>
        <UiButton
          v-if="modelValue"
          data-project-icon-remove
          data-context="workspace-form"
          variant="text"
          :disabled="disabled"
          @click="clear"
        >
          {{ t('core.projectIconRemove') }}
        </UiButton>
      </div>
      <UiInlineMessage v-if="error" tone="danger">{{ t('core.projectIconInvalid') }}</UiInlineMessage>
      <p v-else class="icon-hint">{{ t('core.projectIconRequirements') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { UiButton, UiFilePicker, UiInlineMessage, t } from '../../ui.ts';
import ProjectAvatar from './ProjectAvatar.vue';
import ProjectIcon from './ProjectIcon.vue';
import { PROJECT_ICON_FILE_ACCEPT, projectIconFile } from './projectIconFile.ts';

const props = defineProps<{
  id: string;
  projectTitle: string;
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
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 12px;
}

.icon-details {
  display: grid;
  gap: 4px;
}

.icon-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
}

.icon-hint {
  margin: 0;
  color: var(--ink-mid);
  font-size: 12px;
  line-height: 16px;
}
</style>
