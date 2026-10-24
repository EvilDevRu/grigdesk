<template>
  <UiDialog :open="open" :title="t('core.grigdeskNewTask')" :busy="saving"
            initial-focus="#grigdesk-task-title" @update:open="emit('update:open', $event)">
    <form class="new-task-form" @submit.prevent="save">
      <UiField id="grigdesk-task-title" :label="t('core.grigdeskTaskTitle')" required>
        <UiInput v-model="title" :maxlength="500" :disabled="saving" />
      </UiField>
      <UiField :label="t('core.grigdeskTaskDescription')">
        <UiTextarea v-model="description" :maxlength="100000" :rows="7" :disabled="saving" />
      </UiField>
      <UiField :label="t('core.grigdeskTaskProject')" required>
        <UiSelect v-model="projectId" :disabled="saving">
          <option value="">{{ t('core.grigdeskChooseProject') }}</option>
          <option v-for="project in store.projects" :key="project.id" :value="project.id">
            {{ project.title }}
          </option>
        </UiSelect>
      </UiField>
      <p v-if="!store.projects.length" class="muted">{{ t('core.grigdeskNoProjects') }}</p>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <UiFormActions>
        <UiButton :disabled="saving" @click="emit('update:open', false)">
          {{ t('core.grigdeskCancel') }}
        </UiButton>
        <UiButton type="button" tone="accent" :loading="saving" :disabled="saving" @click="save">
          {{ t('core.grigdeskCreate') }}
        </UiButton>
      </UiFormActions>
    </form>
  </UiDialog>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { useGrigdeskTasksStore } from '../../stores/grigdeskTasks.ts';
import { failureText } from '../../shared/apiClient.ts';
import {
  t, UiButton, UiDialog, UiField, UiFormActions, UiInput, UiSelect, UiTextarea,
} from '../../ui.ts';

defineProps<{ open: boolean }>();

const emit = defineEmits<{
  'update:open': [open: boolean];
  created: [id: string];
}>();

const store = useGrigdeskTasksStore();
const title = ref('');
const description = ref('');
const projectId = ref('');
const saving = ref(false);
const error = ref('');

/**
 * Черновик живёт до подтверждённого сохранения, включая сетевой отказ.
 * Блокировка повторного submit действует до первого await и не запускает оценку.
 */
async function save() {
  if (saving.value) {
    return;
  }

  if (!title.value.trim() || !store.projects.some((project) => project.id === projectId.value)) {
    error.value = t('core.grigdeskRequiredFields');

    return;
  }

  saving.value = true;
  error.value = '';

  try {
    const task = await store.create({
      title: title.value.trim(),
      description: description.value,
      projectId: projectId.value,
      clientOrigin: location.origin,
    });

    emit('update:open', false);
    emit('created', task.id);
  } catch (failure) {
    error.value = failureText(failure);
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  try {
    await store.loadProjects();
  } catch (failure) {
    error.value = failureText(failure);
  }
});
</script>

<style scoped>
.new-task-form {
  display: grid;
  gap: 16px;
}
.err {
  color: var(--bad);
}
</style>
